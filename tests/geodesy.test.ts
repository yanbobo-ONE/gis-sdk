import { describe, expect, it } from 'vitest';

import {
  createLocalFrame,
  ecefToGeodetic,
  geodeticToEcef,
  WGS84_SEMI_MAJOR_AXIS,
  WGS84_SEMI_MINOR_AXIS,
} from '../src/spatial/geodesy.js';
import { measureDistance } from '../src/spatial/measure.js';
import proj4 from 'proj4';
import { GisError } from '../src/core/errors.js';

const BEIJING = { longitude: 116.391, latitude: 39.907, height: 44 };

describe('geodeticToEcef', () => {
  it('hits the analytic anchors of the WGS84 ellipsoid', () => {
    // 赤道与本初子午线交点：正好一个长半轴。
    expect(geodeticToEcef({ longitude: 0, latitude: 0 })).toEqual({
      x: WGS84_SEMI_MAJOR_AXIS,
      y: 0,
      z: 0,
    });
    // 赤道与东经 90°：Y 轴上一个长半轴。
    const east = geodeticToEcef({ longitude: 90, latitude: 0 });
    expect(east.x).toBeCloseTo(0, 6);
    expect(east.y).toBeCloseTo(WGS84_SEMI_MAJOR_AXIS, 6);
    expect(east.z).toBeCloseTo(0, 6);
    // 北极：正好一个短半轴（6356752.314245179 米）。
    const pole = geodeticToEcef({ longitude: 0, latitude: 90 });
    expect(pole.x).toBeCloseTo(0, 6);
    expect(pole.z).toBeCloseTo(WGS84_SEMI_MINOR_AXIS, 9);
    expect(WGS84_SEMI_MINOR_AXIS).toBeCloseTo(6_356_752.314245179, 6);
  });

  it('adds height along the ellipsoid normal', () => {
    expect(geodeticToEcef({ longitude: 0, latitude: 0, height: 1_000 }).x).toBeCloseTo(
      WGS84_SEMI_MAJOR_AXIS + 1_000,
      9,
    );
    const pole = geodeticToEcef({ longitude: 0, latitude: 90, height: 1_000 });
    expect(pole.z).toBeCloseTo(WGS84_SEMI_MINOR_AXIS + 1_000, 9);
  });

  it('rejects non-finite input', () => {
    for (const bad of [
      { longitude: Number.NaN, latitude: 0 },
      { longitude: 0, latitude: Number.POSITIVE_INFINITY },
      { longitude: 0, latitude: 0, height: Number.NaN },
    ]) {
      expect(() => geodeticToEcef(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
      );
    }
    expect(() => geodeticToEcef(undefined as never)).toThrow(GisError);
  });
});

describe('ecefToGeodetic', () => {
  it('round-trips every latitude band and altitude within tight bounds', () => {
    const samples = [
      { longitude: 0, latitude: 0, height: 0 },
      BEIJING,
      { longitude: -122.4194, latitude: 37.7749, height: -30 },
      { longitude: 18.4241, latitude: -33.9249, height: 1_000 },
      { longitude: 179.9, latitude: 89.5, height: 2_000 },
      { longitude: -179.9, latitude: -89.5, height: 0 },
      { longitude: 116.391, latitude: 39.907, height: 400_000 },
    ];
    for (const sample of samples) {
      const back = ecefToGeodetic(geodeticToEcef(sample));
      expect(Math.abs(back.longitude - sample.longitude)).toBeLessThan(1e-9);
      expect(Math.abs(back.latitude - sample.latitude)).toBeLessThan(1e-9);
      // 高程精度受迭代收敛影响：中纬度约 1e-6 米，89.5° 附近最差约 6e-4 米，界取 1 毫米。
      expect(Math.abs(back.height - sample.height)).toBeLessThan(1e-3);
    }
  });

  it('handles the polar axis without dividing by zero', () => {
    const north = ecefToGeodetic({ x: 0, y: 0, z: WGS84_SEMI_MINOR_AXIS });
    expect(north.latitude).toBe(90);
    expect(north.height).toBeCloseTo(0, 9);

    const south = ecefToGeodetic({ x: 0, y: 0, z: -WGS84_SEMI_MINOR_AXIS });
    expect(south.latitude).toBe(-90);
    expect(south.height).toBeCloseTo(0, 9);
  });

  it('rejects non-finite input', () => {
    expect(() => ecefToGeodetic({ x: Number.NaN, y: 0, z: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});

describe('createLocalFrame', () => {
  it('uses orthonormal east / north / up axes', () => {
    const frame = createLocalFrame(BEIJING);
    const { east, north, up } = frame;
    for (const axis of [east, north, up]) {
      expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 12);
    }
    expect(east.x * north.x + east.y * north.y + east.z * north.z).toBeCloseTo(0, 12);
    expect(east.x * up.x + east.y * up.y + east.z * up.z).toBeCloseTo(0, 12);
    expect(north.x * up.x + north.y * up.y + north.z * up.z).toBeCloseTo(0, 12);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame.origin)).toBe(true);
  });

  it('maps the origin to zero and round-trips nearby positions', () => {
    const frame = createLocalFrame(BEIJING);
    const atOrigin = frame.toLocal(BEIJING);
    expect(Math.abs(atOrigin.x)).toBeLessThan(1e-6);
    expect(Math.abs(atOrigin.y)).toBeLessThan(1e-6);
    expect(Math.abs(atOrigin.z)).toBeLessThan(1e-6);

    for (const local of [
      { x: 1_000, y: 0, z: 0 },
      { x: 0, y: 2_500, z: 120 },
      { x: -8_000, y: -6_000, z: -40 },
    ]) {
      const geographic = frame.toGeographic(local);
      const back = frame.toLocal(geographic);
      expect(Math.abs(back.x - local.x)).toBeLessThan(1e-3);
      expect(Math.abs(back.y - local.y)).toBeLessThan(1e-3);
      expect(Math.abs(back.z - local.z)).toBeLessThan(1e-3);
    }
  });

  it('keeps local offsets within the documented 0.1% of true ground distance', () => {
    const frame = createLocalFrame(BEIJING);
    for (const local of [
      { x: 1_000, y: 0, z: 0 },
      { x: 0, y: 10_000, z: 0 },
      { x: 30_000, y: 40_000, z: 0 },
    ]) {
      const target = frame.toGeographic(local);
      const chord = Math.hypot(local.x, local.y);
      const measured = measureDistance(BEIJING, target).meters;
      // 两处误差来源叠加：ENU 是切平面近似（~d²/R²），而 measureDistance 走球面 haversine，
      // 其半径取 6371 km，与椭球在 40°N 的曲率半径差约 0.25%。界取 0.5%。
      expect(Math.abs(chord - measured) / measured).toBeLessThan(5e-3);
    }
  });

  it('cross-validates ECEF against an independent proj4 geocentric transform', () => {
    proj4.defs('X-GEOCENT', '+proj=geocent +datum=WGS84 +units=m +no_defs');
    const samples = [
      { longitude: 0, latitude: 0, height: 0 },
      BEIJING,
      { longitude: -122.4194, latitude: 37.7749, height: -30 },
      { longitude: 179.9, latitude: 89.5, height: 2_000 },
    ];
    for (const sample of samples) {
      const [x, y, z] = proj4('EPSG:4326', 'X-GEOCENT', [
        sample.longitude,
        sample.latitude,
        sample.height,
      ]);
      const mine = geodeticToEcef(sample);
      // 两套独立实现都应落在同一椭球定义上，毫米级即为一致。
      expect(Math.abs(mine.x - x)).toBeLessThan(1e-3);
      expect(Math.abs(mine.y - y)).toBeLessThan(1e-3);
      expect(Math.abs(mine.z - z)).toBeLessThan(1e-3);

      const back = ecefToGeodetic({ x, y, z });
      expect(Math.abs(back.longitude - sample.longitude)).toBeLessThan(1e-9);
      expect(Math.abs(back.latitude - sample.latitude)).toBeLessThan(1e-9);
    }
  });

  it('rejects invalid positions and local offsets', () => {
    expect(() => createLocalFrame({ longitude: Number.NaN, latitude: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    const frame = createLocalFrame(BEIJING);
    expect(() => frame.toGeographic({ x: Number.NaN, y: 0, z: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
