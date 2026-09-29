import { Cartographic, sampleTerrain, sampleTerrainMostDetailed } from 'cesium';
import type { TerrainProvider, Viewer } from 'cesium';

import type { TerrainSample, TerrainSampleOptions, TerrainSamplePoint } from '../core/controls.js';
import { GisError } from '../core/errors.js';
import type { LoadLimiter } from './load-limiter.js';

const DEFAULT_BATCH_SIZE = 256;
const DEFAULT_QUEUE_LIMIT = 2_048;
const DEFAULT_CACHE_LIMIT = 4_096;

/** 缓存键使用的坐标量化精度：1e-5 度约 1 米。 */
const COORDINATE_PRECISION = 5;

/** @internal */
export interface TerrainSamplerOptions {
  /** 单批点数上限，默认 256。 */
  readonly batchSize?: number;
  /** 队列点数上限，默认 2048；超过时应由调用方分批提交。 */
  readonly queueLimit?: number;
  /** 高度缓存条目上限，默认 4096。 */
  readonly cacheLimit?: number;
}

function samplingError(
  message: string,
  code: 'INVALID_TERRAIN_CONFIG' | 'INVALID_COORDINATES' | 'TERRAIN_DISPOSED',
  operation: string,
  cause?: unknown,
): GisError {
  return new GisError(message, {
    code,
    module: 'terrain',
    operation,
    ...(cause === undefined ? {} : { cause }),
  });
}

function unavailable(message: string): GisError {
  return new GisError(message, {
    code: 'TERRAIN_SAMPLING_UNAVAILABLE',
    module: 'terrain',
    operation: 'sample',
  });
}

function aborted(cause?: unknown): GisError {
  return new GisError('Terrain sampling was aborted.', {
    code: 'TERRAIN_SAMPLING_ABORTED',
    module: 'terrain',
    operation: 'sample',
    retryable: true,
    cause,
  });
}

