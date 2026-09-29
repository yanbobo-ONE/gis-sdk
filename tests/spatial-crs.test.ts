import { describe, expect, it } from 'vitest';

import {
  describeCrs,
  listCrs,
  registerChinaCrs,
  registerCrs,
  transformGeoPath,
  transformGeoPoint,
  transformGeoRing,
} from '../src/spatial/crs.js';
import type { GeoPoint } from '../src/spatial/types.js';

/** 已核对过的基准点：北京在天安门附近的经纬度。 */
const beijing: GeoPoint = { longitude: 116.39, latitude: 39.9 };

/** 方案 §8.3 已实测的投影基准值（3 度带 39 号，中央经线 117°E）。 */
const BASELINE_EASTING = 447_833.66;
const BASELINE_NORTHING = 4_418_603.79;

describe('spatial crs registry', () => {
  it('registers CGCS2000 geographic coordinates together with the requested Gauss zone', () => {
    const registered = registerChinaCrs({ zones: [39] });
    const codes = registered.map((descriptor) => descriptor.code);

    expect(codes).toContain('EPSG:4490');
    expect(codes).toContain('CGCS2000-GK-3D-CM117E');

    const zone = describeCrs('CGCS2000-GK-3D-CM117E');
    expect(zone).toMatchObject({
      kind: 'projected',
      units: 'm',
      ellipsoid: 'GRS80',
      centralMeridian: 117,
      zone: 39,
      zoneWidth: 3,
      zonePrefix: false,
    });
    expect(describeCrs('EPSG:4490')).toMatchObject({
      kind: 'geographic',
      units: 'degree',
      ellipsoid: 'GRS80',
    });
    expect(describeCrs('EPSG:4490')?.centralMeridian).toBeUndefined();
    expect(listCrs().length).toBeGreaterThanOrEqual(2);
    expect(Object.isFrozen(listCrs())).toBe(true);
  });

  it('matches the verified projection baseline and round-trips without residual', () => {
    const projected = transformGeoPoint(beijing, 'EPSG:4490', 'CGCS2000-GK-3D-CM117E');
    expect(projected.longitude).toBeCloseTo(BASELINE_EASTING, 2);
    expect(projected.latitude).toBeCloseTo(BASELINE_NORTHING, 2);

    const back = transformGeoPoint(projected, 'CGCS2000-GK-3D-CM117E', 'EPSG:4490');
    expect(back.longitude).toBeCloseTo(beijing.longitude, 9);
    expect(back.latitude).toBeCloseTo(beijing.latitude, 9);
  });

  it('accepts projected coordinates without WGS84 range assertions', () => {
    const back = transformGeoPoint(
      { longitude: BASELINE_EASTING, latitude: BASELINE_NORTHING },
      'CGCS2000-GK-3D-CM117E',
      'EPSG:4490',
    );
    expect(back.longitude).toBeCloseTo(beijing.longitude, 6);
    expect(back.latitude).toBeCloseTo(beijing.latitude, 6);

    // 投影坐标系下同样的数值若按经纬度解读会越界，这里必须放行。
    expect(() =>
      transformGeoPoint(
        { longitude: BASELINE_EASTING, latitude: 4_418_603.79 },
        'CGCS2000-GK-3D-CM117E',
        'CGCS2000-GK-3D-CM117E',
      ),
    ).not.toThrow();
  });

  it('applies the zone-number prefix convention on request', () => {
    registerChinaCrs({ zones: [39], withZonePrefix: true, registerGeographic: false });
    const prefixCode = 'CGCS2000-GK-3D-Z39';

    expect(describeCrs(prefixCode)?.zonePrefix).toBe(true);
    const projected = transformGeoPoint(beijing, 'EPSG:4490', prefixCode);
    // x_0 = 39 × 1000000 + 500000，因此东坐标带上 39 的前缀。
    expect(projected.longitude).toBeCloseTo(39_000_000 + BASELINE_EASTING, 2);
    expect(projected.latitude).toBeCloseTo(BASELINE_NORTHING, 2);
  });

  it('derives the 6-degree zone central meridian as 6n − 3', () => {
    const registered = registerChinaCrs({
      zones: [20],
      zoneWidth: 6,
      registerGeographic: false,
    });
    expect(registered[0]?.code).toBe('CGCS2000-GK-6D-CM117E');
    expect(describeCrs('CGCS2000-GK-6D-CM117E')).toMatchObject({
      zone: 20,
      zoneWidth: 6,
      centralMeridian: 117,
    });

    // 中央经线与投影参数相同，带宽度本身不改变投影结果。
    const sixDegree = transformGeoPoint(beijing, 'EPSG:4490', 'CGCS2000-GK-6D-CM117E');
    const threeDegree = transformGeoPoint(beijing, 'EPSG:4490', 'CGCS2000-GK-3D-CM117E');
    expect(sixDegree.longitude).toBeCloseTo(threeDegree.longitude, 6);
    expect(sixDegree.latitude).toBeCloseTo(threeDegree.latitude, 6);
  });

  it('rejects out-of-range zones, empty zone lists, and unsupported widths', () => {
    expect(() => registerChinaCrs({ zones: [] })).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
    expect(() => registerChinaCrs({ zones: [24] })).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
    expect(() => registerChinaCrs({ zones: [46] })).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
    expect(() => registerChinaCrs({ zones: [12], zoneWidth: 6 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
    expect(() => registerChinaCrs({ zones: [24], zoneWidth: 6 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
    expect(() => registerChinaCrs({ zones: [39.5] })).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
    expect(() => registerChinaCrs({ zones: [39], zoneWidth: 4 as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
  });

  it('requires explicit overwrite for duplicate registrations', () => {
    const code = 'SPATIAL-TEST-DUP';
    registerCrs(code, '+proj=longlat +ellps=WGS84 +no_defs', {
      descriptor: { kind: 'geographic', units: 'degree' },
    });

    expect(() => registerCrs(code, '+proj=longlat +ellps=WGS84 +no_defs')).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
    expect(
      registerCrs(code, '+proj=longlat +ellps=GRS80 +no_defs', { overwrite: true }).ellipsoid,
    ).toBe('GRS80');

    expect(() => registerCrs('', '+proj=longlat')).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
    expect(() => registerCrs('SPATIAL-TEST-EMPTY', '   ')).toThrow(
      expect.objectContaining({ code: 'INVALID_CRS_DEFINITION' }),
    );
  });

  it('resolves proj4 built-ins without registration and rejects unknown codes', () => {
    const viaBuiltIn = transformGeoPoint(beijing, 'WGS84', 'EPSG:4490');
    expect(viaBuiltIn.longitude).toBeCloseTo(beijing.longitude, 6);
    expect(viaBuiltIn.latitude).toBeCloseTo(beijing.latitude, 6);
    expect(describeCrs('WGS84')).toBeUndefined();

    expect(() => transformGeoPoint(beijing, 'EPSG:4490', 'EPSG:99999')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CRS' }),
    );
    expect(() => transformGeoPoint(beijing, '   ', 'EPSG:4490')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CRS' }),
    );
    expect(() =>
      transformGeoPoint({ longitude: Number.NaN, latitude: 0 }, 'EPSG:4490', 'WGS84'),
    ).toThrow(expect.objectContaining({ code: 'INVALID_COORDINATES' }));
    expect(() => transformGeoPoint({ longitude: 181, latitude: 0 }, 'EPSG:4490', 'WGS84')).toThrow(
      expect.objectContaining({ code: 'INVALID_COORDINATES' }),
    );
  });

  it('transforms vertex sequences and rings while preserving order and count', () => {
    const path: GeoPoint[] = [
      { longitude: 116.39, latitude: 39.9 },
      { longitude: 116.4, latitude: 39.91 },
      { longitude: 116.41, latitude: 39.92 },
    ];
    const pathProjected = transformGeoPath(path, 'EPSG:4490', 'CGCS2000-GK-3D-CM117E');
    expect(pathProjected).toHaveLength(3);
    expect(pathProjected[0]?.longitude).toBeCloseTo(BASELINE_EASTING, 2);
    expect(pathProjected[0]?.longitude).toBeLessThan(pathProjected[1]?.longitude ?? 0);
    expect(pathProjected[1]?.longitude).toBeLessThan(pathProjected[2]?.longitude ?? 0);

    const ring = transformGeoRing(path, 'EPSG:4490', 'CGCS2000-GK-3D-CM117E');
    expect(ring).toEqual(pathProjected);

    expect(transformGeoPath([], 'EPSG:4490', 'WGS84')).toEqual([]);
    expect(() => transformGeoPath('nope' as never, 'EPSG:4490', 'WGS84')).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
