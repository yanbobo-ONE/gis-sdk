import { describe, expect, it } from 'vitest';

import { RealtimeTimestampGuard } from '../src/core/realtime-timestamp-guard.js';
import { RealtimeWaterline } from '../src/core/realtime-waterline.js';

interface Sample {
  readonly id: string;
  readonly timestamp?: number;
  readonly exact?: boolean;
}

/** 受控时钟。 */
function createClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RealtimeTimestampGuard', () => {
  it('passes through samples without timestamps and isolates non-finite ones', () => {
    const guard = new RealtimeTimestampGuard();
    expect(guard.accept('a', undefined, 0)).toBe(true);
    expect(guard.accept('a', Number.NaN, 0)).toBe(false);
    expect(guard.isolatedSamples).toBe(1);
  });

  it('isolates a far-future jump until it repeats as consecutive increases', () => {
    const guard = new RealtimeTimestampGuard({ maxLeadMs: 30_000, gapMs: 3_000 });
    // 建立基准：接收时间 0、仿真时间 1000。
    expect(guard.accept('a', 1_000, 0)).toBe(true);

    // 跳跃 60 秒：超过 maxLeadMs，被隔离。
    expect(guard.accept('a', 61_000, 100)).toBe(false);
    expect(guard.isolatedSamples).toBe(1);
    expect(guard.candidateCount).toBe(1);

    // 连续递增两次后确认，接受为新时间窗口。
    expect(guard.accept('a', 61_100, 200)).toBe(false);
    expect(guard.accept('a', 61_200, 300)).toBe(true);
    expect(guard.candidateCount).toBe(0);

    // 新窗口内的正常前进不再被隔离。
    expect(guard.accept('a', 61_300, 400)).toBe(true);
  });

  it('keeps the isolated counter and clears candidates on remove and reset', () => {
    const guard = new RealtimeTimestampGuard({ maxLeadMs: 1_000 });
    guard.accept('a', 1_000, 0);
    guard.accept('a', 10_000, 10);
    expect(guard.isolatedSamples).toBe(1);

    guard.remove('a');
    expect(guard.candidateCount).toBe(0);

    guard.reset();
    expect(guard.isolatedSamples).toBe(0);
    expect(guard.candidateCount).toBe(0);
  });

  it('rejects invalid configuration', () => {
    expect(() => new RealtimeTimestampGuard({ maxLeadMs: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_CONFIG' }),
    );
    expect(() => new RealtimeTimestampGuard({ maxCandidates: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_CONFIG' }),
    );
  });
});

describe('RealtimeWaterline', () => {
  const keyOptions = (clock: ReturnType<typeof createClock>) => ({
    keyBy: (value: Sample) => value.id,
    timeBy: (value: Sample) => value.timestamp,
    bufferMs: 1_000,
    now: clock.now,
  });

  const options = (clock: ReturnType<typeof createClock>) => ({
    keyBy: (value: Sample) => value.id,
    timeBy: (value: Sample) => value.timestamp,
    exactBy: (value: Sample) => value.exact === true,
    bufferMs: 1_000,
    now: clock.now,
  });

  it('releases the newest sample under the watermark and keeps the rest queued', () => {
    const clock = createClock();
    const waterline = new RealtimeWaterline<Sample>(options(clock));

    // 无时间戳样本立即返回。
    expect(waterline.push([{ id: 'a' }])).toEqual([{ id: 'a' }]);

    // 水位线 = 最新时间 − 缓冲：5000 − 1000 = 4000。乱序输入按时间排序后，
    // 只发布"不晚于水位线的最新一条"，中间样本不再补发（避免渲染已经过时的位置）。
    const released = waterline.push([
      { id: 'a', timestamp: 5_000 },
      { id: 'a', timestamp: 4_000 },
      { id: 'a', timestamp: 3_000 },
    ]);
    expect(released).toEqual([{ id: 'a', timestamp: 4_000 }]);
    expect(waterline.watermark).toBe(4_000);
    expect(waterline.snapshot.queuedSamples).toBe(1);
    expect(waterline.snapshot.lastReleasedTimestamp).toBe(4_000);

    // 水位线推进后释放剩余样本。
    expect(waterline.push([{ id: 'a', timestamp: 6_000 }])).toEqual([
      { id: 'a', timestamp: 5_000 },
    ]);
    expect(waterline.snapshot.lastReleasedTimestamp).toBe(5_000);
  });

  it('uses the oldest exact sample to bound the safe watermark', () => {
    const clock = createClock();
    const waterline = new RealtimeWaterline<Sample>(options(clock));

    waterline.push([
      { id: 'exact-1', timestamp: 4_000, exact: true },
      { id: 'exact-2', timestamp: 6_000, exact: true },
      { id: 'plain', timestamp: 9_000 },
    ]);

    // 精确对象共同覆盖：取最小的最新时间 4000，再回退缓冲。
    expect(waterline.watermark).toBe(3_000);
    expect(waterline.push([{ id: 'plain', timestamp: 9_500 }])).toEqual([]);

    // 精确对象失活后回退到全局最新时间。
    clock.advance(10_001);
    expect(waterline.snapshot.staleExactKeys).toBe(2);
    expect(waterline.watermark).toBe(8_500);
  });

  it('trims queues by count and by time window', () => {
    const clock = createClock();
    const waterline = new RealtimeWaterline<Sample>({
      ...options(clock),
      // 缓冲远大于样本时间，队列不会被立即释放，便于观察裁剪统计。
      bufferMs: 100_000,
      maxSamplesPerKey: 3,
      sampleWindowMs: 10_000,
    });

    waterline.push([
      { id: 'a', timestamp: 1_000 },
      { id: 'a', timestamp: 2_000 },
      { id: 'a', timestamp: 3_000 },
      { id: 'a', timestamp: 4_000 },
    ]);
    // 单对象上限 3：先按数量裁掉最旧的一条。
    expect(waterline.snapshot.droppedOverflowSamples).toBe(1);

    waterline.push([{ id: 'a', timestamp: 30_000 }]);
    // 时间窗口 10 秒：最新为 30000，2000 之前的样本被裁剪。
    expect(waterline.snapshot.droppedWindowSamples).toBeGreaterThan(0);
    expect(waterline.snapshot.queuedSamples).toBeLessThanOrEqual(3);
  });

  it('drops samples that never crossed the watermark in time', () => {
    const clock = createClock();
    const waterline = new RealtimeWaterline<Sample>({
      ...keyOptions(clock),
      bufferMs: 5_000,
      staleMs: 1_000,
    });

    // 水位线 = 30000 − 5000 = 25000；1 秒过期窗口之外的旧样本直接丢弃。
    const released = waterline.push([
      { id: 'fresh', timestamp: 30_000 },
      { id: 'old', timestamp: 1_000 },
    ]);
    expect(released).toEqual([]);
    expect(waterline.snapshot.droppedStaleSamples).toBe(1);
    expect(waterline.snapshot.queuedSamples).toBe(1);
  });

  it('enters and exits catch-up with hysteresis and caps the rate', () => {
    const clock = createClock();
    const waterline = new RealtimeWaterline<Sample>({
      ...options(clock),
      bufferMs: 1_000,
      catchUpEnterLagMs: 2_000,
      catchUpExitLagMs: 1_000,
      maxCatchUpRate: 2.4,
    });

    // 先用正常样本建立发布基准（水位线紧随其后，不进入追赶）。
    expect(
      waterline.push([
        { id: 'a', timestamp: 1_000 },
        { id: 'a', timestamp: 2_500 },
      ]),
    ).toEqual([{ id: 'a', timestamp: 1_000 }]);
    expect(waterline.currentCatchUpRate).toBe(1);

    // 断流后收到明显超前的样本：水位线到 6000，滞后 5 秒 → 进入追赶。
    // 跳变幅度保持在 maxFutureLeadMs（默认 30 秒）以内，避免被时间戳守卫隔离。
    // 水位线推进到 5000：先补发队列里的 2500，滞后 2500ms → 进入追赶。
    expect(waterline.push([{ id: 'a', timestamp: 6_000 }])).toEqual([
      { id: 'a', timestamp: 2_500 },
    ]);
    expect(waterline.watermark).toBe(5_000);
    expect(waterline.currentCatchUpRate).toBe(2.4);
    expect(waterline.snapshot.reason).toBe('release-lag');
    // 追赶时缩短插值时长，但不会低于 80ms。
    expect(waterline.smoothDurationMs(500)).toBe(208);
    expect(waterline.smoothDurationMs(50)).toBe(80);

    // 追赶倍率在"发布之前"评估，因此滞后降到退出阈值后才恢复 1：先补发 6000。
    expect(waterline.push([{ id: 'a', timestamp: 7_000 }])).toEqual([
      { id: 'a', timestamp: 6_000 },
    ]);
    expect(waterline.currentCatchUpRate).toBe(2.4);

    // 再补发一条，滞后降到退出阈值（1000ms）以内 → 退出追赶。
    expect(waterline.push([{ id: 'a', timestamp: 8_000 }])).toEqual([
      { id: 'a', timestamp: 7_000 },
    ]);
    expect(waterline.currentCatchUpRate).toBe(1);
    expect(waterline.smoothDurationMs(500)).toBe(500);
  });

  it('reports buffering, playing, stalled, and disconnected states', () => {
    const clock = createClock();
    const waterline = new RealtimeWaterline<Sample>({ ...options(clock), gapMs: 3_000 });

    expect(waterline.snapshot.state).toBe('buffering');
    expect(waterline.snapshot.reason).toBe('waiting-samples');

    // 一次送入两条才能越线发布，进入 playing。
    waterline.push([
      { id: 'a', timestamp: 1_000 },
      { id: 'a', timestamp: 5_000 },
    ]);
    expect(waterline.snapshot.state).toBe('playing');
    expect(waterline.snapshot.reason).toBe('safe-window-ready');

    clock.advance(3_000);
    expect(waterline.snapshot.state).toBe('stalled');
    expect(waterline.snapshot.reason).toBe('sample-timeout');
    expect(waterline.snapshot.gapDurationMs).toBe(3_000);

    waterline.markDisconnected();
    expect(waterline.snapshot.state).toBe('disconnected');
    expect(waterline.snapshot.reason).toBe('transport-disconnected');

    // 新样本重新建立连接状态。
    waterline.push([
      { id: 'a', timestamp: 9_000 },
      { id: 'a', timestamp: 12_000 },
    ]);
    expect(waterline.snapshot.state).toBe('playing');
  });

  it('supports rejecting samples, dropping keys, and resetting', () => {
    const clock = createClock();
    const waterline = new RealtimeWaterline<Sample>({ ...keyOptions(clock), bufferMs: 0 });

    const accepted = waterline.push(
      [
        { id: 'a', timestamp: 5_000 },
        { id: 'b', timestamp: 5_000 },
      ],
      (value) => value.id !== 'b',
    );
    expect(accepted).toEqual([{ id: 'a', timestamp: 5_000 }]);
    expect(waterline.snapshot.queuedSamples).toBe(0);

    waterline.push([{ id: 'c', timestamp: 5_000 }]);
    waterline.remove(['c']);
    expect(waterline.snapshot.queuedSamples).toBe(0);

    waterline.markDisconnected();
    waterline.reset();
    const snapshot = waterline.snapshot;
    expect(snapshot.state).toBe('buffering');
    expect(snapshot.watermark).toBeUndefined();
    expect(snapshot.isolatedFutureSamples).toBe(0);
    expect(snapshot.droppedStaleSamples).toBe(0);
  });

  it('rejects invalid configuration and out-of-order thresholds', () => {
    const clock = createClock();
    expect(
      () =>
        new RealtimeWaterline<Sample>({
          keyBy: (value: Sample) => value.id,
          timeBy: (value: Sample) => value.timestamp,
          catchUpEnterLagMs: 100,
          catchUpExitLagMs: 200,
        }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REALTIME_CONFIG' }));
    expect(() => new RealtimeWaterline<Sample>({ ...options(clock), bufferMs: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_CONFIG' }),
    );
    expect(
      () =>
        new RealtimeWaterline<Sample>({ keyBy: undefined as never, timeBy: undefined as never }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REALTIME_CONFIG' }));
  });
});