function failed(cause: unknown): GisError {
  return new GisError('Failed to sample terrain heights.', {
    code: 'TERRAIN_SAMPLING_FAILED',
    module: 'terrain',
    operation: 'sample',
    retryable: true,
    cause,
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizePoints(
  points: readonly unknown[],
  queueLimit: number,
): readonly TerrainSamplePoint[] {
  if (points.length === 0) {
    throw samplingError(
      'Terrain sampling requires at least one point.',
      'INVALID_TERRAIN_CONFIG',
      'sample',
    );
  }
  if (points.length > queueLimit) {
    throw samplingError(
      `Terrain sampling accepts at most ${String(queueLimit)} points per call.`,
      'INVALID_TERRAIN_CONFIG',
      'sample',
    );
  }
  for (const [index, point] of points.entries()) {
    const { longitude, latitude } = (point ?? {}) as Partial<TerrainSamplePoint>;
    if (!finite(longitude) || !finite(latitude)) {
      throw samplingError(
        `Terrain sample point ${String(index)} must contain finite longitude and latitude.`,
        'INVALID_COORDINATES',
        'sample',
      );
    }
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
      throw samplingError(
        `Terrain sample point ${String(index)} is outside the WGS84 degree range.`,
        'INVALID_COORDINATES',
        'sample',
      );
    }
  }
  return points as readonly TerrainSamplePoint[];
}

/**
 * 有界异步地形采样。
 *
 * 复用当前地形服务做批量采样，按 provider、策略、层级和量化坐标缓存高度值：地形高度在
 * 一次会话内是稳定的，缓存能把"近似同一位置反复采样"的代价降到一次。
 * `most-detailed` 需要服务提供可用层级，缺失时（例如椭球地形）自动退化为 `level`。
 *
 * @internal
 */
export class CesiumTerrainSampler {
  private readonly batchSize: number;
  private readonly queueLimit: number;
  private readonly cacheLimit: number;
  private readonly cache = new Map<string, number | undefined>();
  private readonly providerKeys = new WeakMap<object, number>();
  private providerSequence = 0;
  private disposed = false;

  constructor(
    private readonly viewer: Pick<Viewer, 'scene'>,
    private readonly limiter: LoadLimiter,
    options: TerrainSamplerOptions = {},
  ) {
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
    this.queueLimit = Math.max(
      this.batchSize,
      Math.floor(options.queueLimit ?? DEFAULT_QUEUE_LIMIT),
    );
    this.cacheLimit = Math.max(128, Math.floor(options.cacheLimit ?? DEFAULT_CACHE_LIMIT));
  }

  /** 当前缓存条目数。 */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** 清空高度缓存；地形服务切换后由适配器调用。 */
  clearCache(): void {
    this.cache.clear();
  }

  /** 释放采样器；清空缓存并拒绝后续采样。 */
  dispose(): void {
    this.disposed = true;
    this.cache.clear();
  }

  /** 批量采样地形高度，结果顺序与输入一致。 */
  async sample(
    points: readonly TerrainSamplePoint[],
    options: TerrainSampleOptions = {},
  ): Promise<readonly TerrainSample[]> {
    if (this.disposed) {
      throw samplingError('Terrain controller has been disposed.', 'TERRAIN_DISPOSED', 'sample');
    }
    const normalized = normalizePoints(points, this.queueLimit);
    if (options.signal?.aborted) {
      throw aborted(options.signal.reason);
    }

    // 宿主可以通过原生接口移除 globe 或其地形服务，因此按可空处理。
    const provider = (this.viewer.scene.globe as { terrainProvider?: TerrainProvider })
      .terrainProvider;
    if (!provider) {
      throw unavailable('No terrain provider is installed on the current scene.');
    }
    const strategy =
      options.strategy === 'level' || !provider.availability ? 'level' : 'most-detailed';
    const level = Math.max(0, Math.floor(options.level ?? 0));
    const providerKey = this.providerKey(provider);

    const heights = new Array<number | undefined>(normalized.length);
    const statuses = new Array<TerrainSample['status']>(normalized.length).fill('ok');
    const pending: { readonly index: number; readonly point: TerrainSamplePoint }[] = [];
    for (const [index, point] of normalized.entries()) {
      const key = this.cacheKey(providerKey, strategy, level, point);
      if (this.cache.has(key)) {
        heights[index] = this.cache.get(key);
      } else {
        pending.push({ index, point });
      }
    }

    for (let start = 0; start < pending.length; start += this.batchSize) {
      if (options.signal?.aborted) {
        throw aborted(options.signal.reason);
      }
      const slice = pending.slice(start, start + this.batchSize);
      const batch = slice.map((entry) => entry.point);
      const sampled = await this.sampleBatch(provider, batch, strategy, level, options.signal);
      slice.forEach((entry, offset) => {
        const height = sampled[offset];
        heights[entry.index] = height;
        if (height === undefined) {
          statuses[entry.index] = 'no-data';
        }
        this.writeCache(this.cacheKey(providerKey, strategy, level, entry.point), height);
      });
    }

    return normalized.map((point, index) => {
      const height = heights[index];
      return {
        longitude: point.longitude,
        latitude: point.latitude,
        height,
        status: statuses[index] ?? (height === undefined ? 'no-data' : 'ok'),
      };
    });
  }

  private async sampleBatch(
    provider: TerrainProvider,
    points: readonly TerrainSamplePoint[],
    strategy: 'most-detailed' | 'level',
    level: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly (number | undefined)[]> {
    const positions = points.map((point) =>
      Cartographic.fromDegrees(point.longitude, point.latitude),
    );
    const controller = new AbortController();
    const forwardAbort = () => {
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) {
      throw aborted(signal.reason);
    }
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const sampled = await this.limiter.run(
        () =>
          strategy === 'most-detailed'
            ? sampleTerrainMostDetailed(provider, positions)
            : sampleTerrain(provider, level, positions),
        controller.signal,
      );
      if (signal?.aborted) {
        throw aborted(signal.reason);
      }
      return sampled.map((position) =>
        typeof position.height === 'number' && Number.isFinite(position.height)
          ? position.height
          : undefined,
      );
    } catch (cause: unknown) {
      if (cause instanceof GisError) {
        throw cause;
      }
      if (signal?.aborted) {
        throw aborted(signal.reason);
      }
      throw failed(cause);
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private providerKey(provider: TerrainProvider): number {
    const existing = this.providerKeys.get(provider);
    if (existing !== undefined) {
      return existing;
    }
    this.providerSequence += 1;
    this.providerKeys.set(provider, this.providerSequence);
    return this.providerSequence;
  }

  /** 缓存键包含服务、策略、层级与量化坐标，服务切换后不会命中旧值。 */
  private cacheKey(
    providerKey: number,
    strategy: string,
    level: number,
    point: TerrainSamplePoint,
  ): string {
    return [
      providerKey,
      strategy,
      level,
      point.longitude.toFixed(COORDINATE_PRECISION),
      point.latitude.toFixed(COORDINATE_PRECISION),
    ].join('|');
  }

  private writeCache(key: string, value: number | undefined): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next();
      if (oldest.done) {
        break;
      }
      this.cache.delete(oldest.value);
    }
  }
}
