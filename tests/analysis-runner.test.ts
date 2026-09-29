import { describe, expect, it, vi } from 'vitest';

import { createAnalysisController } from '../src/core/analysis-runner.js';
import type { AnalysisTerrainPort } from '../src/core/analysis-runner.js';
import type { TerrainSample, TerrainSamplePoint } from '../src/core/controls.js';
import { measureDistance } from '../src/spatial/measure.js';
import { SPATIAL_ALGORITHM_VERSION } from '../src/spatial/types.js';

/** 米/度（经度，赤道附近），用于把经纬偏移换算成米。 */
const METERS_PER_DEGREE = (2 * Math.PI * 6_371_008.8) / 360;

interface TerrainOptions {
  /** 地形高度函数，返回 `undefined` 表示该点没有数据。 */
  readonly heightAt?: (point: TerrainSamplePoint) => number | undefined;
}

function createPort(options: TerrainOptions = {}): AnalysisTerrainPort & { readonly calls: number } {
  const heightAt = options.heightAt ?? (() => 0);
  const port: AnalysisTerrainPort & { calls: number } = {
    calls: 0,
    sample: vi.fn((points: readonly TerrainSamplePoint[]) => {
      port.calls += 1;
      return Promise.resolve(
        points.map((point): TerrainSample => {
          const height = heightAt(point);
          return height === undefined
            ? { longitude: point.longitude, latitude: point.latitude, height: undefined, status: 'no-data' }
            : { longitude: point.longitude, latitude: point.latitude, height, status: 'ok' };
        }),
      );
    }),
  };
  return port;
}

/** 沿经线在经度 0.5 度处隆起一道山脊。 */
const ridgePort = (ridgeHeightMeters: number, widthDegrees = 0.05) =>
  createPort({
    heightAt: ({ longitude }) =>
      ridgeHeightMeters * Math.exp(-((longitude - 0.5) ** 2) / (2 * widthDegrees ** 2)),
  });

