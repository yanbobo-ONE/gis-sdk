import { describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  function EllipsoidTerrainProvider() {
    return undefined;
  }
  const fromUrl = vi.fn();
  const CesiumTerrainProvider = { fromUrl };

  return { CesiumTerrainProvider, EllipsoidTerrainProvider, fromUrl };
});

vi.mock('cesium', () => ({
  CesiumTerrainProvider: cesium.CesiumTerrainProvider,
  EllipsoidTerrainProvider: cesium.EllipsoidTerrainProvider,
}));

import { CesiumTerrainController } from '../src/cesium/terrain-controller.js';
import type { CesiumTerrainSampler } from '../src/cesium/terrain-sampling.js';

function createSampler() {
  return {
    cacheSize: 0,
    clearCache: vi.fn(),
    dispose: vi.fn(),
    sample: vi.fn(() => Promise.resolve([])),
  } as unknown as CesiumTerrainSampler;
}

describe('CesiumTerrainController', () => {
  it('only installs successfully resolved terrain and can reset to ellipsoid', async () => {
    const previous = { id: 'previous' };
    const provider = { id: 'terrain' };
    const viewer = { terrainProvider: previous };
    cesium.fromUrl.mockResolvedValueOnce(provider);
    const controller = new CesiumTerrainController(viewer as never, createSampler());

    await controller.set({ type: 'cesium-terrain', url: '/terrain/' });

    expect(cesium.fromUrl).toHaveBeenCalledWith('/terrain/', {});
    expect(viewer.terrainProvider).toBe(provider);
    expect(controller.type).toBe('cesium-terrain');

    await controller.set({ type: 'ellipsoid' });
    expect(viewer.terrainProvider).toBeInstanceOf(cesium.EllipsoidTerrainProvider);
    expect(controller.type).toBe('ellipsoid');
  });

  it('keeps the old terrain when a remote provider fails to load', async () => {
    const previous = { id: 'previous' };
    const viewer = { terrainProvider: previous };
    cesium.fromUrl.mockRejectedValueOnce(new Error('offline'));
    const controller = new CesiumTerrainController(viewer as never, createSampler());

    await expect(
      controller.set({ type: 'cesium-terrain', url: '/terrain/' }),
    ).rejects.toMatchObject({
      code: 'TERRAIN_LOAD_FAILED',
    });
    expect(viewer.terrainProvider).toBe(previous);
    expect(controller.type).toBe('ellipsoid');
  });

  it('fails with a retryable error when terrain metadata never responds', async () => {
    vi.useFakeTimers();
    try {
      const previous = { id: 'previous' };
      const viewer = { terrainProvider: previous };
      cesium.fromUrl.mockReturnValueOnce(new Promise(() => undefined));
      const controller = new CesiumTerrainController(viewer as never, createSampler());

      const observed = controller
        .set({ type: 'cesium-terrain', url: '/terrain/' }, { timeoutMs: 1000 })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);

      await expect(observed).resolves.toMatchObject({
        code: 'TERRAIN_LOAD_FAILED',
        retryable: true,
      });
      expect(viewer.terrainProvider).toBe(previous);
      expect(controller.type).toBe('ellipsoid');

      // 超时释放切换状态，不会留下永久 TERRAIN_BUSY。
      const provider = { id: 'terrain' };
      cesium.fromUrl.mockResolvedValueOnce(provider);
      await expect(
        controller.set({ type: 'cesium-terrain', url: '/terrain/' }),
      ).resolves.toBeUndefined();
      expect(viewer.terrainProvider).toBe(provider);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an invalid timeout without starting a request', async () => {
    const viewer = { terrainProvider: { id: 'previous' } };
    const controller = new CesiumTerrainController(viewer as never, createSampler());
    cesium.fromUrl.mockClear();

    await expect(
      controller.set({ type: 'cesium-terrain', url: '/terrain/' }, { timeoutMs: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_TERRAIN_CONFIG' });
    expect(cesium.fromUrl).not.toHaveBeenCalled();
  });
});
