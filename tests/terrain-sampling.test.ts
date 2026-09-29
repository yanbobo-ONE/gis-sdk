import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const fromDegrees = vi.fn((longitude: number, latitude: number) => ({
    longitude,
    latitude,
    height: undefined as number | undefined,
  }));
  return {
    Cartographic: { fromDegrees },
    sampleTerrain: vi.fn(),
    sampleTerrainMostDetailed: vi.fn(),
    fromDegrees,
  };
});

vi.mock('cesium', () => ({
  Cartographic: cesium.Cartographic,
  sampleTerrain: cesium.sampleTerrain,
  sampleTerrainMostDetailed: cesium.sampleTerrainMostDetailed,
}));

import { LoadLimiter } from '../src/cesium/load-limiter.js';
import { CesiumTerrainSampler } from '../src/cesium/terrain-sampling.js';
import type { TerrainSamplePoint } from '../src/core/controls.js';

interface FakePosition {
  longitude: number;
  latitude: number;
  height: number | undefined;
}

/**
 * 用给定高度表填充被采样位置，模拟 Cesium 就地写入高度。
 *
 * 位置数组始终是最后一个参数：`sampleTerrain(provider, level, positions)` 与
 * `sampleTerrainMostDetailed(provider, positions)` 的签名不同。
 */
function heightsAt(heights: readonly (number | undefined)[]) {
  return (...args: unknown[]) => {
    const positions = args[args.length - 1] as FakePosition[];
    positions.forEach((position, index) => {
      position.height = heights[index];
    });
    return Promise.resolve(positions);
  };
}

function createViewer(provider: unknown) {
  return { scene: { globe: { terrainProvider: provider } } };
}

const provider = { availability: {}, kind: 'terrain' };
const ellipsoid = { availability: undefined, kind: 'ellipsoid' };

const points: readonly TerrainSamplePoint[] = [
  { longitude: 116.39, latitude: 39.9 },
  { longitude: 121.47, latitude: 31.23 },
];

