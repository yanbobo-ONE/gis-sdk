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

  it('resolves ready immediately when no initial terrain was declared', async () => {
    const controller = new CesiumTerrainController(
      { terrainProvider: { id: 'previous' } } as never,
      createSampler(),
    );
    cesium.fromUrl.mockClear();

    expect(controller.pending).toBe(false);
    await expect(controller.ready).resolves.toBeUndefined();
    expect(controller.type).toBe('ellipsoid');
    expect(cesium.fromUrl).not.toHaveBeenCalled();
  });

  it('installs the initial terrain declared at construction and settles ready once', async () => {
    const provider = { id: 'terrain' };
    const viewer = { terrainProvider: { id: 'previous' } };
    cesium.fromUrl.mockResolvedValueOnce(provider);

    const controller = new CesiumTerrainController(viewer as never, createSampler(), {
      type: 'cesium-terrain',
      url: ' /terrain/ ',
    });

    expect(controller.pending).toBe(true);
    expect(controller.type).toBe('ellipsoid');

    await expect(controller.ready).resolves.toBeUndefined();

    expect(cesium.fromUrl).toHaveBeenCalledWith('/terrain/', {});
    expect(viewer.terrainProvider).toBe(provider);
    expect(controller.type).toBe('cesium-terrain');
    expect(controller.pending).toBe(false);
    // ready 是稳定的同一个 Promise：重复读取不会重新发起请求。
    expect(controller.ready).toBe(controller.ready);
  });

  it('applies an initial ellipsoid terrain without any request', async () => {
    const controller = new CesiumTerrainController(
      { terrainProvider: { id: 'previous' } } as never,
      createSampler(),
      { type: 'ellipsoid' },
    );
    cesium.fromUrl.mockClear();

    await expect(controller.ready).resolves.toBeUndefined();
    expect(controller.type).toBe('ellipsoid');
    expect(controller.pending).toBe(false);
    expect(cesium.fromUrl).not.toHaveBeenCalled();
  });

  it('keeps ellipsoid, rejects ready, and reports once when the initial terrain fails', async () => {
    const previous = { id: 'previous' };
    const viewer = { terrainProvider: previous };
    cesium.fromUrl.mockRejectedValueOnce(new Error('offline'));

    const controller = new CesiumTerrainController(viewer as never, createSampler(), {
      type: 'cesium-terrain',
      url: '/terrain/',
    });
    const reported: { code: string }[] = [];
    // 与 CesiumMapAdapter 一致：上报器在构造之后、网络回调之前同步挂载。
    controller.setErrorReporter((error) => reported.push(error));

    // 只走 ready 拒绝这一条通道时，失败仍必须可见且不产生未处理拒绝（vitest 会因此报错）。
    await expect(controller.ready).rejects.toMatchObject({
      code: 'TERRAIN_LOAD_FAILED',
      retryable: true,
    });

    expect(viewer.terrainProvider).toBe(previous);
    expect(controller.type).toBe('ellipsoid');
    expect(controller.pending).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ code: 'TERRAIN_LOAD_FAILED', retryable: true });

    // 失败后可立即重试，不会留下永久 TERRAIN_BUSY。
    const provider = { id: 'terrain' };
    cesium.fromUrl.mockResolvedValueOnce(provider);
    await expect(
      controller.set({ type: 'cesium-terrain', url: '/terrain/' }),
    ).resolves.toBeUndefined();
    expect(viewer.terrainProvider).toBe(provider);
  });

  it('rejects set() with TERRAIN_BUSY while the initial terrain is still loading', async () => {
    const viewer = { terrainProvider: { id: 'previous' } };
    let resolveTerrain: ((provider: unknown) => void) | undefined;
    cesium.fromUrl.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTerrain = resolve;
      }),
    );

    const controller = new CesiumTerrainController(viewer as never, createSampler(), {
      type: 'cesium-terrain',
      url: '/terrain/',
    });

    await expect(controller.set({ type: 'ellipsoid' })).rejects.toMatchObject({
      code: 'TERRAIN_BUSY',
      retryable: true,
    });

    resolveTerrain?.({ id: 'terrain' });
    await expect(controller.ready).resolves.toBeUndefined();
    expect(controller.type).toBe('cesium-terrain');

    await expect(controller.set({ type: 'ellipsoid' })).resolves.toBeUndefined();
    expect(controller.type).toBe('ellipsoid');
  });
});
