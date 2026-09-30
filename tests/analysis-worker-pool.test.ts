import { describe, expect, it } from 'vitest';

import { createAnalysisController, analysisTools } from '../src/core/analysis-runner.js';
import { createAnalysisWorkerHost } from '../src/core/analysis-worker-client.js';
import { createAnalysisWorkerPool } from '../src/core/analysis-worker-pool.js';
import type { AnalysisWorkerPort } from '../src/core/analysis-worker-protocol.js';
import type { TerrainSample } from '../src/core/controls.js';

/** 双向内存通道，带可控的响应延迟，便于观察调度行为。 */
function createChannel() {
  const toWorker: ((message: unknown) => void)[] = [];
  const toMain: ((message: unknown) => void)[] = [];
  const deliver = (listeners: ((message: unknown) => void)[], message: unknown) => {
    for (const listener of [...listeners]) {
      listener(message);
    }
  };
  const workerPort: AnalysisWorkerPort = {
    postMessage: (message) => {
      queueMicrotask(() => {
        deliver(toWorker, message);
      });
    },
    subscribe: (listener) => {
      toMain.push(listener);
      return () => {
        const index = toMain.indexOf(listener);
        if (index >= 0) {
          toMain.splice(index, 1);
        }
      };
    },
  };
  const mainPort: AnalysisWorkerPort = {
    postMessage: (message) => {
      queueMicrotask(() => {
        deliver(toMain, message);
      });
    },
    subscribe: (listener) => {
      toWorker.push(listener);
      return () => {
        const index = toWorker.indexOf(listener);
        if (index >= 0) {
          toWorker.splice(index, 1);
        }
      };
    },
  };
  return { mainPort, workerPort };
}

const noTerrain = {
  sample: (points: readonly { longitude: number; latitude: number }[]) =>
    Promise.resolve(
      points.map((point): TerrainSample => ({
        longitude: point.longitude,
        latitude: point.latitude,
        height: undefined,
        status: 'no-data',
      })),
    ),
};

function createPool(workerCount: number, options: Parameters<typeof createAnalysisWorkerPool>[1] = {}) {
  const ports: AnalysisWorkerPort[] = [];
  const hosts: { dispose(): void }[] = [];
  for (let index = 0; index < workerCount; index += 1) {
    const channel = createChannel();
    ports.push(channel.mainPort);
    hosts.push(
      createAnalysisWorkerHost(channel.workerPort, {
        controller: createAnalysisController(noTerrain),
      }),
    );
  }
  const pool = createAnalysisWorkerPool(ports, { descriptors: analysisTools, ...options });
  return {
    pool,
    dispose: () => {
      for (const host of hosts) {
        host.dispose();
      }
    },
  };
}

describe('createAnalysisWorkerPool', () => {
  it('runs requests across workers and reports stats', async () => {
    const harness = createPool(3);
    expect(harness.pool.stats).toEqual({
      workers: 3,
      pending: 0,
      queued: 0,
      completed: 0,
      failed: 0,
    });
    expect(harness.pool.list().length).toBe(analysisTools.length);

    const results = await Promise.all([
      harness.pool.run('distance', {
        from: { longitude: 0, latitude: 0 },
        to: { longitude: 0.01, latitude: 0 },
      }),
      harness.pool.run('bearing', {
        from: { longitude: 0, latitude: 0 },
        to: { longitude: 0, latitude: 1 },
      }),
      harness.pool.run('bbox', { input: { longitude: 5, latitude: 6 } }),
    ]);

    expect(results[0].meters).toBeGreaterThan(1_000);
    expect(results[1].degrees).toBeCloseTo(0, 6);
    expect(results[2]).toMatchObject({ west: 5, north: 6 });
    expect(harness.pool.stats.completed).toBe(3);
    expect(harness.pool.stats.failed).toBe(0);
    expect(harness.pool.stats.pending).toBe(0);

    harness.pool.dispose();
    harness.dispose();
  });

  it('queues beyond maxPendingPerWorker and drains in order', async () => {
    const harness = createPool(1, { maxPendingPerWorker: 1, maxQueued: 4 });

    const first = harness.pool.run('terrain-sample', { points: [{ longitude: 0, latitude: 0 }] });
    const second = harness.pool.run('terrain-sample', { points: [{ longitude: 1, latitude: 1 }] });
    const third = harness.pool.run('terrain-sample', { points: [{ longitude: 2, latitude: 2 }] });

    // 第一个在途，其余排队。
    await Promise.resolve();
    expect(harness.pool.stats.queued).toBeLessThanOrEqual(2);

    await Promise.all([first, second, third]);
    expect(harness.pool.stats.completed).toBe(3);
    expect(harness.pool.stats.queued).toBe(0);
    expect(harness.pool.stats.pending).toBe(0);

    harness.pool.dispose();
    harness.dispose();
  });

  it('rejects when the queue is full', async () => {
    const harness = createPool(1, { maxPendingPerWorker: 1, maxQueued: 0 });

    const inFlight = harness.pool
      .run('terrain-sample', { points: [{ longitude: 0, latitude: 0 }] })
      .catch((error: unknown) => error);
    await expect(
      harness.pool.run('terrain-sample', { points: [{ longitude: 1, latitude: 1 }] }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_WORKER_QUEUE_FULL', retryable: true });
    expect(harness.pool.stats.failed).toBe(1);

    await inFlight;
    harness.pool.dispose();
    harness.dispose();
  });

  it('propagates worker failures and counts them', async () => {
    const harness = createPool(2);

    await expect(
      harness.pool.run('line-of-sight', {
        from: { longitude: 0, latitude: 0 },
        to: { longitude: 0.01, latitude: 0 },
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_TERRAIN_UNAVAILABLE' });
    expect(harness.pool.stats.failed).toBe(1);
    expect(harness.pool.stats.completed).toBe(0);

    harness.pool.dispose();
    harness.dispose();
  });

  it('rejects queued and later requests after dispose', async () => {
    const harness = createPool(1, { maxPendingPerWorker: 1, maxQueued: 4 });

    const inFlight = harness.pool
      .run('terrain-sample', { points: [{ longitude: 0, latitude: 0 }] })
      .catch((error: unknown) => error);
    const queued = harness.pool.run('terrain-sample', { points: [{ longitude: 1, latitude: 1 }] });

    harness.pool.dispose();

    await expect(queued).rejects.toMatchObject({ code: 'ANALYSIS_WORKER_DISPOSED' });
    expect(() =>
      harness.pool.run('bbox', { input: { longitude: 0, latitude: 0 } }),
    ).toThrow(expect.objectContaining({ code: 'ANALYSIS_WORKER_DISPOSED' }));
    await inFlight;
    harness.dispose();
  });

  it('validates configuration', () => {
    expect(() => createAnalysisWorkerPool([])).toThrow(
      expect.objectContaining({ code: 'INVALID_ANALYSIS_INPUT' }),
    );
    const channel = createChannel();
    expect(() => createAnalysisWorkerPool([channel.mainPort], { maxPendingPerWorker: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ANALYSIS_INPUT' }),
    );
    expect(() => createAnalysisWorkerPool([channel.mainPort], { maxQueued: 5000 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ANALYSIS_INPUT' }),
    );
  });
});
