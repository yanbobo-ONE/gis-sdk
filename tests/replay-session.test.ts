import { describe, expect, it, vi } from 'vitest';

import { ReplaySession } from '../src/core/replay-session.js';
import type { ReplaySessionSnapshot } from '../src/core/replay-session.js';
import { ReplayTimeline } from '../src/core/replay-timeline.js';
import { SimulationClock } from '../src/core/simulation-clock.js';

interface Sample {
  readonly time: number;
  readonly x: number;
}

const interpolate = (previous: Sample, next: Sample, ratio: number): Sample => ({
  time: previous.time + (next.time - previous.time) * ratio,
  x: previous.x + (next.x - previous.x) * ratio,
});

/** 时间轴用**秒**：a 走 0→100，b 只有一个采样点。 */
function createTimeline(): ReplayTimeline<Sample> {
  const timeline = new ReplayTimeline<Sample>({ interpolate });
  timeline.addSample('a', { time: 0, x: 0 });
  timeline.addSample('a', { time: 10, x: 100 });
  timeline.addSample('b', { time: 0, x: 5 });
  return timeline;
}

function createRecorder() {
  const snapshots: ReplaySessionSnapshot<Sample>[] = [];
  const signals: AbortSignal[] = [];
  const apply = vi.fn((snapshot: ReplaySessionSnapshot<Sample>, signal: AbortSignal) => {
    snapshots.push(snapshot);
    signals.push(signal);
  });
  return { apply, snapshots, signals };
}

