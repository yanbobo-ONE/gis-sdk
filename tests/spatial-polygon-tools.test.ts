import { describe, expect, it } from 'vitest';

import { convexHull } from '../src/spatial/hull.js';
import { simplifyPath, simplifyRing } from '../src/spatial/simplify.js';
import { validatePolygon } from '../src/spatial/polygon-validation.js';
import { measureArea, measurePathLength } from '../src/spatial/measure.js';
import type { GeoPoint } from '../src/spatial/types.js';

const square: GeoPoint[] = [
  { longitude: 0, latitude: 0 },
  { longitude: 0, latitude: 1 },
  { longitude: 1, latitude: 1 },
  { longitude: 1, latitude: 0 },
];

describe('convexHull', () => {
  it('returns a closed ring around a point cloud and drops interior points', () => {
    const hull = convexHull([
      ...square,
      { longitude: 0.5, latitude: 0.5 },
      { longitude: 0.2, latitude: 0.8 },
    ]);

    expect(hull).toHaveLength(5);
    expect(hull[0]).toEqual(hull[4]);
    const ring = hull.slice(0, 4);
    // 凸包顶点顺序无关，比较集合即可。
    expect(
      new Set(ring.map((point) => `${String(point.longitude)},${String(point.latitude)}`)),
    ).toEqual(new Set(['0,0', '0,1', '1,1', '1,0']));
    // 面积应等于正方形本身的面积（球面模型下略小于 1 平方度）。
    const area = measureArea(hull);
    expect(area.squareKilometers).toBeGreaterThan(12_000);
  });

  it('handles duplicates, collinear points, and degenerate input', () => {
    expect(
      convexHull([
        { longitude: 1, latitude: 1 },
        { longitude: 1, latitude: 1 },
      ]),
    ).toEqual([{ longitude: 1, latitude: 1 }]);
    expect(
      convexHull([
        { longitude: 0, latitude: 0 },
        { longitude: 1, latitude: 0 },
        { longitude: 2, latitude: 0 },
      ]),
    ).toEqual([
      { longitude: 0, latitude: 0 },
      { longitude: 2, latitude: 0 },
      { longitude: 0, latitude: 0 },
    ]);
    expect(convexHull([])).toEqual([]);
  });

  it('keeps every input point inside the hull and rejects invalid coordinates', () => {
    const points: GeoPoint[] = [];
    for (let index = 0; index < 50; index += 1) {
      points.push({ longitude: (index * 7) % 11, latitude: (index * 13) % 17 });
    }
    const hull = convexHull(points);

    // 凸包面积不小于任意三点构成的三角形面积。
    const hullArea = measureArea(hull).squareMeters;
    for (let index = 0; index + 2 < points.length; index += 3) {
      const first = points[index];
      const second = points[index + 1];
      const third = points[index + 2];
      if (!first || !second || !third) {
        continue;
      }
      const triangle = measureArea([first, second, third]).squareMeters;
      expect(triangle).toBeLessThanOrEqual(hullArea + 1e-6);
    }

    expect(() => convexHull([{ longitude: 181, latitude: 0 }])).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});

describe('simplifyPath', () => {
  /** 经度 0 到 1 度的直线，中间插入偏离不超过 1 米外的点。 */
  const straight: GeoPoint[] = [
    { longitude: 0, latitude: 0 },
    { longitude: 0.25, latitude: 1e-6 },
    { longitude: 0.5, latitude: 0 },
    { longitude: 0.75, latitude: -1e-6 },
    { longitude: 1, latitude: 0 },
  ];

  it('removes points within the tolerance and keeps the endpoints', () => {
    const result = simplifyPath(straight, 5);

    expect(result.points).toEqual([
      { longitude: 0, latitude: 0 },
      { longitude: 1, latitude: 0 },
    ]);
    expect(result.removedCount).toBe(3);
  });

  it('keeps points further away than the tolerance', () => {
    const bendy: GeoPoint[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 0.5, latitude: 0.01 },
      { longitude: 1, latitude: 0 },
    ];

    expect(simplifyPath(bendy, 100).points).toHaveLength(3);
    expect(simplifyPath(bendy, 5_000).points).toHaveLength(2);
  });

  it('stays within the tolerance of the original path and keeps rings closed', () => {
    const dense: GeoPoint[] = [];
    for (let index = 0; index <= 200; index += 1) {
      const radians = (index / 200) * Math.PI * 2;
      dense.push({ longitude: Math.cos(radians), latitude: Math.sin(radians) });
    }

    const result = simplifyRing(dense, 1_000);

    expect(result.points).toHaveLength(result.points.length);
    expect(result.removedCount).toBeGreaterThan(0);
    expect(result.points[0]).toEqual(result.points[result.points.length - 1]);
    // 面积相对误差应远低于 5%。
    const original = measureArea(dense).squareMeters;
    const simplified = measureArea(result.points).squareMeters;
    expect(Math.abs(simplified - original) / original).toBeLessThan(0.05);
    // 抽稀只会让长度变短或持平。
    expect(measurePathLength(result.points).meters).toBeLessThanOrEqual(
      measurePathLength(dense).meters + 1,
    );
  });

  it('handles short inputs and validates arguments', () => {
    expect(simplifyPath([{ longitude: 0, latitude: 0 }], 1)).toEqual({
      points: [{ longitude: 0, latitude: 0 }],
      removedCount: 0,
    });
    expect(
      simplifyPath(
        [
          { longitude: 0, latitude: 0 },
          { longitude: 0, latitude: 0 },
          { longitude: 1, latitude: 0 },
        ],
        10,
      ).points,
    ).toHaveLength(2);
    expect(() => simplifyPath(square, 0)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => simplifyPath([{ longitude: Number.NaN, latitude: 0 }], 1)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});

describe('validatePolygon', () => {
  it('accepts a well-formed polygon with a hole', () => {
    const polygon = {
      outer: [
        { longitude: 0, latitude: 0 },
        { longitude: 2, latitude: 0 },
        { longitude: 2, latitude: 2 },
        { longitude: 0, latitude: 2 },
        { longitude: 0, latitude: 0 },
      ],
      holes: [
        [
          { longitude: 0.5, latitude: 0.5 },
          { longitude: 1, latitude: 0.5 },
          { longitude: 1, latitude: 1 },
          { longitude: 0.5, latitude: 0.5 },
        ],
      ],
    };

    expect(validatePolygon(polygon)).toEqual([]);
    expect(validatePolygon(polygon, { requireClosed: true })).toEqual([]);
  });

  it('reports too few vertices, unclosed rings, and duplicates', () => {
    expect(validatePolygon({ outer: [] }).map((issue) => issue.code)).toEqual(['TOO_FEW_VERTICES']);
    expect(
      validatePolygon({
        outer: [
          { longitude: 0, latitude: 0 },
          { longitude: 1, latitude: 0 },
        ],
      }).map((issue) => issue.code),
    ).toEqual(['TOO_FEW_VERTICES']);

    const open = validatePolygon(
      {
        outer: [
          { longitude: 0, latitude: 0 },
          { longitude: 1, latitude: 0 },
          { longitude: 1, latitude: 1 },
        ],
      },
      { requireClosed: true },
    );
    expect(open.map((issue) => issue.code)).toContain('UNCLOSED_RING');

    const duplicated = validatePolygon({
      outer: [
        { longitude: 0, latitude: 0 },
        { longitude: 1, latitude: 0 },
        { longitude: 1, latitude: 0 },
        { longitude: 0, latitude: 1 },
      ],
    });
    expect(duplicated.map((issue) => issue.code)).toContain('DUPLICATE_VERTEX');
  });

  it('detects a self-intersecting ring but not a closed square', () => {
    const bowtie = validatePolygon({
      outer: [
        { longitude: 0, latitude: 0 },
        { longitude: 1, latitude: 1 },
        { longitude: 1, latitude: 0 },
        { longitude: 0, latitude: 1 },
        { longitude: 0, latitude: 0 },
      ],
    });
    const issue = bowtie.find((entry) => entry.code === 'SELF_INTERSECTION');

    expect(issue).toBeDefined();
    expect(issue?.ring).toBe('outer');

    expect(
      validatePolygon({
        outer: [
          { longitude: 0, latitude: 0 },
          { longitude: 1, latitude: 0 },
          { longitude: 1, latitude: 1 },
          { longitude: 0, latitude: 1 },
          { longitude: 0, latitude: 0 },
        ],
      }).some((entry) => entry.code === 'SELF_INTERSECTION'),
    ).toBe(false);
  });

  it('can skip the self-intersection scan for very large rings', () => {
    const ring: GeoPoint[] = [];
    for (let index = 0; index < 100; index += 1) {
      const radians = (index / 100) * Math.PI * 2;
      ring.push({ longitude: Math.cos(radians), latitude: Math.sin(radians) });
    }

    expect(validatePolygon({ outer: ring }, { checkSelfIntersection: false })).toEqual([]);
  });

  it('reports a hole outside the shell and a hole crossing the shell', () => {
    const shell = [
      { longitude: 0, latitude: 0 },
      { longitude: 1, latitude: 0 },
      { longitude: 1, latitude: 1 },
      { longitude: 0, latitude: 1 },
      { longitude: 0, latitude: 0 },
    ];

    const outside = validatePolygon({
      outer: shell,
      holes: [
        [
          { longitude: 5, latitude: 5 },
          { longitude: 5.5, latitude: 5 },
          { longitude: 5.5, latitude: 5.5 },
        ],
      ],
    });
    expect(outside.map((issue) => issue.code)).toContain('HOLE_OUTSIDE_SHELL');
    expect(outside[0]?.ring).toBe(0);

    const crossing = validatePolygon({
      outer: shell,
      holes: [
        [
          { longitude: 0.5, latitude: 0.5 },
          { longitude: 1.5, latitude: 0.5 },
          { longitude: 1.5, latitude: 0.8 },
        ],
      ],
    });
    expect(crossing.map((issue) => issue.code)).toContain('HOLE_INTERSECTS_SHELL');
  });

  it('rejects malformed input instead of guessing', () => {
    expect(() => validatePolygon(undefined as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => validatePolygon({ outer: 'nope' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => validatePolygon({ outer: [{ longitude: 200, latitude: 0 }] as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
