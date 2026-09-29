import { describe, expect, it } from 'vitest';

import {
  measureArea,
  measureBBox,
  measureBearing,
  measureCenterOfMass,
  measureDestination,
  measureDistance,
  measurePathLength,
  nearestPointOnPath,
  pointAlongPath,
} from '../src/spatial/measure.js';
import { MAX_GEOMETRY_VERTICES } from '../src/spatial/types.js';
import type { GeoPoint } from '../src/spatial/types.js';

/** 已在球面模型（R = 6371008.8m）下核对过的基准点对。 */
const beijing: GeoPoint = { longitude: 116.39, latitude: 39.9 };
const shanghai: GeoPoint = { longitude: 121.47, latitude: 31.23 };

/** 赤道上 1° 的球面弧长：R × π / 180。 */
const EQUATOR_DEGREE_METERS = 111_195.08;

describe('spatial measure', () => {
  it('measures known point pairs with meters as the canonical unit', () => {
    const across = measureDistance(beijing, shanghai);
    expect(across.meters).toBeCloseTo(1_067_465.94, 1);
    expect(across.unit).toBe('meters');
    expect(across.value).toBeCloseTo(across.meters, 6);

    expect(
      measureDistance({ longitude: 0, latitude: 0 }, { longitude: 1, latitude: 0 }).meters,
    ).toBeCloseTo(EQUATOR_DEGREE_METERS, 1);
    expect(
      measureDistance({ longitude: 30, latitude: -20 }, { longitude: 31, latitude: -20 }).meters,
    ).toBeCloseTo(104_489.04, 1);
    expect(
      measureDistance({ longitude: 0, latitude: 85 }, { longitude: 1, latitude: 85 }).meters,
    ).toBeCloseTo(9_691.17, 1);
  });

  it('wraps around the antimeridian instead of measuring the long way', () => {
    const across = measureDistance(
      { longitude: 179.9, latitude: 0 },
      { longitude: -179.9, latitude: 0 },
    );
    expect(across.meters).toBeCloseTo(22_239.02, 1);
  });

  it('converts to kilometres and nautical miles', () => {
    const kilometres = measureDistance(beijing, shanghai, { units: 'kilometers' });
    expect(kilometres.value).toBeCloseTo(1_067.4659, 3);
    expect(kilometres.unit).toBe('kilometers');

    const nautical = measureDistance(
      { longitude: 0, latitude: 0 },
      { longitude: 0, latitude: 1 },
      { units: 'nauticalmiles' },
    );
    // 纬度 1° ≈ 60 海里。
    expect(nautical.value).toBeCloseTo(60, 0);
  });

  it('keeps southern hemisphere and northern hemisphere degrees symmetric', () => {
    const north = measureDistance({ longitude: 30, latitude: 20 }, { longitude: 31, latitude: 20 });
    const south = measureDistance(
      { longitude: 30, latitude: -20 },
      { longitude: 31, latitude: -20 },
    );
    expect(Math.abs(north.meters - south.meters)).toBeLessThan(0.01);

    // 经纬颠倒不会报错、只会静默算错，因此这里用越界样例把顺序钉死。
    expect(() =>
      measureDistance(
        // 悉尼的真实经纬度写成 (longitude, latitude) 之外的形式：纬度 151.21 越界。
        { longitude: -33.87, latitude: 151.21 },
        shanghai,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_COORDINATES' }));
  });

  it('measures bearing and destination', () => {
    expect(measureBearing(beijing, shanghai).degrees).toBeCloseTo(152.9982, 3);

    const east = measureDestination(beijing, 90, 1_000);
    expect(east.longitude).toBeCloseTo(116.40172, 4);
    expect(east.latitude).toBeCloseTo(39.9, 5);

    expect(measureBearing(beijing, measureDestination(beijing, 45, 5_000)).degrees).toBeCloseTo(
      45,
      4,
    );
  });

  it('measures polygon area, subtracting holes, and treats unclosed rings the same', () => {
    const square: GeoPoint[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 1, latitude: 0 },
      { longitude: 1, latitude: 1 },
      { longitude: 0, latitude: 1 },
    ];
    const closed = [...square, { longitude: 0, latitude: 0 }];

    const open = measureArea(square);
    expect(open.squareMeters).toBeCloseTo(12_363_718_145, -2);
    expect(open.squareKilometers).toBeCloseTo(12_363.72, 1);
    expect(measureArea(closed).squareMeters).toBeCloseTo(open.squareMeters, 6);

    const outer: GeoPoint[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 2, latitude: 0 },
      { longitude: 2, latitude: 2 },
      { longitude: 0, latitude: 2 },
    ];
    const withHole = measureArea({ outer, holes: [square] });
    // 关键约束是"外环面积减去洞面积"，绝对值随球面公式而定。
    expect(withHole.squareMeters).toBeCloseTo(
      measureArea({ outer }).squareMeters - measureArea(square).squareMeters,
      6,
    );
    expect(withHole.squareKilometers).toBeCloseTo(37_083.62, 1);
  });

  it('measures path length, points along the path, and the nearest point', () => {
    const path: GeoPoint[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 1, latitude: 0 },
      { longitude: 2, latitude: 0 },
    ];
    expect(measurePathLength(path).meters).toBeCloseTo(2 * EQUATOR_DEGREE_METERS, 1);

    const mid = pointAlongPath(path, 50_000);
    expect(mid.longitude).toBeCloseTo(0.44966, 5);
    expect(mid.latitude).toBeCloseTo(0, 6);

    // 超过总长时钳制到终点，而不是抛错或外推。
    expect(pointAlongPath(path, 999_999).longitude).toBeCloseTo(2, 6);

    // 落在线段中部的目标：最近点必定属于第一段，索引没有歧义。
    const midSegment = nearestPointOnPath(path, { longitude: 0.5, latitude: 1 });
    expect(midSegment.point.longitude).toBeCloseTo(0.5, 6);
    expect(midSegment.point.latitude).toBeCloseTo(0, 6);
    expect(midSegment.index).toBe(0);
    // 目标在路径正北 1°，垂直距离就是 1° 纬度弧长；沿线距离才是半度。
    expect(midSegment.distanceMeters).toBeCloseTo(EQUATOR_DEGREE_METERS, 0);
    expect(midSegment.alongMeters).toBeCloseTo(EQUATOR_DEGREE_METERS / 2, 0);

    // 正好落在共享顶点上时，两段都含该点，turf 报首段。
    const onVertex = nearestPointOnPath(path, { longitude: 1, latitude: 1 });
    expect(onVertex.point.longitude).toBeCloseTo(1, 6);
    expect(onVertex.point.latitude).toBeCloseTo(0, 6);
    expect(onVertex.distanceMeters).toBeCloseTo(EQUATOR_DEGREE_METERS, 0);
    expect(onVertex.alongMeters).toBeCloseTo(EQUATOR_DEGREE_METERS, 0);
    expect(onVertex.index).toBe(0);
  });

  it('measures bounding boxes and centroids', () => {
    const square: GeoPoint[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 1, latitude: 0 },
      { longitude: 1, latitude: 1 },
      { longitude: 0, latitude: 1 },
    ];
    expect(measureBBox({ outer: square })).toEqual({ west: 0, east: 1, south: 0, north: 1 });
    expect(measureBBox(beijing)).toEqual({
      west: 116.39,
      east: 116.39,
      south: 39.9,
      north: 39.9,
    });
    expect(measureBBox(square)).toEqual({ west: 0, east: 1, south: 0, north: 1 });

    expect(measureCenterOfMass({ outer: square })).toEqual({ longitude: 0.5, latitude: 0.5 });
    expect(measureCenterOfMass(square)).toEqual({ longitude: 0.5, latitude: 0.5 });
  });

  it('rejects degenerate and oversized input with stable error codes', () => {
    const empty: GeoPoint[] = [];
    expect(() => measurePathLength(empty)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT', module: 'spatial' }),
    );
    expect(() => measurePathLength([beijing])).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => measureArea([beijing, shanghai])).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => measureDistance({ longitude: Number.NaN, latitude: 0 }, shanghai)).toThrow(
      expect.objectContaining({ code: 'INVALID_COORDINATES' }),
    );
    expect(() => measureDistance({ longitude: 0, latitude: 91 }, shanghai)).toThrow(
      expect.objectContaining({ code: 'INVALID_COORDINATES' }),
    );
    expect(() => measureDistance(beijing, shanghai, { units: 'miles' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => measureDestination(beijing, 90, -1)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => measureDestination(beijing, Number.NaN, 1)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );

    const oversized = Array.from({ length: MAX_GEOMETRY_VERTICES + 1 }, () => beijing);
    expect(() => measurePathLength(oversized)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
