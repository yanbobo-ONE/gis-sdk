import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const fromDegrees = vi.fn((longitude: number, latitude: number, height: number) => ({
    x: longitude,
    y: latitude,
    z: height,
  }));
  const cartesianToCartographic = vi.fn((position: { x: number; y: number; z: number }) => ({
    longitude: position.x,
    latitude: position.y,
    height: position.z,
  }));
  return {
    Cartesian2: class Cartesian2 {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    },
    Cartesian3: class Cartesian3 {
      static readonly fromDegrees = fromDegrees;
      constructor(
        readonly x: number,
        readonly y: number,
        readonly z: number,
      ) {}
    },
    Math: { toDegrees: vi.fn((value: number) => value + 1) },
    fromDegrees,
    cartesianToCartographic,
  };
});

const transit = vi.hoisted(() => ({
  worldToWindowCoordinates: vi.fn(),
}));

vi.mock('cesium', () => ({
  Cartesian2: cesium.Cartesian2,
  Cartesian3: cesium.Cartesian3,
  Math: cesium.Math,
  SceneTransforms: transit,
}));

import { CesiumCoordinateTransform } from '../src/cesium/coordinates.js';

function createViewer() {
  return {
    camera: { getPickRay: vi.fn() },
    scene: {
      globe: {
        ellipsoid: { cartesianToCartographic: cesium.cartesianToCartographic },
        pick: vi.fn(),
      },
    },
  };
}

describe('CesiumCoordinateTransform', () => {
  beforeEach(() => {
    cesium.fromDegrees.mockClear();
    cesium.cartesianToCartographic.mockClear();
    transit.worldToWindowCoordinates.mockReset();
  });

  it('converts WGS84 degrees to world coordinates and back', () => {
    const viewer = createViewer();
    const transform = new CesiumCoordinateTransform(viewer as never);

    expect(transform.toWorld({ longitude: 116.39, latitude: 39.9, height: 12 })).toEqual({
      x: 116.39,
      y: 39.9,
      z: 12,
    });
    expect(cesium.fromDegrees).toHaveBeenCalledWith(116.39, 39.9, 12);

    expect(transform.toGeoPosition({ x: 10, y: 20, z: 30 })).toEqual({
      longitude: 11,
      latitude: 21,
      height: 30,
    });
  });

  it('defaults the height to zero and rejects invalid geo positions', () => {
    const transform = new CesiumCoordinateTransform(createViewer() as never);

    transform.toWorld({ longitude: 1, latitude: 2 });
    expect(cesium.fromDegrees).toHaveBeenCalledWith(1, 2, 0);

    for (const position of [
      { longitude: Number.NaN, latitude: 0 },
      { longitude: 0, latitude: Number.POSITIVE_INFINITY },
      { longitude: 181, latitude: 0 },
      { longitude: 0, latitude: -91 },
      { longitude: 0, latitude: 0, height: Number.NaN },
    ]) {
      expect(() => transform.toWorld(position as never)).toThrow(
        expect.objectContaining({ code: 'INVALID_COORDINATES', operation: 'toWorld' }),
      );
    }
    expect(() => transform.toGeoPosition({ x: 0, y: Number.NaN, z: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_COORDINATES', operation: 'toGeoPosition' }),
    );
  });

  it('returns undefined instead of fake pixels when a point cannot be projected', () => {
    const transform = new CesiumCoordinateTransform(createViewer() as never);

    transit.worldToWindowCoordinates.mockReturnValueOnce({ x: 120, y: 240 });
    expect(transform.toWindow({ longitude: 1, latitude: 2 })).toEqual({ x: 120, y: 240 });

    transit.worldToWindowCoordinates.mockReturnValueOnce(undefined);
    expect(transform.toWindow({ longitude: 1, latitude: 2 })).toBeUndefined();

    expect(() => transform.toWindow({ longitude: 200, latitude: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_COORDINATES' }),
    );
  });

  it('picks a geo position from a window point and reports misses as undefined', () => {
    const viewer = createViewer();
    const transform = new CesiumCoordinateTransform(viewer as never);
    viewer.camera.getPickRay.mockReturnValueOnce({ origin: 'camera' });
    viewer.scene.globe.pick.mockReturnValueOnce({ x: 5, y: 6, z: 7 });

    expect(transform.pickGeoPosition({ x: 10, y: 20 })).toEqual({
      longitude: 6,
      latitude: 7,
      height: 7,
    });
    expect(viewer.scene.globe.pick).toHaveBeenCalledWith({ origin: 'camera' }, viewer.scene);

    viewer.camera.getPickRay.mockReturnValueOnce(undefined);
    expect(transform.pickGeoPosition({ x: 10, y: 20 })).toBeUndefined();

    viewer.camera.getPickRay.mockReturnValueOnce({ origin: 'camera' });
    viewer.scene.globe.pick.mockReturnValueOnce(undefined);
    expect(transform.pickGeoPosition({ x: 10, y: 20 })).toBeUndefined();
  });
});
