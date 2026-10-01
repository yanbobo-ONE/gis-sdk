import { describe, expect, it, vi } from 'vitest';

import { DataPipeline } from '../src/core/data-pipeline.js';
import { DataPipelineFrameScheduler } from '../src/core/data-pipeline-frame-scheduler.js';
import type { DataPipelineFrameClock } from '../src/core/data-pipeline-frame-scheduler.js';
import { RealtimeResyncController } from '../src/core/realtime-resync.js';
import { RealtimeSessionGate } from '../src/core/realtime-session-gate.js';
import { REALTIME_SOCKET_WILDCARD, RealtimeSocketClient } from '../src/core/realtime-socket.js';
import type { RealtimeSocketLike } from '../src/core/realtime-socket.js';
import { RealtimeWaterline } from '../src/core/realtime-waterline.js';

/**
 * 这份测试是[实时链路组装指南](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/realtime-cookbook.md)
 * 里那段装配代码的可执行版本：链路 → 会话门禁 → 水位线 → 缓冲 → 每帧有界消费 → 图层，
 * 用假时钟与假图层驱动，确保文档里的接法真的能跑，而不是"看起来对"。
 */

interface Frame {
  readonly sessionId: string;
  readonly kind: 'frame' | 'session-begin';
  readonly sequence: number;
  readonly objectId: string;
  readonly timeMs: number;
  readonly longitude: number;
  readonly latitude: number;
}

interface PointSpec {
  readonly id: string;
  readonly longitude: number;
  readonly latitude: number;
}

/** 手动驱动的帧时钟：测试自己决定什么时候"出帧"。 */
function createClock() {
  let handle = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const clock: DataPipelineFrameClock = {
    request: (callback) => {
      handle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel: (id) => {
      callbacks.delete(id);
    },
  };
  return {
    clock,
    /** 走一帧。 */
    frame(): number {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of pending) {
        callback(0);
      }
      return pending.length;
    },
    pending: () => callbacks.size,
  };
}

function createHarness(options: { maxItemsPerFrame?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const socket = new RealtimeSocketClient({
    url: 'wss://example.com/realtime',
    factory: () => {
      const fake = new FakeSocket();
      sockets.push(fake);
      return fake;
    },
    random: () => 0.5,
  });

  const gate = new RealtimeSessionGate<Frame>({
    sessionOf: (frame) => frame.sessionId,
    isBegin: (frame) => frame.kind === 'session-begin',
  });
  const waterline = new RealtimeWaterline<Frame>({
    keyBy: (frame) => frame.objectId,
    timeBy: (frame) => frame.timeMs,
    bufferMs: 1_500,
  });
  const pipeline = new DataPipeline<PointSpec>({ keyBy: (point) => point.id, maxQueueItems: 4096 });
  const layer = { setData: vi.fn<(points: readonly PointSpec[]) => void>() };
  const clock = createClock();
  const scheduler = new DataPipelineFrameScheduler<PointSpec>({
    pipeline,
    maxItemsPerFrame: options.maxItemsPerFrame ?? 2,
    onBatch: (batch) => {
      layer.setData(batch);
    },
    clock: clock.clock,
  });
  const resync = new RealtimeResyncController({ maxRequests: 3 });
  const requested: { tool: string; cursor: string | undefined }[] = [];

  // ── 装配：这就是文档里的接法 ────────────────────────────────────────────────
  socket.subscribe(REALTIME_SOCKET_WILDCARD, (message) => {
    const frame = message.payload as Frame;
    const decision = gate.evaluate(frame);
    if (!decision.accept) {
      // 控制消息（切换会话）或旧会话的迟到包。
      if (decision.switched) {
        waterline.reset();
        resync.reset();
      }
      return;
    }

    const before = resync.snapshot;
    const after = resync.acceptDelta(frame.sequence);
    if (after.state === 'waiting-snapshot') {
      // 断档：只在请求计数增加时真正发一次快照请求（窗口内的重复上报会被抑制），
      // 并且等快照期间不把增量喂进水位线——用不连续的数据画线比不画更糟。
      if (after.requests > before.requests) {
        const cursor = `seq:${String(before.acceptedSequence ?? 0)}`;
        socket.send({ type: 'snapshot', cursor });
        requested.push({ tool: 'snapshot', cursor });
      }
      return;
    }

    // 水位线**返回**此刻可以安全播放的样本（回调只用于"拒绝"，不用于接收）。
    const released = waterline.push([frame]);
    for (const sample of released) {
      pipeline.push({
        id: sample.objectId,
        longitude: sample.longitude,
        latitude: sample.latitude,
      });
    }
    if (released.length > 0) {
      scheduler.request();
    }
  });

  return {
    socket,
    sockets,
    gate,
    waterline,
    pipeline,
    layer,
    scheduler,
    resync,
    clock,
    requested,
  };
}

class FakeSocket implements RealtimeSocketLike {
  readyState = 0;
  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;

  send(): void {
    // 只接收，不发送。
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** 投递一帧：按链路的默认解码约定包成 `{ type, payload }`。 */
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'frame', payload }) });
  }
}

