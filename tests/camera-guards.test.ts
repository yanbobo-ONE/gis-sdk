import { describe, expect, it, vi } from 'vitest';

import { guardCameraPose, guardDegenerateCameraRotation } from '../src/cesium/camera-guards.js';

interface Vector {
  x: number;
  y: number;
  z: number;
}

function vector(x: number, y: number, z: number): Vector {
  return { x, y, z };
}

function createCamera() {
  return {
    position: vector(1, 2, 3),
    direction: vector(1, 0, 0),
    up: vector(0, 0, 1),
    right: vector(0, 1, 0),
  };
}

function createScene() {
  const listeners = new Set<() => void>();
  const controller: { update: () => void } = { update: vi.fn() };
  const scene = {
    preUpdate: {
      addEventListener: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    screenSpaceCameraController: controller,
  };
  return {
    scene,
    controller,
    firePreUpdate: () => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('guardDegenerateCameraRotation', () => {
  it('skips degenerate and non-finite rotations and forwards valid ones', () => {
    const calls: { axis: Vector; angle: number | undefined }[] = [];
    const camera = {
      rotate: (axis: Vector, angle?: number) => {
        calls.push({ axis, angle });
      },
    };

    expect(guardDegenerateCameraRotation(camera)).toBe(true);

    camera.rotate(vector(0, 0, 0), 1);
    camera.rotate(vector(1, 0, 0), Number.NaN);

    expect(calls).toHaveLength(0);

    camera.rotate(vector(0, 0, 1), 0.5);
    expect(calls).toEqual([{ axis: vector(0, 0, 1), angle: 0.5 }]);
  });

  it('reports false when the camera has no rotate function', () => {
    expect(guardDegenerateCameraRotation(undefined)).toBe(false);
    expect(guardDegenerateCameraRotation({} as never)).toBe(false);
  });
});

describe('guardCameraPose', () => {
  it('restores the last finite pose at the start of a frame', () => {
    const camera = createCamera();
    const { scene, firePreUpdate, listenerCount } = createScene();
    const guard = guardCameraPose(camera, scene);

    expect(guard.getRecoveryCount()).toBe(0);
    expect(listenerCount()).toBe(1);

    camera.position.x = Number.NaN;
    camera.direction.y = Number.NaN;
    firePreUpdate();

    expect(camera.position).toEqual(vector(1, 2, 3));
    expect(camera.direction).toEqual(vector(1, 0, 0));
    expect(guard.getRecoveryCount()).toBe(1);

    guard.dispose();
    expect(listenerCount()).toBe(0);
    firePreUpdate();
    expect(guard.getRecoveryCount()).toBe(1);
  });

  it('keeps the previous pose object identity so Cesium references stay valid', () => {
    const camera = createCamera();
    const { scene, firePreUpdate } = createScene();
    const guard = guardCameraPose(camera, scene);
    const position = camera.position;

    camera.up.x = Number.POSITIVE_INFINITY;
    firePreUpdate();

    expect(camera.position).toBe(position);
    expect(camera.up).toEqual(vector(0, 0, 1));
    guard.dispose();
  });

  it('recovers from a controller update that throws on a corrupted pose', () => {
    const camera = createCamera();
    const { scene, controller, listenerCount } = createScene();
    const throwingUpdate = () => {
      camera.position.z = Number.NaN;
      throw new RangeError('frustumCommandsList.length = NaN');
    };
    controller.update = throwingUpdate;

    const guard = guardCameraPose(camera, scene);
    expect(controller.update).not.toBe(throwingUpdate);
    expect(listenerCount()).toBe(1);

    expect(() => {
      controller.update();
    }).not.toThrow();
    expect(camera.position).toEqual(vector(1, 2, 3));
    expect(guard.getRecoveryCount()).toBe(1);

    guard.dispose();
    expect(controller.update).toBe(throwingUpdate);
  });

  it('rethrows a controller failure that did not corrupt the pose', () => {
    const camera = createCamera();
    const { scene, controller } = createScene();
    controller.update = () => {
      throw new RangeError('unrelated failure');
    };

    const guard = guardCameraPose(camera, scene);
    expect(() => {
      controller.update();
    }).toThrow('unrelated failure');
    expect(guard.getRecoveryCount()).toBe(0);
    guard.dispose();
  });

  it('returns an inert guard when the camera has no usable pose', () => {
    const { scene, controller } = createScene();
    const guard = guardCameraPose(undefined, scene);

    expect(guard.getRecoveryCount()).toBe(0);
    expect(() => {
      guard.dispose();
    }).not.toThrow();
    expect(controller.update).toBeTypeOf('function');
  });
});