describe('createAnalysisController', () => {
  it('lists every builtin tool', () => {
    const controller = createAnalysisController(createPort());
    const ids = controller.list().map((tool) => tool.id);

    expect(ids).toHaveLength(13);
    expect(ids).toContain('line-of-sight');
    expect(controller.list().every((tool) => tool.source === 'builtin')).toBe(true);
  });

  it('runs tools that need no terrain', async () => {
    const controller = createAnalysisController(createPort());

    const distance = await controller.run('distance', {
      from: { longitude: 0, latitude: 0 },
      to: { longitude: 0.01, latitude: 0 },
      units: 'kilometers',
    });
    expect(distance.unit).toBe('kilometers');
    expect(distance.meters).toBeCloseTo(1111.95, 1);
    expect(distance.algorithmVersion).toBe(SPATIAL_ALGORITHM_VERSION);

    await expect(
      controller.run('bearing', { from: { longitude: 0, latitude: 0 }, to: { longitude: 0, latitude: 1 } }),
    ).resolves.toMatchObject({ degrees: 0 });

    await expect(
      controller.run('area', {
        polygon: [
          { longitude: 0, latitude: 0 },
          { longitude: 0.01, latitude: 0 },
          { longitude: 0.01, latitude: 0.01 },
          { longitude: 0, latitude: 0.01 },
        ],
      }),
    ).resolves.toMatchObject({ algorithmVersion: SPATIAL_ALGORITHM_VERSION });

    await expect(
      controller.run('bbox', { input: { longitude: 3, latitude: 4 } }),
    ).resolves.toMatchObject({ west: 3, east: 3, south: 4, north: 4 });

    await expect(
      controller.run('center-of-mass', {
        input: [
          { longitude: 0, latitude: 0 },
          { longitude: 1, latitude: 0 },
          { longitude: 1, latitude: 1 },
        ],
      }),
    ).resolves.toMatchObject({ algorithmVersion: SPATIAL_ALGORITHM_VERSION });

    await expect(
      controller.run('point-in-polygon', {
        point: { longitude: 0.5, latitude: 0.5 },
        polygon: {
          outer: [
            { longitude: 0, latitude: 0 },
            { longitude: 1, latitude: 0 },
            { longitude: 1, latitude: 1 },
            { longitude: 0, latitude: 1 },
          ],
        },
      }),
    ).resolves.toMatchObject({ inside: true });

    await expect(
      controller.run('points-in-polygon', {
        points: [
          { longitude: 0.5, latitude: 0.5 },
          { longitude: 5, latitude: 5 },
        ],
        polygon: {
          outer: [
            { longitude: 0, latitude: 0 },
            { longitude: 1, latitude: 0 },
            { longitude: 1, latitude: 1 },
            { longitude: 0, latitude: 1 },
          ],
        },
      }),
    ).resolves.toMatchObject({ count: 1, indexes: [0] });

    await expect(
      controller.run('transform', {
        point: { longitude: 116.39, latitude: 39.9 },
        from: 'EPSG:4326',
        to: 'EPSG:3857',
      }),
    ).resolves.toMatchObject({ algorithmVersion: SPATIAL_ALGORITHM_VERSION });
  });

  it('delegates terrain sampling with the requested strategy', async () => {
    const port = createPort({ heightAt: () => 42 });
    const controller = createAnalysisController(port);

    const samples = await controller.run('terrain-sample', {
      points: [{ longitude: 1, latitude: 2 }],
      strategy: 'level',
      level: 3,
    });

    expect(samples).toEqual([
      { longitude: 1, latitude: 2, height: 42, status: 'ok' },
    ]);
    expect((port.sample as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1]).toEqual({
      strategy: 'level',
      level: 3,
    });
  });

  it('measures surface distance over sampled terrain', async () => {
    // 平地：地表距离与大圆距离一致。
    const flat = createAnalysisController(createPort({ heightAt: () => 0 }));
    const flatResult = await flat.run('surface-distance', {
      from: { longitude: 0, latitude: 0 },
      to: { longitude: 0.01, latitude: 0 },
      samples: 8,
    });
    expect(flatResult.meters).toBeCloseTo(1111.95, 0);
    expect(flatResult.sampleCount).toBe(9);

    // 沿线上坡 1000 米：三维长度大于水平距离。
    const ramp = createAnalysisController(
      createPort({ heightAt: ({ longitude }) => (longitude / 0.01) * 1_000 }),
    );
    const rampResult = await ramp.run('surface-distance', {
      from: { longitude: 0, latitude: 0 },
      to: { longitude: 0.01, latitude: 0 },
      samples: 8,
    });
    expect(rampResult.meters).toBeGreaterThan(flatResult.meters);
    expect(rampResult.meters).toBeCloseTo(Math.hypot(1111.95, 1000), 0);
  });

  it('uses explicit endpoint heights without sampling them', async () => {
    const port = createPort({ heightAt: () => 0 });
    const controller = createAnalysisController(port);

    const result = await controller.run('line-of-sight', {
      from: { longitude: 0, latitude: 0, height: 5_000 },
      to: { longitude: 0.01, latitude: 0, height: 5_000 },
      samples: 4,
    });

    expect(result.visible).toBe(true);
    expect((port.sample as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toHaveLength(3);
  });

  it('blocks a line of sight behind a ridge and reports where', async () => {
    const blocked = createAnalysisController(ridgePort(3_000));
    const blockedResult = await blocked.run('line-of-sight', {
      from: { longitude: 0, latitude: 0, height: 100 },
      to: { longitude: 1, latitude: 0, height: 100 },
      samples: 40,
    });

    expect(blockedResult.visible).toBe(false);
    expect(blockedResult.blockedAtIndex).toBeDefined();
    expect(blockedResult.minClearanceMeters).toBeLessThan(0);

    const clear = createAnalysisController(ridgePort(50));
    const clearResult = await clear.run('line-of-sight', {
      from: { longitude: 0, latitude: 0, height: 100 },
      to: { longitude: 1, latitude: 0, height: 100 },
      samples: 40,
    });
    expect(clearResult.visible).toBe(true);
    expect(clearResult.minClearanceMeters).toBeGreaterThan(0);
  });

  it('skips terrain sampling entirely when terrain is excluded', async () => {
    const port = ridgePort(3_000);
    const controller = createAnalysisController(port);

    const result = await controller.run('line-of-sight', {
      from: { longitude: 0, latitude: 0, height: 100 },
      to: { longitude: 1, latitude: 0, height: 100 },
      includeTerrain: false,
    });

    expect(result.visible).toBe(true);
    expect(result.sampleCount).toBe(0);
    expect(port.calls).toBe(0);
  });

  it('raises ANALYSIS_TERRAIN_UNAVAILABLE when the line has no terrain data', async () => {
    const controller = createAnalysisController(createPort({ heightAt: () => undefined }));

    await expect(
      controller.run('line-of-sight', {
        from: { longitude: 0, latitude: 0 },
        to: { longitude: 0.01, latitude: 0 },
        samples: 4,
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_TERRAIN_UNAVAILABLE', retryable: true });
  });

  it('builds a viewshed horizon that matches the terrain profile', async () => {
    // 观察点位于凸形山顶（高度按半径平方衰减）：仰角随距离线性下降，第二个采样步即被遮挡。
    const radius = 4_800;
    const hill = createAnalysisController(
      createPort({
        heightAt: ({ longitude, latitude }) => {
          const distance = Math.hypot(longitude, latitude) * METERS_PER_DEGREE;
          return Math.max(0, 2_000 * (1 - (distance / radius) ** 2));
        },
      }),
    );
    const summit = await hill.run('viewshed', {
      center: { longitude: 0, latitude: 0, height: 2_000 },
      radiusMeters: radius,
      samples: 12,
    });

    expect(summit.horizon).toHaveLength(12);
    // 32 段、半径 4800 米，每步 150 米；第一步在包络上，第二步落入包络之下。
    expect(summit.blockedDistanceMeters).toBeCloseTo(300, 6);
    expect(summit.sampleCount).toBe(12 * 32);
    // 边界点落在可见距离上，而不是固定半径上。
    const firstEdge = summit.horizon[0];
    const assumed = measureDistance(
      { longitude: 0, latitude: 0 },
      firstEdge ?? { longitude: 0, latitude: 0 },
      { units: 'meters' },
    );
    expect(assumed.meters).toBeCloseTo(150, 3);

    // 观察点高于平地：仰角随距离单调上升，整条射线都可见，遮挡距离退化为半径。
    const flat = createAnalysisController(createPort({ heightAt: () => 0 }));
    const open = await flat.run('viewshed', {
      center: { longitude: 0, latitude: 0, height: 1_000 },
      radiusMeters: 1_000,
      samples: 8,
    });
    expect(open.horizon).toHaveLength(8);
    expect(open.blockedDistanceMeters).toBeCloseTo(1_000, 6);
  });

  it('derives slope and aspect from a synthetic east-facing ramp', async () => {
    const controller = createAnalysisController(
      createPort({ heightAt: ({ longitude }) => longitude * METERS_PER_DEGREE * 0.5 }),
    );

    const result = await controller.run('slope-aspect', {
      center: { longitude: 0, latitude: 0 },
      radiusMeters: 200,
      samples: 8,
    });

    expect(result.slopeDegrees).toBeCloseTo(26.565, 0);
    expect(Math.abs(result.aspectDegrees - 270)).toBeLessThan(1);
    expect(result.centerHeightMeters).toBe(0);
    expect(result.sampleCount).toBe(9);
  });

  it('rejects invalid radius, unknown tools, and aborted runs', async () => {
    const controller = createAnalysisController(createPort());

    await expect(
      controller.run('viewshed', { center: { longitude: 0, latitude: 0 }, radiusMeters: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_ANALYSIS_INPUT' });
    await expect(
      controller.run('slope-aspect', { center: { longitude: 0, latitude: 0 }, radiusMeters: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ANALYSIS_INPUT' });
    await expect(
      controller.run('freeze' as never, {} as never),
    ).rejects.toMatchObject({ code: 'UNKNOWN_ANALYSIS_TOOL' });

    const abort = new AbortController();
    abort.abort();
    await expect(
      controller.run('terrain-sample', { points: [{ longitude: 0, latitude: 0 }] }, { signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_ABORTED', retryable: true });
  });

  it('forwards the abort signal to terrain sampling', async () => {
    const port = createPort();
    const controller = createAnalysisController(port);
    const abort = new AbortController();

    await controller.run('terrain-sample', { points: [{ longitude: 0, latitude: 0 }] }, {
      signal: abort.signal,
    });

    const forwarded = (port.sample as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as {
      signal?: AbortSignal;
    };
    expect(forwarded.signal).toBe(abort.signal);
  });
});
