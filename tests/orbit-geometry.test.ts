import { describe, expect, it } from 'vitest';

import {
  EARTH_RADIUS,
  orbitalElementsFromAnchor,
  sampleOrbitPositions,
} from '../src/spatial/orbit-geometry.js';
import { EARTH_MU } from '../src/spatial/orbit.js';

/** 两点间的球面距离（米），用于判断采样点是否落在锚点附近。 */
function surfaceDistance(
  left: { longitude: number; latitude: number },
  right: { longitude: number; latitude: number },
): number {
  const toRadians = Math.PI / 180;
  const deltaLongitude = (right.longitude - left.longitude) * toRadians;
  const deltaLatitude = (right.latitude - left.latitude) * toRadians;
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(left.latitude * toRadians) *
      Math.cos(right.latitude * toRadians) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

describe('orbitalElementsFromAnchor', () => {
  it('derives an equatorial circular orbit from an equatorial anchor', () => {
    const elements = orbitalElementsFromAnchor(116.39, 0, 500_000);

    expect(elements.eccentricity).toBe(0);
    // 浮点噪声让 acos(≈1) 落在 1e-8 量级，这里按 1e-6 容差判断。
    expect(elements.inclination).toBeCloseTo(0, 6);
    expect(elements.semiMajorAxis).toBeCloseTo(EARTH_RADIUS + 500_000, 6);
    expect(elements.argumentOfPeriapsis).toBe(0);
    expect(elements.periodSeconds).toBeCloseTo(
      2 * Math.PI * Math.sqrt((EARTH_RADIUS + 500_000) ** 3 / EARTH_MU),
      6,
    );
  });

  it('derives a polar orbit from a polar anchor', () => {
    const elements = orbitalElementsFromAnchor(0, 90, 700_000);
    expect(elements.inclination).toBeCloseTo(Math.PI / 2, 9);
  });

  it('rejects out-of-range anchors instead of silently clamping them', () => {
    expect(() => orbitalElementsFromAnchor(0, 120, 500_000)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => orbitalElementsFromAnchor(181, 0, 500_000)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => orbitalElementsFromAnchor(0, 0, -50)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => orbitalElementsFromAnchor(Number.NaN, 0, 0)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => orbitalElementsFromAnchor(0, 0, Number.POSITIVE_INFINITY)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );

    // 高度 0 是合法的（贴地圆轨道），半长轴等于地球半径。
    expect(orbitalElementsFromAnchor(0, 0, 0).semiMajorAxis).toBe(EARTH_RADIUS);
  });
});

describe('sampleOrbitPositions', () => {
  it('produces a closed orbit through the anchor', () => {
    const anchor = { longitude: 116.39, latitude: 39.9 };
    const elements = orbitalElementsFromAnchor(anchor.longitude, anchor.latitude, 500_000);
    const positions = sampleOrbitPositions(elements);

    expect(positions).toHaveLength(361);
    // 首尾重合：轨道闭合，折线图层可以直接渲染。
    expect(positions[0]?.longitude).toBeCloseTo(positions[360]?.longitude ?? 0, 6);
    expect(positions[0]?.latitude).toBeCloseTo(positions[360]?.latitude ?? 0, 6);

    // 至少有一个采样点落在锚点附近（轨道过锚点）。
    const nearest = Math.min(...positions.map((position) => surfaceDistance(position, anchor)));
    expect(nearest).toBeLessThan(1_000);

    // 圆轨道：高度处处等于给定高度。
    for (const position of positions) {
      expect(position.height).toBeCloseTo(500_000, 0);
    }
  });

  it('keeps the anchor latitude as the orbit inclination', () => {
    const elements = orbitalElementsFromAnchor(0, 51.6, 400_000);
    const positions = sampleOrbitPositions(elements, { samples: 181 });
    const maxLatitude = Math.max(...positions.map((position) => Math.abs(position.latitude)));

    // 圆轨道的最高纬度等于倾角。
    expect(maxLatitude).toBeCloseTo((elements.inclination * 180) / Math.PI, 1);
  });

  it('honours the sample count with a documented minimum', () => {
    const elements = orbitalElementsFromAnchor(0, 0, 600_000);
    expect(sampleOrbitPositions(elements, { samples: 100 })).toHaveLength(100);
    expect(sampleOrbitPositions(elements, { samples: 36 })).toHaveLength(36);

    // 越界采样点数不做静默收敛，直接报错。
    for (const samples of [10, 12.7, Number.NaN]) {
      expect(() => sampleOrbitPositions(elements, { samples })).toThrow(
        expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
      );
    }
  });

  it('rejects elements outside the renderable range and missing input', () => {
    const base = {
      semiMajorAxis: EARTH_RADIUS + 500_000,
      eccentricity: 0,
      inclination: 0,
      ascendingNode: 0,
      argumentOfPeriapsis: 0,
      trueAnomaly: 0,
    };

    // 半长轴小于地球半径、偏心率超出 0–0.99：都直接报错。
    expect(() => sampleOrbitPositions({ ...base, semiMajorAxis: 1_000 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => sampleOrbitPositions({ ...base, eccentricity: 5 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => sampleOrbitPositions({ ...base, eccentricity: -0.1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );

    expect(() =>
      sampleOrbitPositions({
        semiMajorAxis: Number.NaN,
        eccentricity: 0,
        inclination: 0,
        ascendingNode: 0,
        argumentOfPeriapsis: 0,
        trueAnomaly: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));

    expect(() => sampleOrbitPositions(undefined as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
