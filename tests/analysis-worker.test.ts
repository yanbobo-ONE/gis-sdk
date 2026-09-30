import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnalysisController, analysisTools } from '../src/core/analysis-runner.js';
import {
  createAnalysisWorkerClient,
  createAnalysisWorkerHost,
} from '../src/core/analysis-worker-client.js';
import { isAnalysisWorkerCancel } from '../src/core/analysis-worker-protocol.js';
import type { AnalysisWorkerPort } from '../src/core/analysis-worker-protocol.js';
import type { TerrainSample } from '../src/core/controls.js';

/** 双向内存通道：模拟 postMessage 的异步投递语义。 */
function createChannel() {
  const left: ((message: unknown) => void)[] = [];
  const right: ((message: unknown) => void)[] = [];
  const deliver = (listeners: ((message: unknown) => void)[], message: unknown) => {
    for (const listener of [...listeners]) {
      listener(message);
    }
  };
  const workerPort: AnalysisWorkerPort = {
    postMessage: (message) => {
      queueMicrotask(() => {
        deliver(left, message);
      });
    },
    subscribe: (listener) => {
      right.push(listener);
      return () => {
        const index = right.indexOf(listener);
        if (index >= 0) {
          right.splice(index, 1);
        }
      };
    },
  };
  const mainPort: AnalysisWorkerPort = {
    postMessage: (message) => {
      queueMicrotask(() => {
        deliver(right, message);
      });
    },
    subscribe: (listener) => {
      left.push(listener);
      return () => {
        const index = left.indexOf(listener);
        if (index >= 0) {
          left.splice(index, 1);
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

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('analysis worker bridge', () => {
  it('runs pure tools across the channel and keeps list() in sync', async () => {
    const channel = createChannel();
    const host = createAnalysisWorkerHost(channel.workerPort, {
      controller: createAnalysisController(noTerrain),
    });
    const client = createAnalysisWorkerClient(channel.mainPort, { descriptors: analysisTools });

    expect(client.pending).toBe(0);
    expect(client.list().length).toBe(analysisTools.length);

    const distance = await client.run('distance', {
      from: { longitude: 0, latitude: 0 },
      to: { longitude: 0.01, latitude: 0 },
    });
    expect(distance.meters).toBeGreaterThan(1_000);
    expect(client.pending).toBe(0);

    const hull = await client.run('convex-hull', {
      points: [
        { longitude: 0, latitude: 0 },
        { longitude: 1, latitude: 0 },
        { longitude: 1, latitude: 1 },
        { longitude: 0.5, latitude: 0.5 },
      ],
    });
    expect(hull.pointCount).toBe(3);

    host.dispose();
  });

  it('reports worker-side failures with the original code', async () => {
    const channel = createChannel();
    const host = createAnalysisWorkerHost(channel.workerPort, {
      controller: createAnalysisController(noTerrain),
    });
    const client = createAnalysisWorkerClient(channel.mainPort);

    await expect(
      client.run('line-of-sight', {
        from: { longitude: 0, latitude: 0 },
        to: { longitude: 0.01, latitude: 0 },
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_TERRAIN_UNAVAILABLE', retryable: true });

    await expect(
      client.run('simplify', {
        points: [
          { longitude: 0, latitude: 0 },
          { longitude: 1, latitude: 0 },
        ],
        toleranceMeters: -5,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SPATIAL_INPUT' });
    expect(client.pending).toBe(0);

    host.dispose();
  });

  it('cancels in-flight requests through the abort signal', async () => {
    const channel = createChannel();
    const cancelled: number[] = [];
    const host = createAnalysisWorkerHost(channel.workerPort, {
      controller: createAnalysisController({
        sample: () => new Promise<readonly TerrainSample[]>(() => undefined),
      }),
    });
    // 记录取消消息：Worker 侧收到后不再回传结果。
    channel.workerPort.subscribe((message: unknown) => {
      if (isAnalysisWorkerCancel(message)) {
        cancelled.push(message.id);
      }
    });

    const client = createAnalysisWorkerClient(channel.mainPort);
    const controller = new AbortController();
    const pending = client.run(
      'terrain-sample',
      { points: [{ longitude: 0, latitude: 0 }] },
      { signal: controller.signal },
    );
    expect(client.pending).toBe(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'ANALYSIS_ABORTED', retryable: true });
    expect(client.pending).toBe(0);
    expect(cancelled).toHaveLength(1);

    host.dispose();
  });

  it('rejects pending requests with a timeout', async () => {
    vi.useFakeTimers();
    const channel = createChannel();
    createAnalysisWorkerHost(channel.workerPort, {
      controller: createAnalysisController({
        sample: () => new Promise<readonly TerrainSample[]>(() => undefined),
      }),
    });
    const client = createAnalysisWorkerClient(channel.mainPort, { timeoutMs: 500 });

    const pending = client.run('terrain-sample', { points: [{ longitude: 0, latitude: 0 }] });
    const observed = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(500);

    await expect(observed).resolves.toMatchObject({
      code: 'ANALYSIS_WORKER_TIMEOUT',
      retryable: true,
    });
    expect(client.pending).toBe(0);
  });

  it('rejects pending requests and refuses new runs after dispose', async () => {
    const channel = createChannel();
    const client = createAnalysisWorkerClient(channel.mainPort);
    const pending = client.run('distance', {
      from: { longitude: 0, latitude: 0 },
      to: { longitude: 1, latitude: 0 },
    });

    client.dispose();

    await expect(pending).rejects.toMatchObject({ code: 'ANALYSIS_WORKER_DISPOSED' });
    // run() 是异步方法：销毁后的拒绝走 Promise，而不是同步抛出。
    await expect(
      client.run('distance', {
        from: { longitude: 0, latitude: 0 },
        to: { longitude: 1, latitude: 0 },
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_WORKER_DISPOSED' });
    expect(client.pending).toBe(0);
  });

  it('rejects an already-aborted run without touching the port', async () => {
    const channel = createChannel();
    const seen: unknown[] = [];
    channel.mainPort.subscribe((message) => seen.push(message));
    const client = createAnalysisWorkerClient(channel.mainPort);
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      client.run(
        'distance',
        { from: { longitude: 0, latitude: 0 }, to: { longitude: 1, latitude: 0 } },
        { signal: aborted.signal },
      ),
    ).rejects.toMatchObject({ code: 'ANALYSIS_ABORTED' });
    expect(seen).toEqual([]);
  });
});
