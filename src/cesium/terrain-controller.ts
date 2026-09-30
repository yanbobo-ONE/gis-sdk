import { CesiumTerrainProvider, EllipsoidTerrainProvider } from 'cesium';
import type { Viewer } from 'cesium';

import type {
  TerrainController,
  TerrainSample,
  TerrainSampleOptions,
  TerrainSamplePoint,
  TerrainSetOptions,
  TerrainSpec,
} from '../core/controls.js';
import { GisError } from '../core/errors.js';
import type { CesiumTerrainSampler } from './terrain-sampling.js';

/** 地形元数据请求的默认超时时间；与 Plugin-web 的启动兜底策略一致。 */
const DEFAULT_TIMEOUT_MS = 30_000;

function invalidConfig(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_TERRAIN_CONFIG',
    module: 'terrain',
    operation: 'set',
  });
}

function invalidTimeout(value: number | undefined): GisError | undefined {
  if (value === undefined || (Number.isSafeInteger(value) && value >= 0)) {
    return undefined;
  }
  return invalidConfig('Terrain timeoutMs must be a non-negative safe integer.');
}

function timedOut(timeoutMs: number): GisError {
  return new GisError(`Cesium terrain did not respond within ${String(timeoutMs)} ms.`, {
    code: 'TERRAIN_LOAD_FAILED',
    module: 'terrain',
    operation: 'set',
    retryable: true,
  });
}

function busy(): GisError {
  return new GisError('A terrain change is already in progress.', {
    code: 'TERRAIN_BUSY',
    module: 'terrain',
    operation: 'set',
    retryable: true,
  });
}

function terrainLoadFailed(cause: unknown): GisError {
  if (cause instanceof GisError) {
    return cause;
  }
  return new GisError('Failed to load Cesium terrain.', {
    code: 'TERRAIN_LOAD_FAILED',
    module: 'terrain',
    operation: 'set',
    retryable: true,
    cause,
  });
}

/** 在超时后拒绝，避免服务端长时间无响应时永久占用切换状态。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timedOut(timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(
          cause instanceof Error ? cause : new Error('Cesium terrain request failed.', { cause }),
        );
      },
    );
  });
}

/** @internal */
export class CesiumTerrainController implements TerrainController {
  private currentType: TerrainSpec['type'] = 'ellipsoid';
  private inFlight: Promise<void> | undefined;
  private readyPromise: Promise<void> = Promise.resolve();
  private reporter: ((error: GisError) => void) | undefined;
  private disposed = false;

  constructor(
    private readonly viewer: Pick<Viewer, 'terrainProvider'>,
    private readonly sampler: CesiumTerrainSampler,
    initial?: TerrainSpec,
  ) {
    if (initial) {
      this.readyPromise = this.installInitial(initial);
    }
  }

  get type(): TerrainSpec['type'] {
    return this.currentType;
  }

  get pending(): boolean {
    return this.inFlight !== undefined;
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  setErrorReporter(reporter: (error: GisError) => void): void {
    this.reporter = reporter;
  }

  set(spec: TerrainSpec, options: TerrainSetOptions = {}): Promise<void> {
    this.assertActive();
    if (this.inFlight) {
      return Promise.reject(busy());
    }
    return this.start(spec, options);
  }

  sample(
    points: readonly TerrainSamplePoint[],
    options: TerrainSampleOptions = {},
  ): Promise<readonly TerrainSample[]> {
    this.assertActive();
    return this.sampler.sample(points, options);
  }

  destroy(): void {
    this.disposed = true;
    this.sampler.dispose();
  }

  private start(spec: TerrainSpec, options: TerrainSetOptions): Promise<void> {
    const tracked = this.apply(spec, options).finally(() => {
      if (this.inFlight === tracked) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = tracked;
    return tracked;
  }

  /**
   * 安装创建期声明的初始地形。
   *
   * 失败同时经 `ready` 拒绝与 `map:error` 上报：`createMap` 是同步 API，调用方未必
   * await `ready`，只走拒绝会丢错误。上报器由 `MapRuntime` 在构造时接入，而这里的
   * 失败回调总是在本同步段之后（微任务或网络回调）才执行，因此不会早于上报器挂载。
   */
  private installInitial(spec: TerrainSpec): Promise<void> {
    const initial = this.start(spec, {}).catch((cause: unknown) => {
      const error = terrainLoadFailed(cause);
      this.reporter?.(error);
      throw error;
    });
    // 保持"错误已上报"，同时避免未 await 的调用方收到未处理拒绝。
    void initial.catch(() => undefined);
    return initial;
  }

  private apply(spec: TerrainSpec, options: TerrainSetOptions): Promise<void> {
    if (spec.type === 'ellipsoid') {
      this.viewer.terrainProvider = new EllipsoidTerrainProvider();
      this.currentType = 'ellipsoid';
      this.sampler.clearCache();
      return Promise.resolve();
    }

    const url = spec.url.trim();
    if (!url) {
      return Promise.reject(invalidConfig('Cesium terrain URL must be non-empty.'));
    }

    const timeoutError = invalidTimeout(options.timeoutMs);
    if (timeoutError) {
      return Promise.reject(timeoutError);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const request = CesiumTerrainProvider.fromUrl(url, {
      ...(spec.requestVertexNormals === undefined
        ? {}
        : { requestVertexNormals: spec.requestVertexNormals }),
      ...(spec.requestWaterMask === undefined ? {} : { requestWaterMask: spec.requestWaterMask }),
    });
    return (timeoutMs > 0 ? withTimeout(request, timeoutMs) : request).then(
      (provider) => {
        this.assertActive();
        this.viewer.terrainProvider = provider;
        this.currentType = 'cesium-terrain';
        this.sampler.clearCache();
      },
      (cause: unknown) => {
        throw terrainLoadFailed(cause);
      },
    );
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new GisError('Terrain controller has been disposed.', {
        code: 'TERRAIN_DISPOSED',
        module: 'terrain',
        operation: 'set',
      });
    }
  }
}
