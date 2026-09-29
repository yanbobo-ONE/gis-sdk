import { Cartographic, EllipsoidGeodesic } from 'cesium';
import { describe, expect, it } from 'vitest';

import { registerChinaCrs, registerCrs, transformGeoPoint } from '../src/spatial/crs.js';
import { measureDistance, measurePathLength } from '../src/spatial/measure.js';
import type { GeoPoint } from '../src/spatial/types.js';

/**
 * 独立实现交叉验证。
 *
 * 本文件**不 mock cesium**，直接使用真实的 Cesium 测地线与投影函数作为第二实现；
 * SDK 内部的量算基于 turf 的球面模型（R = 6371008.8m），Cesium 用 WGS84 椭球，
 * 两者的差异有确定量级，因此断言给的是量化容差而不是"看起来差不多"。
 */
const EARTH_SPHERE_VS_WGS84_TOLERANCE = 0.005;

function ellipsoidDistance(from: GeoPoint, to: GeoPoint): number {
  const geodesic = new EllipsoidGeodesic(
    Cartographic.fromDegrees(from.longitude, from.latitude),
    Cartographic.fromDegrees(to.longitude, to.latitude),
  );
  return geodesic.surfaceDistance;
}

describe('spatial cross validation against real Cesium math', () => {
  it('agrees with WGS84 ellipsoid geodesics within the documented tolerance', () => {
    const pairs: readonly [string, GeoPoint, GeoPoint, number][] = [
      [
        '北京 → 上海',
        { longitude: 116.39, latitude: 39.9 },
        { longitude: 121.47, latitude: 31.23 },
        0.002,
      ],
      ['赤道 1 度', { longitude: 0, latitude: 0 }, { longitude: 1, latitude: 0 }, 0.002],
      [
        '南半球 20°S 1 度',
        { longitude: 30, latitude: -20 },
        { longitude: 31, latitude: -20 },
        0.002,
      ],
      ['高纬 85°N 1 度', { longitude: 0, latitude: 85 }, { longitude: 1, latitude: 85 }, 0.002],
      [
        '跨日期变更线',
        { longitude: 179.9, latitude: 0 },
        { longitude: -179.9, latitude: 0 },
        0.002,
      ],
    ];

    for (const [label, from, to, expectedDeviation] of pairs) {
      const reference = ellipsoidDistance(from, to);
      const actual = measureDistance(from, to).meters;
      const deviation = Math.abs(actual - reference) / reference;

      expect(deviation, `${label} 的球面/椭球偏差`).toBeLessThan(EARTH_SPHERE_VS_WGS84_TOLERANCE);
      // 偏差量级也在预期区间内：过大说明单位或公式错了，被当成 0 则说明没在用球面模型。
      expect(deviation, `${label} 的偏差量级`).toBeGreaterThan(0);
      expect(deviation, `${label} 的偏差量级`).toBeLessThan(expectedDeviation * 3);
    }
  });

  it('matches the sum of ellipsoid segment lengths for a path', () => {
    const path: GeoPoint[] = [
      { longitude: 116.39, latitude: 39.9 },
      { longitude: 117.2, latitude: 39.4 },
      { longitude: 118.05, latitude: 38.6 },
      { longitude: 119.0, latitude: 37.9 },
    ];
    let reference = 0;
    for (let index = 0; index < path.length - 1; index += 1) {
      const from = path[index];
      const to = path[index + 1];
      if (from && to) {
        reference += ellipsoidDistance(from, to);
      }
    }
    const actual = measurePathLength(path).meters;

    expect(Math.abs(actual - reference) / reference).toBeLessThan(EARTH_SPHERE_VS_WGS84_TOLERANCE);
  });

  it('keeps Gauss-Kruger 3-degree zones distinct from UTM at the same point', () => {
    const beijing: GeoPoint = { longitude: 116.39, latitude: 39.9 };
    // proj4 不内置 CGCS2000 与中国高斯带，必须显式注册；注册后才有 EPSG:4490。
    registerChinaCrs({ zones: [39] });
    registerCrs('SPATIAL-TEST-UTM50N', '+proj=utm +zone=50 +ellps=WGS84 +units=m +no_defs', {
      descriptor: { kind: 'projected', units: 'm', ellipsoid: 'WGS84' },
    });

    const utm = transformGeoPoint(beijing, 'EPSG:4490', 'SPATIAL-TEST-UTM50N');
    // 方案 §8.3 记录的独立实测值。
    expect(utm.longitude).toBeCloseTo(447_854.5, 0);
    expect(utm.latitude).toBeCloseTo(4_416_836.4, 0);

    const gauss = transformGeoPoint(beijing, 'EPSG:4490', 'CGCS2000-GK-3D-CM117E');
    expect(Math.abs(gauss.longitude - utm.longitude)).toBeLessThan(100);
    // 3 度带 k=1 与 UTM k=0.9996 的差异在 40°N 量级约 1.7km，两者必须区分开。
    expect(Math.abs(gauss.latitude - utm.latitude)).toBeGreaterThan(1_000);
    expect(Math.abs(gauss.latitude - utm.latitude)).toBeLessThan(2_500);
  });
});