describe('CesiumTerrainSampler', () => {
  beforeEach(() => {
    cesium.sampleTerrain.mockReset();
    cesium.sampleTerrainMostDetailed.mockReset();
    cesium.sampleTerrain.mockImplementation(heightsAt([0, 0]));
    cesium.sampleTerrainMostDetailed.mockImplementation(heightsAt([0, 0]));
    cesium.fromDegrees.mockClear();
  });

  it('prefers the most detailed strategy when the provider exposes availability', async () => {
    cesium.sampleTerrainMostDetailed.mockImplementation(heightsAt([12.5, 3]));
    const sampler = new CesiumTerrainSampler(createViewer(provider) as never, new LoadLimiter(2));

    const samples = await sampler.sample(points);

    expect(cesium.sampleTerrainMostDetailed).toHaveBeenCalledOnce();
    expect(cesium.sampleTerrain).not.toHaveBeenCalled();
    expect(samples).toEqual([
      { longitude: 116.39, latitude: 39.9, height: 12.5, status: 'ok' },
      { longitude: 121.47, latitude: 31.23, height: 3, status: 'ok' },
    ]);
  });

  it('falls back to the level strategy, marks missing heights, and honours batch size', async () => {
    // 高度按点的经度决定，使断言与分批方式无关（batchSize 为 1 时每批只有一个点）。
    cesium.sampleTerrain.mockImplementation((...args: unknown[]) => {
      const positions = args[args.length - 1] as FakePosition[];
      positions.forEach((position) => {
        position.height = position.longitude === 116.39 ? 7 : undefined;
      });
      return Promise.resolve(positions);
    });
    const sampler = new CesiumTerrainSampler(createViewer(ellipsoid) as never, new LoadLimiter(1), {
      batchSize: 1,
    });

    const samples = await sampler.sample(points, { strategy: 'most-detailed' });

    expect(cesium.sampleTerrainMostDetailed).not.toHaveBeenCalled();
    expect(cesium.sampleTerrain).toHaveBeenCalledTimes(2);
    expect(cesium.sampleTerrain).toHaveBeenCalledWith(ellipsoid, 0, expect.any(Array));
    expect(samples).toEqual([
      { longitude: 116.39, latitude: 39.9, height: 7, status: 'ok' },
      { longitude: 121.47, latitude: 31.23, height: undefined, status: 'no-data' },
    ]);
  });

  it('serves repeated positions from the cache and quantizes keys to 1e-5 degrees', async () => {
    cesium.sampleTerrainMostDetailed.mockImplementation(heightsAt([100, 200]));
    const sampler = new CesiumTerrainSampler(createViewer(provider) as never, new LoadLimiter(2));

    await sampler.sample(points);
    const warm = await sampler.sample(points);
    // 误差小于 1e-5 度（约 1 米）视为同一位置。
    const nearby = await sampler.sample([
      { longitude: 116.3900001, latitude: 39.9000001 },
      { longitude: 121.47, latitude: 31.23 },
    ]);

    expect(cesium.sampleTerrainMostDetailed).toHaveBeenCalledOnce();
    expect(warm[0]?.height).toBe(100);
    expect(nearby[0]?.height).toBe(100);
    expect(sampler.cacheSize).toBe(2);

    sampler.clearCache();
    expect(sampler.cacheSize).toBe(0);
  });

  it('limits concurrent batches across callers', async () => {
    let inFlight = 0;
    let peak = 0;
    cesium.sampleTerrainMostDetailed.mockImplementation((...args: unknown[]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const positions = args[1] as FakePosition[];
      return new Promise<FakePosition[]>((resolve) => {
        setTimeout(() => {
          positions.forEach((position) => {
            position.height = 1;
          });
          inFlight -= 1;
          resolve(positions);
        }, 0);
      });
    });
    const sampler = new CesiumTerrainSampler(createViewer(provider) as never, new LoadLimiter(1));

    await Promise.all([sampler.sample(points), sampler.sample(points.slice(0, 1))]);

    expect(peak).toBe(1);
    expect(cesium.sampleTerrainMostDetailed).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid input, missing terrain, aborts, and Cesium failures', async () => {
    const sampler = new CesiumTerrainSampler(createViewer(provider) as never, new LoadLimiter(2));

    await expect(sampler.sample([])).rejects.toMatchObject({ code: 'INVALID_TERRAIN_CONFIG' });
    await expect(
      sampler.sample(
        Array.from({ length: 2 }, () => ({ longitude: 0, latitude: 0 })),
        {
          strategy: 'level',
        },
      ),
    ).resolves.toHaveLength(2);
    await expect(sampler.sample([{ longitude: 181, latitude: 0 }])).rejects.toMatchObject({
      code: 'INVALID_COORDINATES',
    });
    await expect(sampler.sample([{ longitude: Number.NaN, latitude: 0 }])).rejects.toMatchObject({
      code: 'INVALID_COORDINATES',
    });

    const controller = new AbortController();
    controller.abort('route changed');
    await expect(sampler.sample(points, { signal: controller.signal })).rejects.toMatchObject({
      code: 'TERRAIN_SAMPLING_ABORTED',
    });

    const noTerrain = new CesiumTerrainSampler(
      createViewer(undefined) as never,
      new LoadLimiter(2),
    );
    await expect(noTerrain.sample(points)).rejects.toMatchObject({
      code: 'TERRAIN_SAMPLING_UNAVAILABLE',
    });

    cesium.sampleTerrainMostDetailed.mockRejectedValueOnce(new Error('tile unavailable'));
    await expect(sampler.sample(points)).rejects.toMatchObject({
      code: 'TERRAIN_SAMPLING_FAILED',
      retryable: true,
    });
  });

  it('stops a batch that resolves after the caller aborted', async () => {
    const controller = new AbortController();
    cesium.sampleTerrainMostDetailed.mockImplementation((...args: unknown[]) => {
      const positions = args[1] as FakePosition[];
      return new Promise<FakePosition[]>((resolve) => {
        setTimeout(() => {
          positions.forEach((position) => {
            position.height = 1;
          });
          resolve(positions);
        }, 0);
      });
    });
    const sampler = new CesiumTerrainSampler(createViewer(provider) as never, new LoadLimiter(1));
    const pending = sampler.sample(points, { signal: controller.signal });

    controller.abort('map destroyed');

    await expect(pending).rejects.toMatchObject({ code: 'TERRAIN_SAMPLING_ABORTED' });
    expect(sampler.cacheSize).toBe(0);
  });

  it('rejects sampling after dispose', async () => {
    const sampler = new CesiumTerrainSampler(createViewer(provider) as never, new LoadLimiter(2));
    sampler.dispose();

    await expect(sampler.sample(points)).rejects.toMatchObject({ code: 'TERRAIN_DISPOSED' });
  });
});
