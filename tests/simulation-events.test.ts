import { describe, expect, it } from 'vitest';

import { GisError } from '../src/core/errors.js';
import { SimulationEventScheduler } from '../src/core/simulation-events.js';
import type { SimulationEvent } from '../src/core/simulation-events.js';

function event(
  id: string,
  timeSeconds: number,
  payload: { readonly value: number } = { value: 0 },
): SimulationEvent<{ readonly value: number }> {
  return { id, timeSeconds, type: 'alarm', payload };
}

describe('SimulationEventScheduler', () => {
  it('matches the reference behaviour: reschedule by id, both directions, cancel', () => {
    // 与参照实现（Plugin-web 的 SimulationEvents.test.ts）逐条对齐，锁住移植语义。
    const scheduler = new SimulationEventScheduler<{ readonly value: number }>();
    scheduler.add({ id: 'one', timeSeconds: 1, type: 'alarm', payload: { value: 1 } });
    scheduler.add({ id: 'two', timeSeconds: 3, type: 'alarm', payload: { value: 2 } });
    scheduler.add({ id: 'one', timeSeconds: 2, type: 'alarm', payload: { value: 3 } });

    expect(scheduler.between(0, 3).map((item) => item.id)).toEqual(['one', 'two']);
    expect(scheduler.between(3, 0, 'reverse').map((item) => item.timeSeconds)).toEqual([2]);
    expect(scheduler.remove('two')).toBe(true);
    expect(scheduler.count).toBe(1);
  });

  it('replaces the same id instead of keeping two entries', () => {
    const scheduler = new SimulationEventScheduler<{ readonly value: number }>();
    scheduler.add(event('alarm', 10, { value: 1 }));
    scheduler.add(event('alarm', 4, { value: 2 }));

    expect(scheduler.count).toBe(1);
    expect(scheduler.all()).toEqual([event('alarm', 4, { value: 2 })]);
  });

  it('keeps the forward window half-open on the start and closed on the end', () => {
    const scheduler = new SimulationEventScheduler();
    scheduler.add(event('a', 1));
    scheduler.add(event('b', 2));
    scheduler.add(event('c', 3));

    // 连续取帧：[0,1] 触发 a，[1,2] 触发 b……起点不重复触发、终点触发一次。
    expect(scheduler.between(0, 1).map((item) => item.id)).toEqual(['a']);
    expect(scheduler.between(1, 2).map((item) => item.id)).toEqual(['b']);
    expect(scheduler.between(2, 1).map((item) => item.id)).toEqual([]);
    expect(scheduler.between(0, 3).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('walks backwards in descending order for reverse playback', () => {
    const scheduler = new SimulationEventScheduler();
    scheduler.add(event('a', 1));
    scheduler.add(event('b', 2));
    scheduler.add(event('c', 3));

    // 反向区间是正向窗口在倒放方向上的镜像：[to, from)——高的一侧不重复触发，按倒序返回。
    expect(scheduler.between(3, 1, 'reverse').map((item) => item.id)).toEqual(['b', 'a']);
    expect(scheduler.between(2, 1, 'reverse').map((item) => item.id)).toEqual(['a']);
    expect(scheduler.between(1, 3, 'reverse')).toEqual([]);
  });

  it('returns copies so callers cannot mutate the schedule', () => {
    const scheduler = new SimulationEventScheduler();
    scheduler.add(event('a', 1));

    scheduler.all().push(event('b', 2));
    scheduler.between(0, 10).push(event('c', 3));

    expect(scheduler.count).toBe(1);
    expect(scheduler.all().map((item) => item.id)).toEqual(['a']);
  });

  it('clears every event and reports unknown ids without throwing', () => {
    const scheduler = new SimulationEventScheduler();
    scheduler.add(event('a', 1));
    scheduler.add(event('b', 2));

    expect(scheduler.remove('missing')).toBe(false);
    scheduler.clear();

    expect(scheduler.count).toBe(0);
    expect(scheduler.between(0, 10)).toEqual([]);
    expect(scheduler.remove('a')).toBe(false);
  });

  it('rejects invalid events and ranges with typed errors', () => {
    const scheduler = new SimulationEventScheduler();

    for (const invalid of [
      { id: '', timeSeconds: 1, type: 'alarm', payload: null },
      { id: 'a', timeSeconds: Number.NaN, type: 'alarm', payload: null },
      { id: 'a', timeSeconds: 1, type: '', payload: null },
      { id: 'a', timeSeconds: '1', type: 'alarm', payload: null },
    ]) {
      expect(() => {
        scheduler.add(invalid as never);
      }).toThrow(expect.objectContaining({ code: 'INVALID_SIMULATION_INPUT' }));
    }

    expect(() => scheduler.between(0, Number.POSITIVE_INFINITY)).toThrow(
      expect.objectContaining({ code: 'INVALID_SIMULATION_INPUT' }),
    );
    expect(() => scheduler.between(0, 1, 'sideways' as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_SIMULATION_INPUT' }),
    );
    expect(() => {
      scheduler.add(undefined as never);
    }).toThrow(GisError);
  });
});
