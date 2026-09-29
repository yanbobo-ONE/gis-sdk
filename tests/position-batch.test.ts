import { describe, expect, it } from 'vitest';

import { normalizePositions } from '../src/core/position-batch.js';
import type { PositionSample } from '../src/core/position-batch.js';

const sample = (id: string, timestamp: number, longitude = 116, latitude = 39): PositionSample => ({
  id,
  longitude,
  latitude,
  timestamp,
});

describe('normalizePositions', () => {
  it('keeps the newest sample per id in latest mode and reports overwritten ones', () => {
    const batch = normalizePositions(
      [
        sample('a', 1_000, 1, 2),
        sample('a', 2_000, 3, 4),
        sample('a', 1_500, 5, 6),
        sample('b', 900, 7, 8),
      ],
      { mode: 'latest' },
    );

    expect(batch.received).toBe(4);
    expect(batch.invalid).toBe(2);
    expect(batch.ids).toEqual(['a', 'b']);
    expect([...batch.positions]).toEqual([3, 4, 0, 7, 8, 0]);
    expect([...batch.timestamps]).toEqual([2_000, 900]);
  });

  it('keeps every valid sample in history mode', () => {
    const batch = normalizePositions(
      [sample('a', 1_000), sample('a', 2_000), sample('b', 1_500, 10, 20)],
      { mode: 'history' },
    );

    expect(batch.invalid).toBe(0);
    expect(batch.ids).toEqual(['a', 'a', 'b']);
    expect([...batch.timestamps]).toEqual([1_000, 2_000, 1_500]);
  });

  it('drops invalid samples without failing the whole batch', () => {
    const batch = normalizePositions(
      [
        sample('', 1),
        { id: 'a', longitude: Number.NaN, latitude: 0, timestamp: 1 },
        { id: 'b', longitude: 181, latitude: 0, timestamp: 1 },
        { id: 'c', longitude: 0, latitude: -91, timestamp: 1 },
        { id: 'd', longitude: 0, latitude: 0, timestamp: Number.POSITIVE_INFINITY },
        sample('ok', 5),
      ],
      { mode: 'history' },
    );

    expect(batch.invalid).toBe(5);
    expect(batch.ids).toEqual(['ok']);
    expect(batch.received).toBe(6);
  });

  it('exposes transfer-friendly typed arrays with matching lengths', () => {
    const batch = normalizePositions([sample('a', 1, 10, 20), sample('b', 2, 30, 40)]);

    expect(batch.positions).toBeInstanceOf(Float64Array);
    expect(batch.timestamps).toBeInstanceOf(Float64Array);
    expect(batch.positions.length).toBe(batch.ids.length * 3);
    expect(batch.timestamps.length).toBe(batch.ids.length);
    // 两个缓冲区可以跨线程转移，不会复制整份数据。
    expect(batch.positions.buffer).toBeInstanceOf(ArrayBuffer);
    expect(batch.timestamps.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('respects the sample limit and rejects invalid configuration', () => {
    const samples = Array.from({ length: 5 }, (_value, index) =>
      sample(`p-${String(index)}`, index),
    );

    expect(normalizePositions(samples, { maxSamples: 5 }).received).toBe(5);
    expect(() => normalizePositions(samples, { maxSamples: 4 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => normalizePositions(samples, { mode: 'rolling' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => normalizePositions(samples, { maxSamples: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => normalizePositions('nope' as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
  });
});
