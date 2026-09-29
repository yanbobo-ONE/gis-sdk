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

  return { fromDegrees, toRadians };
});

vi.mock('cesium', () => ({
  Cartesian3: { fromDegrees: cesium.fromDegrees },
  Math: { toRadians: cesium.toRadians },
}));

import { CesiumCameraController } from '../src/cesium/camera-controller.js';

function createCamera() {
  return {
    cancelFlight: vi.fn(),
    flyTo: vi.fn(),
    setView: vi.fn(),
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
});
