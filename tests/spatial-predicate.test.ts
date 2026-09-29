import { describe, expect, it } from 'vitest';

import {
  filterPointsInPolygon,
  isPointInPolygon,
  normalizeRingWinding,
} from '../src/spatial/predicate.js';
import { MAX_BATCH_POINTS } from '../src/spatial/types.js';
import type { GeoPolygon, GeoRing } from '../src/spatial/types.js';

const square: GeoRing = [
  { longitude: 0, latitude: 0 },
  { longitude: 2, latitude: 0 },
  { longitude: 2, latitude: 2 },
  { longitude: 0, latitude: 2 },
];

const hole: GeoRing = [
  { longitude: 0.5, latitude: 0.5 },
  { longitude: 1.5, latitude: 0.5 },
  { longitude: 1.5, latitude: 1.5 },
  { longitude: 0.5, latitude: 1.5 },
];

const donut: GeoPolygon = { outer: square, holes: [hole] };

/** 鞋带公式的有符号面积：正值为逆时针，负值为顺时针。 */
function signedArea(ring: GeoRing): number {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    if (current && next) {
      sum += current.longitude * next.latitude - next.longitude * current.latitude;
    }
  }
  return sum / 2;
}

describe('spatial predicate', () => {
  it('handles outer rings, holes, and boundary归属', () => {
    expect(isPointInPolygon({ longitude: 0.25, latitude: 0.25 }, donut)).toBe(true);
    expect(isPointInPolygon({ longitude: 1, latitude: 1 }, donut)).toBe(false);
    expect(isPointInPolygon({ longitude: 3, latitude: 1 }, donut)).toBe(false);

    // 默认边界点算命中；显式忽略边界时算未命中。
    expect(isPointInPolygon({ longitude: 0, latitude: 0 }, donut)).toBe(true);
    expect(isPointInPolygon({ longitude: 0, latitude: 0 }, donut, { ignoreBoundary: true })).toBe(
      false,
    );

    expect(() => isPointInPolygon({ longitude: 181, latitude: 0 }, donut)).toThrow(
      expect.objectContaining({ code: 'INVALID_COORDINATES' }),
    );
    expect(() =>
      isPointInPolygon(
        { longitude: 0, latitude: 0 },
        {
          outer: [
            { longitude: 0, latitude: 0 },
            { longitude: 1, latitude: 1 },
          ],
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
  });

  it('filters batches with a bounding box prefilter and reports indexes in order', () => {
    const result = filterPointsInPolygon(
      [
        { longitude: 0.25, latitude: 0.25 },
        { longitude: 50, latitude: 50 },
        { longitude: 1, latitude: 1 },
        { longitude: 1.9, latitude: 1.9 },
      ],
      donut,
    );

    expect(result.indexes).toEqual([0, 3]);
    expect(result.count).toBe(2);
    expect(result.points).toEqual([
      { longitude: 0.25, latitude: 0.25 },
      { longitude: 1.9, latitude: 1.9 },
    ]);
  });

  it('rejects batches above the documented limit', () => {
    const oversized = Array.from({ length: MAX_BATCH_POINTS + 1 }, () => ({
      longitude: 1,
      latitude: 1,
    }));
    expect(() => filterPointsInPolygon(oversized, donut)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => filterPointsInPolygon('nope' as never, donut)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });

  it('normalizes ring winding to the requested direction and closes the ring', () => {
    const counterclockwise = normalizeRingWinding(square, 'counterclockwise');
    const clockwise = normalizeRingWinding(square, 'clockwise');

    expect(signedArea(counterclockwise)).toBeGreaterThan(0);
    expect(signedArea(clockwise)).toBeLessThan(0);
    // 两种绕向的顶点集合相同，只是顺序相反。
    expect(Math.abs(signedArea(counterclockwise))).toBeCloseTo(Math.abs(signedArea(clockwise)), 10);
    expect(counterclockwise[0]).toEqual(counterclockwise[counterclockwise.length - 1]);

    expect(() => normalizeRingWinding(square, 'sideways' as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
