import { describe, expect, it } from 'vitest';

import { SimulationClock } from '../src/core/simulation-clock.js';
import type { SimulationClockSnapshot } from '../src/core/simulation-clock.js';

describe('SimulationClock', () => {
  it('starts idle and plays forward with rate and direction', () => {
    const clock = new SimulationClock({ startTime: 0, endTime: 10_000, initialTime: 0 });

    expect(clock.snapshot).toMatchObject({
      state: 'idle',
      currentTime: 0,
      rate: 1,
      direction: 1,
      mode: 'demo',
    });
    // 未播放时不推进。
    expect(clock.advance(1_000).currentTime).toBe(0);

    clock.play();
    expect(clock.advance(1_000).currentTime).toBe(1_000);

    clock.setRate(2);
    expect(clock.advance(500).currentTime).toBe(2_000);

    clock.setDirection(-1);
    expect(clock.advance(500).currentTime).toBe(1_000);
    expect(clock.snapshot.direction).toBe(-1);
  });

  it('ends at the boundary, rewinds on play, and seeks within range', () => {
    const clock = new SimulationClock({ startTime: 0, endTime: 5_000, initialTime: 0 });
    clock.play();

    expect(clock.advance(5_000).state).toBe('ended');
    expect(clock.snapshot.currentTime).toBe(5_000);

    // 结束后再次播放：回到起点重新开始。
    expect(clock.play()).toMatchObject({ state: 'playing', currentTime: 0 });

    // seek 会进入暂停（或结束）。
    expect(clock.seek(2_000)).toMatchObject({ state: 'paused', currentTime: 2_000 });
    expect(clock.seek(99_999)).toMatchObject({ state: 'ended', currentTime: 5_000 });
    expect(clock.seek(-500)).toMatchObject({ state: 'paused', currentTime: 0 });

    // step 不改变播放状态。
    clock.play();
    const stepped = clock.step(1_000);
    expect(stepped.state).toBe('playing');
    expect(stepped.currentTime).toBe(1_000);
  });

  it('limits the realtime cursor by the watermark and ignores stale watermarks', () => {
    const clock = new SimulationClock({
      mode: 'realtime',
      startTime: 0,
      endTime: 60_000,
      initialTime: 0,
    });
    clock.play();

    // 没有水位线时自由推进。
    expect(clock.advance(10_000).currentTime).toBe(10_000);

    // 水位线把游标限制在安全上限内。
    clock.setWatermark(12_000);
    expect(clock.advance(10_000).currentTime).toBe(12_000);

    // 迟到的水位线（更早）被忽略：不会让游标倒退。
    expect(clock.setWatermark(5_000).watermark).toBe(12_000);
    expect(clock.currentTime).toBe(12_000);

    // 当前时间超前于新水位线时会被拉回。
    clock.seek(20_000);
    expect(clock.setWatermark(15_000).currentTime).toBe(15_000);

    // 清除水位线后恢复自由推进（seek 之后处于暂停，需要先恢复播放）。
    clock.setWatermark();
    clock.play();
    expect(clock.advance(1_000).currentTime).toBe(16_000);
  });

  it('reports stalled state with a reason and recovers on play', () => {
    const clock = new SimulationClock({
      mode: 'realtime',
      startTime: 0,
      endTime: 60_000,
      initialTime: 0,
    });
    clock.play();
    clock.stall('transport-disconnected');

    expect(clock.snapshot).toMatchObject({
      state: 'stalled',
      reason: 'transport-disconnected',
    });
    // 停滞时 advance 不推进。
    expect(clock.advance(1_000).currentTime).toBe(0);

    expect(clock.play()).toMatchObject({ state: 'playing', reason: undefined });
  });

  it('notifies subscribers and keeps emitting after listener failures', () => {
    const clock = new SimulationClock({ startTime: 0, endTime: 10_000, initialTime: 0 });
    const seen: SimulationClockSnapshot[] = [];
    const off = clock.subscribe((snapshot) => seen.push(snapshot));
    clock.subscribe(() => {
      throw new Error('listener failed');
    });

    clock.play();
    clock.advance(1_000);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)).toMatchObject({ state: 'playing', currentTime: 1_000 });

    off();
    const count = seen.length;
    clock.advance(1_000);
    expect(seen).toHaveLength(count);
  });

  it('resets in place so existing subscriptions keep following the same clock', () => {
    const clock = new SimulationClock({ startTime: 0, endTime: 10_000, initialTime: 0 });
    const seen: SimulationClockSnapshot[] = [];
    clock.subscribe((snapshot) => seen.push(snapshot));

    clock.reset({ mode: 'replay', startTime: 100_000, endTime: 200_000, initialTime: 120_000 });

    expect(clock.snapshot).toMatchObject({
      mode: 'replay',
      startTime: 100_000,
      endTime: 200_000,
      currentTime: 120_000,
      watermark: undefined,
    });
    expect(seen.length).toBe(1);
    expect(clock.seek(150_000).currentTime).toBe(150_000);
  });

  it('rejects invalid configuration and time values', () => {
    expect(() => new SimulationClock({ startTime: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT', module: 'playback' }),
    );
    expect(() => new SimulationClock({ startTime: 10, endTime: 5 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => new SimulationClock({ rate: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => new SimulationClock({ direction: 2 as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => new SimulationClock({ mode: 'live' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );

    const clock = new SimulationClock({ startTime: 0, endTime: 1_000, initialTime: 0 });
    expect(() => clock.seek(Number.NaN)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => clock.advance(-1)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => clock.step(Number.POSITIVE_INFINITY)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => clock.setRate(-1)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => clock.setWatermark(Number.NaN)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
  });
});
