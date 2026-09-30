import { describe, expect, it, vi } from 'vitest';

import { runAnalysisBatch } from '../src/core/analysis-batch.js';
import { createAnalysisController } from '../src/core/analysis-runner.js';
import type { AnalysisTerrainPort } from '../src/core/analysis-runner.js';
import type { TerrainSample, TerrainSamplePoint } from '../src/core/controls.js';

/** 地形端口：按固定高度返回，并可统计在途请求数（用于验证并发上限）。 */
function createPort(height = 0) {
  let inFlight = 0;
  let peak = 0;
  const port: AnalysisTerrainPort & { peak(): number } = {
    peak: () => peak,
    sample: (points: readonly TerrainSamplePoint[]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<readonly TerrainSample[]>((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          resolve(
            points.map((point) => ({
              longitude: point.longitude,
              latitude: point.latitude,
              height,
              status: 'ok' as const,
            })),
          );
        }, 5);
      });
    },
  };
  return port;
}

describe('runAnalysisBatch', () => {
  it('runs every item, keeps input order, and reports progress', async () => {
    const controller = createAnalysisController(createPort());
    const progress: number[] = [];
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `row-${String(index)}`,
      tool: 'distance' as const,
      input: {
        from: { longitude: 0, latitude: 0 },
        to: { longitude: 0.01 * (index + 1), latitude: 0 },
      },
    }));

    const outcome = await runAnalysisBatch(controller, items, {
      concurrency: 2,
      onProgress: (snapshot) => progress.push(snapshot.completed + snapshot.failed),
    });

    expect(outcome.cancelled).toBe(false);
    expect(outcome.entries).toHaveLength(6);
    expect(outcome.entries.map((entry) => entry.id)).toEqual([
      'row-0',
      'row-1',
      'row-2',
      'row-3',
      'row-4',
      'row-5',
    ]);
    // 结果按距离递增，证明下标与输入对齐而不是按完成顺序排列。
    const distances = outcome.entries.map((entry) => (entry.value as { meters: number }).meters);
    expect([...distances].sort((left, right) => left - right)).toEqual(distances);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(outcome.entries.every((entry) => entry.ok)).toBe(true);
  });

  it('bounds concurrency and forwards it to the terrain port', async () => {
    const port = createPort();
    const controller = createAnalysisController(port);
    const items = Array.from({ length: 8 }, (_, index) => ({
      tool: 'terrain-sample' as const,
      input: { points: [{ longitude: index, latitude: 0 }] },
    }));

    await runAnalysisBatch(controller, items, { concurrency: 3 });

    expect(port.peak()).toBeLessThanOrEqual(3);
    expect(port.peak()).toBeGreaterThan(1);
  });

  it('isolates failures per item and keeps the rest running', async () => {
    const controller = createAnalysisController(createPort());
    const items = [
      {
        id: 'ok',
        tool: 'distance' as const,
        input: { from: { longitude: 0, latitude: 0 }, to: { longitude: 0.01, latitude: 0 } },
      },
      {
        id: 'bad',
        tool: 'simplify' as const,
        input: { points: [{ longitude: 0, latitude: 0 }], toleranceMeters: -1 },
      },
      {
        id: 'ok-2',
        tool: 'bearing' as const,
        input: { from: { longitude: 0, latitude: 0 }, to: { longitude: 0, latitude: 1 } },
      },
    ];

    const outcome = await runAnalysisBatch(controller, items);

    expect(outcome.entries.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(outcome.entries[1]).toMatchObject({
      id: 'bad',
      errorCode: 'INVALID_SPATIAL_INPUT',
    });
    expect(outcome.cancelled).toBe(false);
  });

  it('stops dispatching on abort and returns partial results', async () => {
    const controller = createAnalysisController(createPort());
    const controllerRef = vi.spyOn(controller, 'run');
    const abort = new AbortController();
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `row-${String(index)}`,
      tool: 'terrain-sample' as const,
      input: { points: [{ longitude: index, latitude: 0 }] },
    }));

    const pending = runAnalysisBatch(controller, items, { concurrency: 2, signal: abort.signal });
    // 第一波派发后立即中止。
    await vi.waitFor(() => {
      expect(controllerRef).toHaveBeenCalled();
    });
    abort.abort();
    const outcome = await pending;

    expect(outcome.cancelled).toBe(true);
    expect(outcome.entries.length).toBeLessThan(items.length);
    // 未派发的条目不会出现在结果里。
    expect(outcome.entries.every((entry) => entry.index < items.length)).toBe(true);
  });

  it('rejects an invalid concurrency and handles an empty list', async () => {
    const controller = createAnalysisController(createPort());

    await expect(runAnalysisBatch(controller, [], { concurrency: 0 })).rejects.toMatchObject({
      code: 'INVALID_ANALYSIS_INPUT',
    });

    const empty = await runAnalysisBatch(controller, []);
    expect(empty).toEqual({ entries: [], cancelled: false });
  });
});
