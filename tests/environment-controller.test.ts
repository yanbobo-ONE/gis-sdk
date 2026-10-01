import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const createColor = (red: number, green: number, blue: number, alpha = 1) => ({
    red,
    green,
    blue,
    alpha,
  });
  const stages: FakeStage[] = [];
  const removed: FakeStage[] = [];
  class FakeStage {
    enabled = false;
    readonly destroy = vi.fn();
    readonly options: Record<string, unknown>;
    uniforms: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.uniforms = { ...(options.uniforms as Record<string, unknown>) };
      stages.push(this);
    }
  }
  return { createColor, FakeStage, removed, stages };
});

type FakeStage = InstanceType<typeof cesium.FakeStage>;

vi.mock('cesium', () => ({
  Color: {
    WHITE: { red: 1, green: 1, blue: 1, alpha: 1 },
    fromCssColorString: (value: string) =>
      value === '#9fb6c8' ? { red: 0.62, green: 0.72, blue: 0.78, alpha: 1 } : undefined,
  },
  PostProcessStage: cesium.FakeStage,
  PostProcessStageSampleMode: { NEAREST: 0, LINEAR: 1 },
  SceneMode: { SCENE2D: 2, SCENE3D: 3 },
}));

import { CesiumEnvironmentController } from '../src/cesium/environment-controller.js';

function createHarness(options: { mode?: number; fog?: Record<string, unknown> | undefined } = {}) {
  const frameListeners = new Set<() => void>();
  const stageCollection = {
    add: vi.fn<(stage: unknown) => unknown>((stage) => stage),
    remove: vi.fn<(stage: unknown) => boolean>((stage) => {
      const target = stage as FakeStage;
      cesium.removed.push(target);
      target.destroy();
      return true;
    }),
  };
  const scene = {
    mode: options.mode ?? 3,
    camera: { positionCartographic: { height: 5_000 } },
    fog: 'fog' in options ? options.fog : { enabled: false, density: 6e-4, maxHeight: 800_000 },
    drawingBufferWidth: 1_600,
    drawingBufferHeight: 800,
    postProcessStages: stageCollection,
    preRender: {
      addEventListener: vi.fn((listener: () => void) => {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      }),
    },
    requestRender: vi.fn(),
  };
  let now = 0;
  const controller = new CesiumEnvironmentController({ scene }, () => now);
  return {
    controller,
    scene,
    stageCollection,
    stages: cesium.stages,
    removed: cesium.removed,
    frame: () => {
      now += 16;
      for (const listener of [...frameListeners]) {
        listener();
      }
    },
    frameListenerCount: () => frameListeners.size,
  };
}

