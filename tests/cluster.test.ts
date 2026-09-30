import { describe, expect, it } from 'vitest';

import { clusterPoints } from '../src/spatial/cluster.js';
import { measureDistance } from '../src/spatial/measure.js';

interface Station {
  readonly id: string;
  readonly position: { readonly longitude: number; readonly latitude: number };
}

const station = (id: string, longitude: number, latitude: number): Station => ({
  id,
  position: { longitude, latitude },
});

describe('clusterPoints', () => {
  it('groups points by the metric grid and reports counts and centers', () => {
    // 赤道上 10 公里网格：0 与 0.001 度相距约 111 米，必定落在同一格；0.5 度在两格外。
    const items = [
      station('a', 0, 0),
      station('b', 0.001, 0),
      station('c', 0.5, 0),
    ];

    const clusters = clusterPoints(items, {
      cellSizeMeters: 10_000,
      positionOf: (item) => item.position,
    });

    expect(clusters).toHaveLength(2);
    const [first, second] = clusters;
    expect(first?.count).toBe(2);
    expect(first?.members.map((member) => member.id)).toEqual(['a', 'b']);
    expect(second?.count).toBe(1);
    expect(second?.members[0]?.id).toBe('c');
    // 中心是成员均值。
    expect(first?.center.longitude).toBeCloseTo(0.0005, 9);
    expect(first?.bounds.east).toBeCloseTo(0.001, 9);
  });

  it('keeps the grid cell size constant in meters across latitudes', () => {
    // 同一经度跨度（0.01 度）在高纬度覆盖的地面更小：60° 处约 556 米，赤道约 1113 米。
    const equator = clusterPoints(
      [station('a', 0, 0), station('b', 0.01, 0)],
      { cellSizeMeters: 800, positionOf: (item) => item.position },
    );
    const northern = clusterPoints(
      [station('a', 0, 60), station('b', 0.01, 60)],
      { cellSizeMeters: 800, positionOf: (item) => item.position },
    );

    expect(equator).toHaveLength(2);
    expect(northern).toHaveLength(1);
  });

  it('does not split data across the dateline', () => {
    const items = [station('a', 179.999, 0), station('b', -179.999, 0)];

    const clusters = clusterPoints(items, { cellSizeMeters: 1_000, positionOf: (item) => item.position });

    expect(clusters).toHaveLength(1);
    // 中心落在 180 附近，而不是 0。
    expect(Math.abs(clusters[0]?.center.longitude ?? 0)).toBeCloseTo(180, 6);
    expect(measureDistance(items[0]?.position ?? { longitude: 0, latitude: 0 }, clusters[0]?.center ?? { longitude: 0, latitude: 0 }).meters).toBeLessThan(300);
  });

  it('drops clusters below minCount and keeps a stable order', () => {
    const items = [
      station('south', 116.39, 39.8),
      station('north', 116.39, 39.9),
      station('north-2', 116.391, 39.9),
    ];

    const clusters = clusterPoints(items, {
      cellSizeMeters: 2_000,
      positionOf: (item) => item.position,
      minCount: 2,
    });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.members.map((member) => member.id)).toEqual(['north', 'north-2']);

    const all = clusterPoints(items, { cellSizeMeters: 2_000, positionOf: (item) => item.position });
    // 顺序按网格行列：南边的簇在前。
    expect(all[0]?.members[0]?.id).toBe('south');
    // 同样的输入重复聚合得到同样的键。
    const again = clusterPoints(items, { cellSizeMeters: 2_000, positionOf: (item) => item.position });
    expect(again.map((cluster) => cluster.id)).toEqual(all.map((cluster) => cluster.id));
  });

  it('accepts plain points without a positionOf and reports bounds', () => {
    const clusters = clusterPoints(
      [
        { longitude: 1, latitude: 1 },
        { longitude: 1.0005, latitude: 1.0005 },
      ],
      { cellSizeMeters: 5_000 },
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.bounds.west).toBeCloseTo(1, 9);
    expect(clusters[0]?.bounds.north).toBeCloseTo(1.0005, 9);
    expect(clusterPoints([], { cellSizeMeters: 1_000 })).toEqual([]);
  });

  it('validates options and coordinates', () => {
    expect(() => clusterPoints([], { cellSizeMeters: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => clusterPoints([], { cellSizeMeters: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => clusterPoints([], { cellSizeMeters: 1_000, minCount: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() =>
      clusterPoints([{ longitude: 200, latitude: 0 }], { cellSizeMeters: 1_000 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() => clusterPoints('nope' as never, { cellSizeMeters: 1_000 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
