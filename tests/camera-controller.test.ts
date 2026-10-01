import { describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const fromDegrees = vi.fn<(longitude: number, latitude: number, height?: number) => object>(
    (longitude: number, latitude: number, height = 0) => ({
      longitude,
      latitude,
      height,
    }),
  );
  const toRadians = vi.fn<(value: number) => number>((value: number) => value / 180);
  const toDegrees = vi.fn<(value: number) => number>((value: number) => (value * 180) / Math.PI);

  return { fromDegrees, toRadians, toDegrees };
});

vi.mock('cesium', () => ({
  BoundingSphere: class BoundingSphere {
    constructor(
      readonly center: unknown,
      readonly radius: number,
    ) {}
  },
  Cartesian2: class Cartesian2 {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
  },
  Cartesian3: {
    fromDegrees: cesium.fromDegrees,
    fromElements: (x: number, y: number, z: number) => ({ x, y, z }),
  },
  Math: { toRadians: cesium.toRadians, toDegrees: cesium.toDegrees },
}));

import { CesiumCameraController } from '../src/cesium/camera-controller.js';

function createCamera(overrides: Record<string, unknown> = {}) {
  return {
    cancelFlight: vi.fn(),
    flyTo: vi.fn(),
    setView: vi.fn(),
    positionCartographic: { longitude: Math.PI / 2, latitude: Math.PI / 4, height: 1200 },
    positionWC: { x: 1, y: 2, z: 3 },
    // 屏幕中心的射线命中椭球：返回一个世界坐标点作为深度锚点。
    pickEllipsoid: vi.fn(() => ({ x: 6_378_137, y: 0, z: 0 })),
    getPixelSize: vi.fn(() => 24.5),
    heading: Math.PI,
    pitch: -Math.PI / 2,
    roll: Math.PI / 6,
    computeViewRectangle: vi.fn(() => ({
      west: -Math.PI / 2,
      south: -Math.PI / 4,
      east: Math.PI / 2,
      north: Math.PI / 4,
    })),
    ...overrides,
  };
}