describe('CesiumEnvironmentController', () => {
  beforeEach(() => {
    cesium.stages.length = 0;
    cesium.removed.length = 0;
  });

  it('applies depth fog through a post-process stage', () => {
    const harness = createHarness();

    const state = harness.controller.set('depthFog', { density: 0.6, color: '#9fb6c8' });

    expect(state).toEqual({
      kind: 'depthFog',
      enabled: true,
      options: expect.objectContaining({ density: 0.6, color: '#9fb6c8' }) as unknown,
    });
    expect(harness.stages).toHaveLength(1);
    const stage = harness.stages[0];
    expect(stage?.options.name).toBe('GisSdkDepthFog');
    expect(stage?.enabled).toBe(true);
    expect(stage?.uniforms.uDensity).toBe(0.6);
    expect(stage?.uniforms.uColor).toEqual({ red: 0.62, green: 0.72, blue: 0.78, alpha: 1 });
    expect(stage?.uniforms.uStrength).toBe(1);
    expect(stage?.uniforms.uCameraHeight).toBe(5_000);
    expect(harness.controller.active).toEqual([state]);
  });

  it('rejects a color that is not a CSS color and keeps the old stage', () => {
    const harness = createHarness();
    harness.controller.set('depthFog');

    expect(() => harness.controller.set('depthFog', { color: 'not-a-color' })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
    expect(harness.stages).toHaveLength(1);
  });

  it('keeps one depth fog stage across updates and disables it in 2D', () => {
    const harness = createHarness();
    harness.controller.set('depthFog', { density: 0.4 });
    harness.controller.set('depthFog', { density: 0.5 });
    expect(harness.stages).toHaveLength(1);
    expect(harness.stages[0]?.uniforms.uDensity).toBe(0.5);

    harness.controller.setEnabled('depthFog', false);
    expect(harness.stages[0]?.enabled).toBe(false);
    expect(harness.stages[0]?.uniforms.uStrength).toBe(0);

    harness.controller.clear('depthFog');
    expect(harness.removed).toHaveLength(1);
    expect(harness.controller.active).toEqual([]);
  });

  it('reports 2D degradation for depth fog', () => {
    const harness = createHarness({ mode: 2 });

    const state = harness.controller.set('depthFog');

    expect(state.degraded).toBeDefined();
    expect(harness.stages[0]?.uniforms.uStrength).toBe(0);
    expect(harness.stages[0]?.enabled).toBe(true);
  });

  it('drives rain and snow through one shared stage', () => {
    const harness = createHarness();

    const rain = harness.controller.set('rain', {
      intensity: 'heavy',
      windDirection: 90,
      windStrength: 0.5,
    });
    expect(rain.kind).toBe('rain');
    const stage = harness.stages[0];
    expect(stage?.options.name).toBe('GisSdkPrecipitation');
    expect(stage?.options.sampleMode).toBe(0);
    expect(stage?.options.textureScale).toBe(0.5);
    expect(stage?.uniforms.uSnow).toBe(0);
    expect(stage?.uniforms.uDensity).toBeCloseTo(1.7, 9);
    expect(stage?.uniforms.uAspect).toBeCloseTo(2, 9);
    expect(stage?.uniforms.uWindEnu).toEqual({ x: 10, y: expect.closeTo(0, 9) as number, z: 0 });

    // 换成雪：同一个阶段，权重翻转，雨的状态被替换。
    const snow = harness.controller.set('snow');
    expect(harness.stages).toHaveLength(1);
    expect(snow.kind).toBe('snow');
    expect(stage?.uniforms.uSnow).toBe(1);
    expect(harness.controller.active.map((effect) => effect.kind)).toEqual(['snow']);
  });

  it('advances precipitation animation time with bounded steps', () => {
    const harness = createHarness();
    harness.controller.set('rain');
    const stage = harness.stages[0];
    expect(stage?.uniforms.uTime).toBe(0);

    // 第一次采样只做起点对齐，之后每帧按真实间隔推进。
    harness.frame();
    harness.frame();
    harness.frame();

    expect(stage?.uniforms.uTime).toBeCloseTo(0.032, 6);
    expect(harness.scene.requestRender).toHaveBeenCalled();
  });

  it('does not request frames when precipitation is disabled', () => {
    const harness = createHarness();
    harness.controller.set('rain');
    harness.controller.setEnabled('rain', false);
    harness.scene.requestRender.mockClear();

    harness.frame();

    expect(harness.stages[0]?.uniforms.uOpacity).toBe(0);
    expect(harness.scene.requestRender).not.toHaveBeenCalled();
  });

  it('writes only the declared fields for haze and restores them on clear', () => {
    const harness = createHarness();
    const fog = harness.scene.fog;

    harness.controller.set('haze', { density: 0.001, brightnessFloor: 0.1 });

    expect(fog).toMatchObject({
      enabled: true,
      density: 0.001,
      minimumBrightness: 0.1,
      maxHeight: 800_000,
    });
    expect(harness.scene.requestRender).toHaveBeenCalled();

    harness.controller.setEnabled('haze', false);
    expect(fog).toMatchObject({ enabled: false, density: 0.001 });

    harness.controller.clear('haze');
    expect(fog).toEqual({ enabled: false, density: 6e-4, maxHeight: 800_000 });
  });

  it('reports UNSUPPORTED when the scene has no fog object', () => {
    const harness = createHarness({ fog: undefined });

    expect(() => harness.controller.set('haze', { density: 0.001 })).toThrow(
      expect.objectContaining({ code: 'ENVIRONMENT_UNSUPPORTED' }),
    );
  });

  it('clears everything and stops touching the scene after destroy', () => {
    const harness = createHarness();
    harness.controller.set('depthFog');
    harness.controller.set('rain');
    harness.controller.set('haze', { density: 0.002 });

    harness.controller.destroy();

    expect(harness.removed).toHaveLength(2);
    expect(harness.controller.active).toEqual([]);
    expect(harness.frameListenerCount()).toBe(0);
    expect(harness.scene.fog).toMatchObject({ density: 6e-4 });
    expect(() => harness.controller.set('rain')).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED' }),
    );
    // 重复销毁不会重复移除。
    harness.controller.destroy();
    expect(harness.removed).toHaveLength(2);
  });

  it('destroys a stage itself when the collection no longer owns it', () => {
    const harness = createHarness();
    harness.controller.set('depthFog');
    const stage = harness.stages[0];
    harness.stageCollection.remove.mockReturnValue(false);

    harness.controller.clear('depthFog');

    expect(stage?.destroy).toHaveBeenCalledOnce();
  });
});
