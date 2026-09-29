import { describe, expect, it, vi } from 'vitest';

import { LoadLimiter } from '../src/cesium/load-limiter.js';
import { CesiumQualityController } from '../src/cesium/quality-controller.js';
import { qualityProfiles } from '../src/core/quality.js';
import type { RenderQuality } from '../src/core/quality.js';

function createView() {
  const preUpdate = new Set<() => void>();
  const postRender = new Set<() => void>();
  const requestRender = vi.fn();
  const view = {
    resolutionScale: 1,
    scene: {
      globe: { maximumScreenSpaceError: 16 },
      preUpdate: {
        addEventListener: (listener: () => void) => {
          preUpdate.add(listener);
          return () => preUpdate.delete(listener);
        },
      },
      postRender: {
        addEventListener: (listener: () => void) => {
          postRender.add(listener);
          return () => postRender.delete(listener);
        },
      },
      requestRender,
    },
  };
  return {
    view,
    requestRender,
    /** 模拟一次"场景更新 + 渲染"，按 Cesium 的 preUpdate/postRender 顺序触发监听。 */
    frame: () => {
      for (const listener of [...preUpdate]) listener();
      for (const listener of [...postRender]) listener();
    },
    listenerCount: () => preUpdate.size + postRender.size,
  };
}

function createController(initial: RenderQuality, concurrency = 4) {
  const harness = createView();
  let now = 0;
  const limiter = new LoadLimiter(concurrency);
  const controller = new CesiumQualityController({
    viewer: harness.view,
    limiter,
    initial,
    adaptive: true,
    now: () => now,
    bounds: {
      resolutionScale: [0.5, 2],
      terrainSse: [1, 16],
      modelLoadConcurrency: [1, 16],
    },
  });
  return {
    controller,
    limiter,
    harness,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('CesiumQualityController', () => {
  it('applies the initial quality to the viewer, globe, and model limiter', () => {
    const { controller, limiter } = createController(qualityProfiles.default);

    expect(controller.current).toEqual(qualityProfiles.default);
    expect(limiter.concurrencyLimit).toBe(4);
    expect(controller.snapshot.adaptive).toBe(true);
  });

  it('drives the render parameters from frame samples while started', () => {
    const { controller, harness, advance } = createController({
      resolutionScale: 1,
      terrainSse: 2,
      modelLoadConcurrency: 4,
    });
    controller.start();
    expect(harness.listenerCount()).toBe(2);

    // 50ms/帧 ≈ 20fps，持续低于 30fps 目标。
    for (let index = 0; index < 40; index += 1) {
      advance(50);
      harness.frame();
    }

    expect(controller.current.resolutionScale).toBeLessThan(1);
    expect(controller.current.terrainSse).toBeGreaterThan(2);
    expect(controller.snapshot.degraded).toBe(true);
    expect(harness.view.resolutionScale).toBe(controller.current.resolutionScale);
    expect(harness.view.scene.globe.maximumScreenSpaceError).toBe(controller.current.terrainSse);

    controller.dispose();
    expect(harness.listenerCount()).toBe(0);

    // 释放后继续跑帧不会再改动参数。
    const frozen = controller.current;
    for (let index = 0; index < 40; index += 1) {
      advance(200);
      harness.frame();
    }
    expect(controller.current).toEqual(frozen);
  });

  it('applies profiles and manual overrides, and stops adapting afterwards', () => {
    const { controller, harness, limiter, advance } = createController(qualityProfiles.default);

    controller.setProfile('low');
    expect(controller.current).toEqual(qualityProfiles.low);
    expect(harness.requestRender).toHaveBeenCalled();
    expect(controller.snapshot.adaptive).toBe(false);

    controller.set({ resolutionScale: 0.6, modelLoadConcurrency: 6 });
    expect(controller.current).toEqual({
      resolutionScale: 0.6,
      terrainSse: qualityProfiles.low.terrainSse,
      modelLoadConcurrency: 6,
    });
    // 画质参数写入模型限流器后，排队中的模型加载立即获得更多配额。
    expect(limiter.concurrencyLimit).toBe(6);

    expect(() => {
      controller.set({ resolutionScale: 5 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_QUALITY_CONFIG' }));
    expect(() => {
      controller.setProfile('unknown' as never);
    }).toThrow(expect.objectContaining({ code: 'INVALID_QUALITY_CONFIG' }));

    controller.setAdaptive(true);
    expect(controller.snapshot.adaptive).toBe(true);

    // 手动设置过参数之后，即使重新开启自动画质，帧采样也不会让参数越出手动值的上下界。
    controller.set({ resolutionScale: 0.6 });
    controller.setAdaptive(true);
    for (let index = 0; index < 20; index += 1) {
      advance(50);
      harness.frame();
    }
    expect(controller.current.resolutionScale).toBeLessThanOrEqual(0.6);
  });
});