const frame = (overrides: Partial<Frame> = {}): Frame => ({
  sessionId: 'session-1',
  kind: 'frame',
  sequence: 1,
  objectId: 'track-1',
  timeMs: 1_000,
  longitude: 116.39,
  latitude: 39.9,
  ...overrides,
});

describe('realtime cookbook assembly', () => {
  it('carries frames from the socket to the layer through gate, waterline, pipeline and scheduler', () => {
    const harness = createHarness({ maxItemsPerFrame: 2 });
    harness.socket.connect();
    harness.sockets[0]?.open();
    harness.resync.acceptDelta(0);

    // 第一条：水位线还没到安全播放上限，什么都不该交付。
    harness.sockets[0]?.deliver(frame({ sequence: 1, timeMs: 1_000 }));
    expect(harness.waterline.snapshot.watermark).toBe(-500);
    expect(harness.waterline.snapshot.queuedSamples).toBe(1);

    // 第二条把水位线推到 2000ms：第一条（1000ms）可以安全播放，进入管线缓冲。
    harness.sockets[0]?.deliver(frame({ sequence: 2, timeMs: 3_500, longitude: 1 }));
    expect(harness.waterline.snapshot.watermark).toBe(2_000);
    expect(harness.pipeline.stats.queued).toBe(1);
    expect(harness.layer.setData).not.toHaveBeenCalled();

    // 再来四条：水位线 = 最新样本时间 - 缓冲 = 6000 - 1500 = 4500ms，
    // 因此 1000 / 3500 / 4000 / 4200 四条都可以安全播放，5000 与 6000 仍在等。
    harness.sockets[0]?.deliver(frame({ objectId: 'track-2', sequence: 3, timeMs: 4_000 }));
    harness.sockets[0]?.deliver(frame({ objectId: 'track-3', sequence: 4, timeMs: 4_200 }));
    harness.sockets[0]?.deliver(frame({ sequence: 5, timeMs: 5_000 }));
    harness.sockets[0]?.deliver(frame({ objectId: 'track-2', sequence: 6, timeMs: 6_000 }));
    expect(harness.waterline.snapshot.watermark).toBe(4_500);
    expect(harness.waterline.snapshot.queuedSamples).toBe(2);
    // 管线按对象键合并：track-1 释放了两条，队列里只留最新的那条。
    expect(harness.pipeline.stats.queued).toBe(3);
    expect(harness.pipeline.stats.coalesced).toBe(1);

    // 每帧最多交付 2 条，因此两帧才能清空。
    harness.clock.frame();
    expect(harness.layer.setData).toHaveBeenCalledTimes(1);
    expect(harness.layer.setData.mock.calls[0]?.[0]).toHaveLength(2);
    expect(harness.pipeline.stats.queued).toBe(1);

    harness.clock.frame();
    expect(harness.layer.setData).toHaveBeenCalledTimes(2);
    expect(harness.layer.setData.mock.calls[1]?.[0]).toHaveLength(1);
    expect(harness.pipeline.stats.queued).toBe(0);

    harness.scheduler.dispose();
    harness.socket.dispose();
  });

  it('drops frames from a stale session and resets the buffer on switch', () => {
    const harness = createHarness();
    harness.socket.connect();
    harness.sockets[0]?.open();
    harness.resync.acceptDelta(0);

    harness.sockets[0]?.deliver(frame({ sequence: 1, timeMs: 1_000 }));
    expect(harness.waterline.snapshot.queuedSamples).toBe(1);

    // 新会话开始：门禁切换会话，积压被清空。
    harness.sockets[0]?.deliver(
      frame({ sessionId: 'session-2', kind: 'session-begin', sequence: 0 }),
    );
    expect(harness.gate.sessionId).toBe('session-2');
    expect(harness.waterline.snapshot.queuedSamples).toBe(0);

    // 旧会话的迟到包被丢弃。
    harness.sockets[0]?.deliver(frame({ sessionId: 'session-1', sequence: 2, timeMs: 9_000 }));
    expect(harness.waterline.snapshot.queuedSamples).toBe(0);

    // 新会话的包正常进入。
    harness.sockets[0]?.deliver(frame({ sessionId: 'session-2', sequence: 1, timeMs: 1_000 }));
    expect(harness.waterline.snapshot.queuedSamples).toBe(1);
  });

  it('asks for a snapshot on a sequence jump and resumes after it arrives', () => {
    const harness = createHarness();
    harness.socket.connect();
    harness.sockets[0]?.open();
    harness.resync.acceptDelta(0);

    // 序列从 1 跳到 5：断档，发一次快照请求，并且不把这帧喂进水位线。
    harness.sockets[0]?.deliver(frame({ sequence: 5, timeMs: 1_000 }));

    expect(harness.requested).toEqual([{ tool: 'snapshot', cursor: 'seq:0' }]);
    expect(harness.resync.snapshot.state).toBe('waiting-snapshot');
    expect(harness.waterline.snapshot.queuedSamples).toBe(0);

    // 等待窗口内重复上报同一断档：只记抑制，不再发请求。
    harness.sockets[0]?.deliver(frame({ sequence: 6, timeMs: 2_000 }));
    expect(harness.requested).toHaveLength(1);
    expect(harness.resync.snapshot.suppressedRequests).toBeGreaterThan(0);

    // 快照补齐到 5，之后从 6 继续；数据重新进入水位线。
    harness.resync.acceptSnapshot(5);
    harness.sockets[0]?.deliver(frame({ sequence: 6, timeMs: 3_000 }));
    expect(harness.resync.snapshot.state).toBe('synchronized');
    expect(harness.waterline.snapshot.queuedSamples).toBe(1);

    harness.scheduler.dispose();
    harness.socket.dispose();
  });

  it('reconnects the link and keeps delivering frames afterwards', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.socket.connect();
      const first = harness.sockets[0];
      if (!first) {
        throw new Error('socket missing');
      }
      first.open();
      harness.resync.acceptDelta(0);
      first.deliver(frame({ sequence: 1, timeMs: 1_000 }));

      // 链路断开：状态进入 reconnecting，退避后自动建新连接。
      first.readyState = 3;
      first.onerror?.();
      expect(harness.socket.state).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.sockets).toHaveLength(2);

      // 新连接上继续投递，数据照常进入缓冲。
      const second = harness.sockets[1];
      second?.open();
      second?.deliver(frame({ sequence: 2, timeMs: 3_000, longitude: 117 }));
      expect(harness.waterline.snapshot.queuedSamples).toBe(1);
      expect(harness.socket.state).toBe('open');

      harness.scheduler.dispose();
      harness.socket.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
