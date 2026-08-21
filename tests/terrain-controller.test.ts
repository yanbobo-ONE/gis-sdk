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

describe('CesiumTerrainController', () => {
  it('only installs successfully resolved terrain and can reset to ellipsoid', async () => {
    const previous = { id: 'previous' };
    const provider = { id: 'terrain' };
    const viewer = { terrainProvider: previous };
    cesium.fromUrl.mockResolvedValueOnce(provider);
    const controller = new CesiumTerrainController(viewer as never);

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
    const controller = new CesiumTerrainController(viewer as never);

    await expect(
      controller.set({ type: 'cesium-terrain', url: '/terrain/' }),
    ).rejects.toMatchObject({
      code: 'TERRAIN_LOAD_FAILED',
    });
    expect(viewer.terrainProvider).toBe(previous);
    expect(controller.type).toBe('ellipsoid');
  });
});
