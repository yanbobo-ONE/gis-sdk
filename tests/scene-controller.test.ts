import { describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => ({
  SCENE2D: 2,
  SCENE3D: 3,
  MORPHING: 0,
}));

vi.mock('cesium', () => ({ SceneMode: cesium }));

import { CesiumSceneController } from '../src/cesium/scene-controller.js';

function createScene(initialMode = cesium.SCENE3D) {
  let mode = initialMode;
  const listeners = new Set<() => void>();
  const morphTo2D = vi.fn(() => {
    mode = cesium.SCENE2D;
  });
  const morphTo3D = vi.fn(() => {
    mode = cesium.SCENE3D;
  });
  return {
    scene: {
      get mode() {
        return mode;
      },
      morphTo2D,
      morphTo3D,
      morphComplete: {
        addEventListener: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    morphTo2D,
    morphTo3D,
    setMode: (next: number) => {
      mode = next;
    },
    completeMorph: () => {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('CesiumSceneController', () => {
  it('morphs to 2D and resolves when the morph completes', async () => {
    const harness = createScene();
    const controller = new CesiumSceneController(harness.scene as never);

    expect(controller.mode).toBe('3d');
    expect(controller.morphing).toBe(false);

    const pending = controller.setMode('2d', 1.5);

    expect(harness.morphTo2D).toHaveBeenCalledWith(1.5);
    expect(controller.morphing).toBe(true);
    // 形变过程中对外报告目标模式。
    expect(controller.mode).toBe('2d');
    expect(harness.listenerCount()).toBe(1);

    harness.completeMorph();

    await expect(pending).resolves.toBeUndefined();
    expect(controller.morphing).toBe(false);
    expect(harness.listenerCount()).toBe(0);
  });

  it('resolves immediately when already in the target mode', async () => {
    const harness = createScene(cesium.SCENE2D);
    const controller = new CesiumSceneController(harness.scene as never);

    await expect(controller.setMode('2d')).resolves.toBeUndefined();
    expect(harness.morphTo2D).not.toHaveBeenCalled();
    expect(harness.morphTo3D).not.toHaveBeenCalled();
  });

  it('rejects the superseded morph when a new mode change starts', async () => {
    const harness = createScene();
    const controller = new CesiumSceneController(harness.scene as never);

    const toTwoD = controller.setMode('2d');
    const toThreeD = controller.setMode('3d', 0);

    await expect(toTwoD).rejects.toMatchObject({
      code: 'SCENE_MORPH_SUPERSEDED',
      retryable: true,
    });
    expect(harness.morphTo3D).toHaveBeenCalledWith(0);

    harness.completeMorph();
    await expect(toThreeD).resolves.toBeUndefined();
    expect(harness.listenerCount()).toBe(0);
  });

  it('rejects pending morphs on destroy and refuses further calls', async () => {
    const harness = createScene();
    const controller = new CesiumSceneController(harness.scene as never);

    const pending = controller.setMode('2d');
    controller.destroy();

    await expect(pending).rejects.toMatchObject({ code: 'MAP_DISPOSED' });
    expect(harness.listenerCount()).toBe(0);
    await expect(controller.setMode('3d')).rejects.toMatchObject({ code: 'MAP_DISPOSED' });
  });

  it('rejects invalid modes and durations', async () => {
    const harness = createScene();
    const controller = new CesiumSceneController(harness.scene as never);

    await expect(controller.setMode('columbus' as never)).rejects.toMatchObject({
      code: 'INVALID_SCENE_CONFIG',
    });
    await expect(controller.setMode('2d', -1)).rejects.toMatchObject({
      code: 'INVALID_SCENE_CONFIG',
    });
    await expect(controller.setMode('2d', Number.NaN)).rejects.toMatchObject({
      code: 'INVALID_SCENE_CONFIG',
    });
    expect(harness.morphTo2D).not.toHaveBeenCalled();
  });
});