describe('ReplaySession', () => {
  it('drives snapshots from the clock and converts milliseconds to timeline seconds', async () => {
    const timeline = createTimeline();
    const recorder = createRecorder();
    const session = new ReplaySession<Sample>({ timeline, apply: recorder.apply });

    // 会话自己建的时钟按时间轴范围（秒 → 毫秒）初始化。
    expect(session.clock.snapshot.startTime).toBe(0);
    expect(session.clock.snapshot.endTime).toBe(10_000);
    expect(session.status).toMatchObject({ time: 0, state: 'idle', rate: 1, direction: 1 });

    await session.seek(5_000);

    expect(recorder.snapshots).toHaveLength(1);
    const snapshot = recorder.snapshots[0];
    expect(snapshot?.time).toBe(5_000);
    expect(snapshot?.timelineTime).toBe(5);
    // 插值在时间轴里做：5 秒处 a 的 x 正好是 50。
    expect(snapshot?.samples.a).toEqual({ time: 5, x: 50 });
    // b 只有一个采样点：时间轴默认不外推，5 秒处解析不到样本，因此不出现在快照里。
    expect(snapshot?.samples.b).toBeUndefined();
    expect(session.lastApplied).toBe(snapshot);

    // 回到 0 秒：两个对象都有样本。
    await session.seek(0);
    expect(recorder.snapshots.at(-1)?.samples.b).toEqual({ time: 0, x: 5 });

    session.dispose();
  });

  it('applies the latest snapshot when several seeks are queued', async () => {
    const timeline = createTimeline();
    const recorder = createRecorder();
    const session = new ReplaySession<Sample>({ timeline, apply: recorder.apply });

    // 连跳三次：只有最后一次该提交，前两次直接丢弃。
    void session.seek(1_000);
    void session.seek(2_000);
    const last = session.seek(3_000);
    await last;

    expect(recorder.snapshots).toHaveLength(1);
    expect(recorder.snapshots[0]?.time).toBe(3_000);

    session.dispose();
  });

  it('applies snapshots when the clock is advanced outside the session', async () => {
    const timeline = createTimeline();
    const recorder = createRecorder();
    const session = new ReplaySession<Sample>({ timeline, apply: recorder.apply });

    // 业务按帧推进（等价于 map.clock.bind(session.clock) 的路径），会话照样提交。
    session.clock.play();
    session.clock.advance(16);
    await session.flush();

    expect(recorder.snapshots.at(-1)?.time).toBe(16);

    session.dispose();
  });

  it('does not apply while the clock has no time base', async () => {
    const timeline = createTimeline();
    const recorder = createRecorder();
    const clock = new SimulationClock();
    const session = new ReplaySession<Sample>({ timeline, apply: recorder.apply, clock });

    await session.play();
    session.clock.advance(16);
    await session.flush();

    // 还没 seek 过：不提交、也不报错——与 map.clock.bind 的处理一致。
    expect(recorder.apply).not.toHaveBeenCalled();

    await session.seek(1_000);
    expect(recorder.snapshots).toHaveLength(1);

    session.dispose();
  });

  it('stops at the timeline start and steps without changing play state', async () => {
    const timeline = createTimeline();
    const recorder = createRecorder();
    const session = new ReplaySession<Sample>({ timeline, apply: recorder.apply });

    await session.seek(6_000);
    await session.step(1_000);
    expect(recorder.snapshots.at(-1)?.time).toBe(7_000);
    expect(session.clock.snapshot.state).not.toBe('playing');

    await session.stop();
    expect(recorder.snapshots.at(-1)?.time).toBe(0);
    expect(session.clock.snapshot.state).toBe('paused');

    // 负数步长是调用错误，明确抛错。
    expect(() => session.step(-1)).toThrow(
      expect.objectContaining({ code: 'INVALID_REPLAY_INPUT', module: 'playback' }),
    );

    session.dispose();
  });

  it('reports apply failures without interrupting the clock', async () => {
    const timeline = createTimeline();
    const reported: { code: string }[] = [];
    const failure = new Error('write failed');
    const apply = vi.fn((): void => {
      throw failure;
    });
    const session = new ReplaySession<Sample>({
      timeline,
      apply,
      onError: (error) => reported.push({ code: error.code }),
    });

    await expect(session.seek(1_000)).rejects.toMatchObject({
      code: 'REPLAY_APPLY_FAILED',
      module: 'playback',
      cause: failure,
    });
    expect(session.errorCount).toBe(1);
    expect(reported).toEqual([{ code: 'REPLAY_APPLY_FAILED' }]);

    // 失败不冻结会话：下一次提交照常执行。
    apply.mockImplementation(() => undefined);
    await session.seek(2_000);
    expect(session.errorCount).toBe(1);

    session.dispose();
  });

  it('releases the clock, aborts in-flight applies, and rejects further calls', async () => {
    const timeline = createTimeline();
    const recorder = createRecorder();
    const session = new ReplaySession<Sample>({ timeline, apply: recorder.apply });

    await session.seek(1_000);
    expect(recorder.signals[0]?.aborted).toBe(false);

    session.dispose();
    session.dispose(); // 幂等

    expect(recorder.signals[0]?.aborted).toBe(true);
    expect(session.clock.snapshot.state).toBe('paused');
    expect(() => session.seek(2_000)).toThrow(
      expect.objectContaining({ code: 'REPLAY_SESSION_DISPOSED', module: 'playback' }),
    );
    expect(() => session.exportRange(0, 1_000)).toThrow(
      expect.objectContaining({ code: 'REPLAY_SESSION_DISPOSED' }),
    );
  });

  it('replaces the timeline on load and only moves clocks it owns', async () => {
    const timeline = createTimeline();
    const recorder = createRecorder();
    const session = new ReplaySession<Sample>({ timeline, apply: recorder.apply });

    const next = new ReplayTimeline<Sample>({ interpolate });
    next.addSample('c', { time: 20, x: 7 });
    next.addSample('c', { time: 40, x: 9 });

    await session.load(next);
    // 自有时钟跟着换成新时间轴的范围（秒 → 毫秒）。
    expect(session.timeline).toBe(next);
    expect(session.clock.snapshot.startTime).toBe(20_000);
    expect(session.clock.snapshot.endTime).toBe(40_000);

    await session.seek(30_000);
    expect(recorder.snapshots.at(-1)?.samples.c).toEqual({ time: 30, x: 8 });

    // 业务传入的时钟是业务的状态：换时间轴不动它。
    const owned = new SimulationClock({ startTime: 0, endTime: 60_000, initialTime: 0 });
    const external = new ReplaySession<Sample>({ timeline, apply: recorder.apply, clock: owned });
    const other = new ReplayTimeline<Sample>();
    other.addSample('d', { time: 100, x: 1 });
    await external.load(other);
    expect(owned.snapshot.endTime).toBe(60_000);

    session.dispose();
    external.dispose();
  });

  it('exports samples per key within a range and rejects invalid ranges', () => {
    const timeline = createTimeline();
    const recorder = createRecorder();
    const session = new ReplaySession<Sample>({ timeline, apply: recorder.apply });

    const exported = session.exportRange(0, 10_000);

    expect(exported.startTime).toBe(0);
    expect(exported.endTime).toBe(10_000);
    // 范围按毫秒给、样本按时间轴原始单位（秒）返回。
    expect(exported.samples.a).toEqual([
      { time: 0, x: 0 },
      { time: 10, x: 100 },
    ]);
    expect(exported.samples.b).toEqual([{ time: 0, x: 5 }]);
    expect(Object.isFrozen(exported.samples)).toBe(true);
    expect(Object.isFrozen(exported.samples.a)).toBe(true);

    // 范围里没有采样点的对象不出现在导出结果里；a 的两个采样点都在 2 秒之前或 8 秒之后。
    const narrow = session.exportRange(2_000, 8_000);
    expect(narrow.samples.a).toBeUndefined();
    expect(narrow.samples.b).toBeUndefined();

    expect(() => session.exportRange(Number.NaN, 1_000)).toThrow(
      expect.objectContaining({ code: 'INVALID_REPLAY_INPUT', operation: 'exportRange' }),
    );

    session.dispose();
  });

  it('rejects construction without a timeline, without an apply, or with an empty timeline', () => {
    const timeline = createTimeline();
    const recorder = createRecorder();

    expect(() => new ReplaySession<Sample>({ timeline } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_REPLAY_INPUT', operation: 'create' }),
    );
    expect(() => new ReplaySession<Sample>({ apply: recorder.apply } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_REPLAY_INPUT', operation: 'create' }),
    );
    // 自有时钟需要时间轴范围；空时间轴给不出范围，直接拒。
    expect(
      () => new ReplaySession<Sample>({ timeline: new ReplayTimeline<Sample>(), ...recorder }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REPLAY_INPUT', operation: 'create' }));
  });
});