describe('CesiumCameraController', () => {
  it('converts degree positions and orientations before setting the view', () => {
    const camera = createCamera();
    const controller = new CesiumCameraController(camera);

    controller.setView({
      longitude: 116.39,
      latitude: 39.9,
      height: 1200,
      heading: 90,
      pitch: -45,
      roll: 0,
    });

    expect(cesium.fromDegrees).toHaveBeenCalledWith(116.39, 39.9, 1200);
    expect(camera.setView).toHaveBeenCalledWith({
      destination: { longitude: 116.39, latitude: 39.9, height: 1200 },
      orientation: { heading: 0.5, pitch: -0.25, roll: 0 },
    });
  });

  it('resolves completed flights and rejects explicit cancellation', async () => {
    const camera = createCamera();
    const controller = new CesiumCameraController(camera);

    const completed = controller.flyTo({ longitude: 116.39, latitude: 39.9, duration: 1 });
    const firstOptions = camera.flyTo.mock.calls[0]?.[0] as { complete(): void };
    firstOptions.complete();
    await expect(completed).resolves.toBeUndefined();

    const cancelled = controller.flyTo({ longitude: 117, latitude: 40 });
    controller.cancelFlight();
    await expect(cancelled).rejects.toMatchObject({ code: 'CAMERA_FLIGHT_CANCELLED' });
    expect(camera.cancelFlight).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight flight before setting a view', async () => {
    const camera = createCamera();
    const controller = new CesiumCameraController(camera);
    const observed = controller
      .flyTo({ longitude: 116.39, latitude: 39.9, duration: 3 })
      .catch((error: unknown) => error);

    controller.setView({ longitude: 10, latitude: 20 });

    await expect(observed).resolves.toMatchObject({ code: 'CAMERA_FLIGHT_CANCELLED' });
    expect(camera.cancelFlight).toHaveBeenCalledOnce();
    expect(camera.setView).toHaveBeenCalledWith({
      destination: { longitude: 10, latitude: 20, height: 0 },
    });
  });

  it('cancels a flight started outside the SDK before setting a view', () => {
    const camera = createCamera();
    const controller = new CesiumCameraController(camera);

    controller.setView({ longitude: 10, latitude: 20 });

    expect(camera.cancelFlight).toHaveBeenCalledOnce();
    expect(camera.setView).toHaveBeenCalledOnce();
  });

  it('rejects invalid geographic coordinates before calling Cesium', () => {
    const camera = createCamera();
    const controller = new CesiumCameraController(camera);

    expect(() => {
      controller.setView({ longitude: 181, latitude: 39.9 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_CAMERA_VIEW' }));
    expect(camera.setView).not.toHaveBeenCalled();
  });

  it('does not cancel an active flight when the replacement request is invalid', async () => {
    const camera = createCamera();
    const controller = new CesiumCameraController(camera);
    const activeFlight = controller.flyTo({ longitude: 116.39, latitude: 39.9 });
    const observedFlight = activeFlight.catch((error: unknown) => error);

    expect(() => {
      void controller.flyTo({ longitude: 181, latitude: 39.9 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_CAMERA_VIEW' }));
    expect(() => {
      controller.setView({ longitude: 181, latitude: 39.9 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_CAMERA_VIEW' }));
    expect(camera.cancelFlight).not.toHaveBeenCalled();

    controller.cancelFlight();
    await expect(observedFlight).resolves.toMatchObject({ code: 'CAMERA_FLIGHT_CANCELLED' });
  });

  it('reads the current pose as degrees and meters', () => {
    const controller = new CesiumCameraController(createCamera());

    const view = controller.view;
    expect(view.longitude).toBeCloseTo(90, 9);
    expect(view.latitude).toBeCloseTo(45, 9);
    expect(view.height).toBe(1200);
    expect(view.heading).toBeCloseTo(180, 9);
    expect(view.pitch).toBeCloseTo(-90, 9);
    expect(view.roll).toBeCloseTo(30, 9);
  });

  it('falls back to a straight-down orientation while morphing', () => {
    const controller = new CesiumCameraController(
      createCamera({ heading: undefined, pitch: undefined, roll: undefined }),
    );

    expect(controller.view).toMatchObject({ heading: 0, pitch: -90, roll: 0 });
  });

  it('rejects a non-finite camera position', () => {
    const controller = new CesiumCameraController(
      createCamera({
        positionCartographic: { longitude: Number.NaN, latitude: 0, height: 0 },
      }),
    );

    expect(() => controller.view).toThrow(
      expect.objectContaining({ code: 'CAMERA_VIEW_UNAVAILABLE', retryable: true }),
    );
  });

  it('reads the viewport rectangle in degrees', () => {
    const controller = new CesiumCameraController(createCamera());

    expect(controller.viewRectangle).toEqual({ west: -90, south: -45, east: 90, north: 45 });
  });

  it('returns no rectangle when the camera misses the globe or the call fails', () => {
    const globe = new CesiumCameraController(
      createCamera({
        computeViewRectangle: vi.fn(() => ({
          west: -Math.PI,
          south: -Math.PI / 2,
          east: Math.PI,
          north: Math.PI / 2,
        })),
      }),
    ).viewRectangle;
    const missing = new CesiumCameraController(
      createCamera({ computeViewRectangle: vi.fn(() => undefined) }),
    ).viewRectangle;
    const throwing = new CesiumCameraController(
      createCamera({
        computeViewRectangle: vi.fn(() => {
          throw new Error('morphing');
        }),
      }),
    ).viewRectangle;
    const notFinite = new CesiumCameraController(
      createCamera({
        computeViewRectangle: vi.fn(() => ({
          west: Number.NaN,
          south: -1,
          east: 1,
          north: 1,
        })),
      }),
    ).viewRectangle;

    expect(globe).toBeUndefined();
    expect(missing).toBeUndefined();
    expect(throwing).toBeUndefined();
    expect(notFinite).toBeUndefined();
  });

  it('reports meters per pixel at the screen center', () => {
    const camera = createCamera();
    const controller = new CesiumCameraController(camera, {
      drawingBufferWidth: 1600,
      drawingBufferHeight: 800,
      globe: { ellipsoid: {} },
    });

    expect(controller.metersPerPixel).toBe(24.5);
    // 深度锚点取屏幕中心与椭球的交点。
    expect(
      (camera.pickEllipsoid as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0],
    ).toEqual({
      x: 800,
      y: 400,
    });
  });

  it('returns undefined meters per pixel without a scene or when the center misses the globe', () => {
    const noScene = new CesiumCameraController(createCamera());
    expect(noScene.metersPerPixel).toBeUndefined();

    const missing = new CesiumCameraController(
      createCamera({ pickEllipsoid: vi.fn(() => undefined) }),
      { drawingBufferWidth: 800, drawingBufferHeight: 600, globe: { ellipsoid: {} } },
    );
    expect(missing.metersPerPixel).toBeUndefined();

    const throwing = new CesiumCameraController(
      createCamera({
        pickEllipsoid: vi.fn(() => {
          throw new Error('2d mode');
        }),
      }),
      { drawingBufferWidth: 800, drawingBufferHeight: 600, globe: { ellipsoid: {} } },
    );
    expect(throwing.metersPerPixel).toBeUndefined();

    const zeroViewport = new CesiumCameraController(createCamera(), {
      drawingBufferWidth: 0,
      drawingBufferHeight: 0,
      globe: { ellipsoid: {} },
    });
    expect(zeroViewport.metersPerPixel).toBeUndefined();

    const notFinite = new CesiumCameraController(
      createCamera({ getPixelSize: vi.fn(() => Number.NaN) }),
      { drawingBufferWidth: 800, drawingBufferHeight: 600, globe: { ellipsoid: {} } },
    );
    expect(notFinite.metersPerPixel).toBeUndefined();
  });
});
