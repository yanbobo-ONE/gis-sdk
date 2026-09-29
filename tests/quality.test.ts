import { describe, expect, it } from 'vitest';

import {
  isQualityProfileId,
  qualityProfiles,
  RenderQualityMonitor,
  resolveRenderQuality,
  validateRenderQuality,
} from '../src/core/quality.js';
import type { RenderQuality } from '../src/core/quality.js';

const initial: RenderQuality = {
  resolutionScale: 1,
  terrainSse: 2,
  modelLoadConcurrency: 4,
};

const wideBounds = {
  resolutionScale: [0.5, 2] as const,
  terrainSse: [1, 12] as const,
  modelLoadConcurrency: [2, 16] as const,
};

/** 以固定帧间隔喂入 `count` 帧，返回最后一次快照。 */
function feed(
  monitor: RenderQualityMonitor,
  frameTimeMs: number,
  count: number,
  startAt = 0,
  continuousRendering = true,
) {
  let snapshot = monitor.getSnapshot();
  for (let index = 0; index <= count; index += 1) {
    snapshot = monitor.sample(startAt + index * frameTimeMs, continuousRendering);
  }
  return snapshot;
}

describe('render quality profiles', () => {
  it('keeps the Cesium defaults in the default profile and mirrors proven presets', () => {
    expect(qualityProfiles.default).toEqual(initial);
    expect(qualityProfiles.quality).toEqual({
      resolutionScale: 1.5,
      terrainSse: 2,
      modelLoadConcurrency: 8,
    });
    expect(qualityProfiles.low).toEqual({
      resolutionScale: 0.75,
      terrainSse: 12,
      modelLoadConcurrency: 2,
    });
    expect(isQualityProfileId('balanced')).toBe(true);
    expect(isQualityProfileId('unknown')).toBe(false);
  });

  it('merges profile overrides and rejects unknown profiles or invalid values', () => {
    expect(resolveRenderQuality('low', { modelLoadConcurrency: 6 })).toEqual({
      resolutionScale: 0.75,
      terrainSse: 12,
      modelLoadConcurrency: 6,
    });
    expect(Object.isFrozen(resolveRenderQuality('balanced'))).toBe(true);

    expect(() => resolveRenderQuality('nope' as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_QUALITY_CONFIG' }),
    );
    for (const invalid of [
      { resolutionScale: 0.4 },
      { terrainSse: 65 },
      { modelLoadConcurrency: 0 },
      { modelLoadConcurrency: 2.5 },
    ]) {
      expect(() => resolveRenderQuality('default', invalid)).toThrow(
        expect.objectContaining({ code: 'INVALID_QUALITY_CONFIG' }),
      );
    }
    expect(() => {
      validateRenderQuality(initial);
    }).not.toThrow();
  });
});

describe('RenderQualityMonitor', () => {
  it('reports frame rate only after two timestamps and ignores invalid ones', () => {
    const monitor = new RenderQualityMonitor({ initial });

    expect(monitor.sample(Number.NaN).fps).toBe(0);
    expect(monitor.sample(1000).fps).toBe(0);

    const snapshot = monitor.sample(1040);
    expect(snapshot.fps).toBe(25);
    expect(snapshot.frameTimeMs).toBe(40);
    expect(snapshot.degraded).toBe(false);
    expect(snapshot.adaptive).toBe(true);
  });

  it('lowers quality after sustained low frame rate and recovers gradually', () => {
    const monitor = new RenderQualityMonitor({ initial, bounds: wideBounds });

    // 50ms/帧 ≈ 20fps，低于 30fps 目标的下限。
    const degraded = feed(monitor, 50, 25);
    expect(degraded.resolutionScale).toBe(0.9);
    expect(degraded.terrainSse).toBe(3);
    expect(degraded.modelLoadConcurrency).toBe(3);
    expect(degraded.degraded).toBe(true);

    // 20ms/帧 ≈ 50fps，持续高于目标上限后回升。
    const recovered = feed(monitor, 20, 45, 10_000);
    expect(recovered.resolutionScale).toBeGreaterThan(degraded.resolutionScale);
    expect(recovered.terrainSse).toBeLessThan(degraded.terrainSse);
  });

  it('resets the window on stalls and non-continuous rendering instead of degrading', () => {
    const monitor = new RenderQualityMonitor({ initial });

    monitor.sample(0);
    monitor.sample(50);
    // 单帧超过 250ms：只在窗口里保留这一帧的瞬时帧率，不据此降档。
    const stalled = monitor.sample(600);
    expect(stalled.sampleCount).toBe(0);
    expect(stalled.fps).toBeCloseTo(1000 / 550);
    expect(stalled.resolutionScale).toBe(1);

    // 非连续渲染（例如标签页恢复）同样只记录瞬时帧率。
    monitor.sample(650, false);
    const idle = monitor.sample(700, false);
    expect(idle.sampleCount).toBe(0);
    expect(idle.resolutionScale).toBe(1);
    expect(idle.frameTimeMs).toBe(50);
  });

  it('stops adapting when disabled and when quality is set manually', () => {
    const monitor = new RenderQualityMonitor({ initial, bounds: wideBounds });

    monitor.setAdaptive(false);
    feed(monitor, 50, 40);
    expect(monitor.getSnapshot().resolutionScale).toBe(1);
    expect(monitor.getSnapshot().adaptive).toBe(false);

    const manual = monitor.setQuality({ resolutionScale: 0.8, terrainSse: 6 });
    expect(manual).toMatchObject({
      resolutionScale: 0.8,
      terrainSse: 6,
      modelLoadConcurrency: 4,
      adaptive: false,
    });

    feed(monitor, 20, 60, 20_000);
    expect(monitor.current.resolutionScale).toBe(0.8);

    expect(() => monitor.setQuality({ resolutionScale: 3 })).toThrow(
      expect.objectContaining({ code: 'INVALID_QUALITY_CONFIG' }),
    );
    expect(monitor.current.resolutionScale).toBe(0.8);
  });

  it('never lowers a parameter below its bound', () => {
    const monitor = new RenderQualityMonitor({
      initial,
      bounds: { ...wideBounds, resolutionScale: [0.95, 1], modelLoadConcurrency: [3, 4] },
    });

    feed(monitor, 50, 25);
    expect(monitor.current.resolutionScale).toBe(0.95);
    expect(monitor.current.modelLoadConcurrency).toBe(3);

    feed(monitor, 50, 60, 60_000);
    expect(monitor.current.resolutionScale).toBe(0.95);
    expect(monitor.current.modelLoadConcurrency).toBe(3);
  });
});
