import { describe, expect, it } from 'vitest';

import { buildCircle, buildEllipse, buildStraightArrow } from '../src/spatial/plot-geometry.js';
import { measureBearing, measureDistance } from '../src/spatial/measure.js';
import type { GeoPoint } from '../src/spatial/types.js';

/**
 * 方位角与给定轴线的夹角（0 到 90 度）。
 *
 * 长轴两端等距，环上取到哪一端不作约定，因此按**轴线**比较而不是按方向比较。
 */
function axisOffset(bearingDegrees: number, axisDegrees: number): number {
  const delta = Math.abs(bearingDegrees - axisDegrees) % 180;
  return Math.min(delta, 180 - delta);
}

const beijing: GeoPoint = { longitude: 116.39, latitude: 39.9 };
const highLatitude: GeoPoint = { longitude: 20, latitude: 70 };

/** 环上每个顶点到圆心的距离，用来验证"确实是个圆"而不是看坐标数字。 */
function radii(ring: readonly GeoPoint[], center: GeoPoint): number[] {
  return ring.map((point) => measureDistance(center, point).meters);
}

describe('buildCircle', () => {
  it('keeps every vertex on the requested great-circle radius', () => {
    const ring = buildCircle({ center: beijing, radiusMeters: 50_000 });

    expect(ring.length).toBeGreaterThanOrEqual(16);
    // 首尾不重复：需要闭合时由业务用 closeRing() 或 polygonFeatureOf()。
    expect(ring[0]).not.toEqual(ring.at(-1));
    for (const radius of radii(ring, beijing)) {
      expect(Math.abs(radius - 50_000) / 50_000).toBeLessThan(0.005);
    }
  });

  it('stays round near the poles instead of squashing by longitude', () => {
    const ring = buildCircle({ center: highLatitude, radiusMeters: 100_000 });

    // 按经纬度画圆会在这里明显偏离；按大圆距离采样则每个顶点都落在半径上。
    for (const radius of radii(ring, highLatitude)) {
      expect(Math.abs(radius - 100_000) / 100_000).toBeLessThan(0.005);
    }
  });

  it('samples by chord tolerance and respects the vertex budget', () => {
    const coarse = buildCircle({ center: beijing, radiusMeters: 100_000 });
    const fine = buildCircle({
      center: beijing,
      radiusMeters: 100_000,
      toleranceMeters: 1,
    });
    const capped = buildCircle({
      center: beijing,
      radiusMeters: 100_000,
      toleranceMeters: 0.01,
      maxSamples: 64,
    });

    expect(fine.length).toBeGreaterThan(coarse.length);
    expect(capped.length).toBe(64);
  });

  it('rejects invalid inputs with stable error codes', () => {
    expect(() => buildCircle({ center: beijing, radiusMeters: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT', operation: 'buildCircle' }),
    );
    expect(() => buildCircle({ center: beijing, radiusMeters: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => buildCircle({ center: beijing, radiusMeters: 1_000, toleranceMeters: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => buildCircle({ center: beijing, radiusMeters: 1_000, maxSamples: 4 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() =>
      buildCircle({ center: { longitude: 200, latitude: 0 }, radiusMeters: 1_000 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_COORDINATES' }));
  });
});

describe('buildEllipse', () => {
  it('reaches the semi-axes and follows the requested rotation', () => {
    const ring = buildEllipse({
      center: beijing,
      semiMajorMeters: 80_000,
      semiMinorMeters: 30_000,
      rotationDegrees: 90,
    });

    const distances = radii(ring, beijing);
    const farthest = Math.max(...distances);
    const nearest = Math.min(...distances);
    expect(Math.abs(farthest - 80_000) / 80_000).toBeLessThan(0.02);
    expect(Math.abs(nearest - 30_000) / 30_000).toBeLessThan(0.02);

    // 长轴指向正东（方位角 90 度）：最远顶点在正东或正西——两端等远，取到哪端不作约定。
    const farthestPoint = ring[distances.indexOf(farthest)];
    if (!farthestPoint) {
      throw new Error('椭圆环为空');
    }
    expect(axisOffset(measureBearing(beijing, farthestPoint).degrees, 90)).toBeLessThan(3);
  });

  it('defaults to a north-pointing major axis and validates the axes', () => {
    const ring = buildEllipse({
      center: beijing,
      semiMajorMeters: 60_000,
      semiMinorMeters: 20_000,
    });
    const distances = radii(ring, beijing);
    const farthestPoint = ring[distances.indexOf(Math.max(...distances))];
    if (!farthestPoint) {
      throw new Error('椭圆环为空');
    }

    // 长轴指向正北（或正南）：两端等远。
    expect(axisOffset(measureBearing(beijing, farthestPoint).degrees, 0)).toBeLessThan(3);

    // 短半轴大于长半轴、非正数或非法方位角都直接拒绝，不静默交换。
    expect(() =>
      buildEllipse({ center: beijing, semiMajorMeters: 10_000, semiMinorMeters: 20_000 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() =>
      buildEllipse({ center: beijing, semiMajorMeters: 10_000, semiMinorMeters: 0 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() =>
      buildEllipse({
        center: beijing,
        semiMajorMeters: 10_000,
        semiMinorMeters: 5_000,
        rotationDegrees: Number.NaN,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
  });
});

describe('buildStraightArrow', () => {
  const from: GeoPoint = { longitude: 116.39, latitude: 39.9 };
  const to: GeoPoint = { longitude: 116.9, latitude: 39.9 };

  it('builds a seven-vertex ring whose tip is exactly the requested end', () => {
    const ring = buildStraightArrow({ from, to });

    expect(ring).toHaveLength(7);
    // 箭尖是唯一的最远点，并且与传入的终点逐位一致。
    expect(ring[3]?.longitude).toBe(to.longitude);
    expect(ring[3]?.latitude).toBe(to.latitude);
    const length = measureDistance(from, to).meters;
    const distances = ring.map((point) => measureDistance(from, point).meters);
    expect(Math.max(...distances)).toBeCloseTo(length, 3);
  });

  it('uses the requested widths and derives them from length otherwise', () => {
    const explicit = buildStraightArrow({
      from,
      to,
      tailWidthMeters: 2_000,
      headWidthMeters: 5_000,
    });
    const tail = explicit[0];
    const tailOther = explicit[6];
    const headLeft = explicit[2];
    const headRight = explicit[4];
    if (!tail || !tailOther || !headLeft || !headRight) {
      throw new Error('箭头环为空');
    }

    // 局部切平面换算有约 0.2% 的近似误差，按相对容差断言。
    const tailWidth = measureDistance(tail, tailOther).meters;
    const headWidth = measureDistance(headLeft, headRight).meters;
    expect(Math.abs(tailWidth - 2_000) / 2_000).toBeLessThan(0.01);
    expect(Math.abs(headWidth - 5_000) / 5_000).toBeLessThan(0.01);

    // 省略宽度时按全长推导：箭杆不超过全长的 25%，箭头不超过 60%。
    const derived = buildStraightArrow({ from, to });
    const length = measureDistance(from, to).meters;
    const derivedTail = derived[0];
    const derivedTailOther = derived[6];
    const derivedHeadLeft = derived[2];
    const derivedHeadRight = derived[4];
    if (!derivedTail || !derivedTailOther || !derivedHeadLeft || !derivedHeadRight) {
      throw new Error('箭头环为空');
    }
    const derivedTailWidth = measureDistance(derivedTail, derivedTailOther).meters;
    const derivedHeadWidth = measureDistance(derivedHeadLeft, derivedHeadRight).meters;
    expect(derivedTailWidth).toBeLessThanOrEqual(length * 0.25 + 1);
    expect(derivedHeadWidth).toBeLessThanOrEqual(length * 0.6 + 1);
    expect(derivedHeadWidth).toBeGreaterThan(derivedTailWidth);
  });

  it('rejects a degenerate axis or invalid widths', () => {
    expect(() => buildStraightArrow({ from, to: from })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT', operation: 'buildStraightArrow' }),
    );
    expect(() => buildStraightArrow({ from, to, tailWidthMeters: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => buildStraightArrow({ from, to, headWidthMeters: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
