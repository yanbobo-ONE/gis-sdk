import {
  SimulationClock,
  clusterPoints,
  czmlFromPositions,
  runAnalysisBatch,
} from '@yanbobo/gis-sdk/core';
import type {
  AnalysisController,
  CameraController,
  CoordinateTransform,
  EnvironmentController,
  GeoPoint,
  MapClockController,
  PickingController,
  PickingHit,
  QualityController,
  QualityProfileId,
  TerrainController,
} from '@yanbobo/gis-sdk/core';
import type { LayerManager } from '@yanbobo/gis-sdk/layers';

/** 示例用来验证自定义请求头的取值；服务端 fixture 会把它记进 `/__test/wms-state`。 */
export const EXAMPLE_AUTH_HEADER = 'gis-sdk-example-token';

type ExampleState = 'idle' | 'starting' | 'ready' | 'destroying' | 'error';

interface LayerInfoLike {
  readonly id: string;
  readonly type: string;
  readonly state: string;
  readonly visible: boolean;
}

interface GeoJsonHandleLike {
  readonly id: string;
  readonly type: 'geojson';
  readonly state: string;
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  setData(data: unknown): Promise<void>;
}

interface WmsHandleLike {
  readonly id: string;
  readonly type: 'wms';
  readonly state: string;
  readonly visible: boolean;
  readonly opacity: number;
  setVisible(visible: boolean): void;
  setOpacity(opacity: number): void;
  setFilter(filter?: unknown): Promise<void>;
  reload(): Promise<void>;
}

interface LayerHandleLike extends LayerInfoLike {
  setVisible(visible: boolean): void;
}

/** 地图就绪后可用的句柄组合：控制器各操作统一从这里取。 */
interface ReadyHandles {
  readonly geoJson: GeoJsonHandleLike;
  readonly map: ExampleMapLike;
  readonly wms: WmsHandleLike;
}

interface ExamplePointSpec {
  readonly id: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly label?: string;
}

interface PointsHandleLike extends LayerHandleLike {
  readonly type: 'points';
  readonly count: number;
  readonly labelCount: number;
  setData(points: readonly ExamplePointSpec[]): Promise<void>;
  setStyle(style: { readonly labels?: { readonly enabled?: boolean } }): void;
}

interface ExampleMapLike {
  readonly state: string;
  /** 直接复用 SDK 的相机读数字段：示例同时验证发布包的类型可用。 */
  readonly camera: Pick<CameraController, 'view' | 'metersPerPixel' | 'setView'>;
  readonly environment: Pick<EnvironmentController, 'set' | 'clearAll'>;
  /** 创建期地形的读数与切换：示例验证 `ready` / `pending` / `set` 确实随发布包一起可用。 */
  readonly terrain: Pick<TerrainController, 'type' | 'pending' | 'ready' | 'set'>;
  /** 地图时钟：示例验证读数、绑定与按帧推进确实随发布包一起可用。 */
  readonly clock: Pick<MapClockController, 'time' | 'snapshot' | 'bind'>;
  /** 拾取事件：实体命中探针走的是业务真实订阅的那条通道。 */
  readonly picking: Pick<PickingController, 'on' | 'setEnabled'>;
  /** 坐标投影：用它把探针实体的位置换算成真实点击坐标。 */
  readonly coordinates: Pick<CoordinateTransform, 'toWindow'>;
  /** 渲染质量：性能矩阵用它读 SDK 自己的帧采样，并在测量期间冻住自动降档。 */
  readonly quality: Pick<
    QualityController,
    'current' | 'snapshot' | 'set' | 'setProfile' | 'setAdaptive' | 'adaptive'
  >;
  readonly analysis: AnalysisController;
  readonly layers: Pick<LayerManager, 'add' | 'list' | 'remove'>;
  readonly raw: {
    readonly viewer: {
      readonly dataSources?: { get(index: number): unknown };
      readonly canvas?: HTMLCanvasElement;
      /**
       * 瓦片加载进度。
       *
       * 性能矩阵用它等场景画完：瓦片在途时渲染反而更便宜（要画的瓦片还少），
       * 不等它收敛就会把"还没画完"当成稳态读数。
       */
      readonly scene?: {
        readonly globe?: {
          readonly tilesLoaded: boolean;
          readonly tileLoadProgressEvent: {
            addEventListener(listener: (pending: number) => void): () => void;
          };
        };
      };
      flyTo(target: unknown): Promise<boolean>;
    };
  };
  destroy(): Promise<void>;
}

interface ExampleDependencies {
  readonly createMap: (options: {
    readonly container: string | HTMLElement;
    readonly cesiumBaseUrl: string;
    readonly terrain?: { readonly type: 'cesium-terrain'; readonly url: string };
  }) => ExampleMapLike;
  readonly createActiveFilter: () => unknown;
  readonly geoJsonUrl: string;
  readonly wmsUrl: string;
  /** 本地地形元数据 fixture 的根地址；验收台用它验证创建期地形真的发出请求。 */
  readonly terrainUrl: string;
  /**
   * 等待若干渲染帧。
   *
   * 时钟探针要观察"每帧推进"，必须在真实渲染帧上等待：单测注入立即兑现的实现，
   * 浏览器里默认走 `requestAnimationFrame`。
   */
  readonly waitFrames?: (count: number) => Promise<void>;
}

/** 面板上的环境预设；`clear` 表示清空全部环境效果。 */
export type VanillaEnvironmentPreset = 'clear' | 'depthFog' | 'haze' | 'rain' | 'snow';

export interface VanillaExampleSnapshot {
  readonly state: ExampleState;
  readonly layerCount: number;
  readonly geoJsonVisible: boolean;
  readonly wmsOpacity: number;
  readonly wmsFilterEnabled: boolean;
  readonly dataRevision: number;
  /** 当前环境预设。 */
  readonly environment: VanillaEnvironmentPreset;
  /** 最近一次通视分析结果；没跑过时为 `undefined`。 */
  readonly lineOfSight: string | undefined;
  /** 最近一次读取的相机位姿文本；没读过时为 `undefined`。 */
  readonly camera: string | undefined;
  /** 点位图层读数：`点数 / 标签数`；没添加过时为 `undefined`。 */
  readonly points: string | undefined;
  /** 聚合读数：`N 簇 / M 点（每簇 X 像素）`；没聚合过时为 `undefined`。 */
  readonly clusters: string | undefined;
  /** CZML 图层读数：实体数；没加载过时为 `undefined`。 */
  readonly czml: string | undefined;
  /** 地图时钟读数：`推进 ms / 源时钟是否一致 / animating / 实体数`；没验过时为 `undefined`。 */
  readonly clock: string | undefined;
  /** 实体拾取读数：命中图层与实体 id；没验过时为 `undefined`。 */
  readonly entityPick: string | undefined;
  /**
   * 等待真实点击的页面坐标 `x,y`。
   *
   * 探针实体渲染后由 SDK 的坐标投影算出，验收脚本据此在画布上点下去；
   * 未布防或已命中时为 `undefined`。
   */
  readonly entityPickScreen: string | undefined;
  /** 性能矩阵摘要：`场景数 / 最低帧率 / 最高帧率`；没测过时为 `undefined`。 */
  readonly performance: string | undefined;
  /** 性能矩阵原始读数（JSON 数组），供验收脚本与文档取数。 */
  readonly performanceMatrix: string | undefined;
  /** 批量分析读数：`完成 / 失败 / 总数`；没跑过时为 `undefined`。 */
  readonly batch: string | undefined;
  /** 创建期地形读数：`已安装类型 / pending / ready 结果`；没验过时为 `undefined`。 */
  readonly terrain: string | undefined;
  readonly error?: string;
}

export interface VanillaExampleController {
  start(container: string | HTMLElement): Promise<void>;
  restart(): Promise<void>;
  destroy(): Promise<void>;
  replaceGeoJson(): Promise<void>;
  setGeoJsonVisible(visible: boolean): void;
  setWmsOpacity(opacity: number): void;
  setEnvironment(preset: VanillaEnvironmentPreset): void;
  runLineOfSight(): Promise<void>;
  readCamera(): void;
  addPointLayer(): Promise<void>;
  togglePointLabels(): void;
  clusterPoints(): void;
  addCzmlLayer(): Promise<void>;
  /** 用 `SimulationClock` 驱动地图时钟播放 CZML 轨迹，并断言时钟真的随帧推进。 */
  probeCzmlClock(): Promise<void>;
  /**
   * 布防实体拾取探针：加载一个静态 CZML 实体并把相机对准它。
   *
   * 探针不自己合成点击——Cesium 的输入层用 `setPointerCapture`，合成事件会被拦下——
   * 而是报告页面坐标，由验收脚本在画布上真实点一次。
   */
  armEntityPickProbe(): Promise<void>;
  /**
   * 跑一遍浏览器端性能矩阵：固定机位、关自动降档，逐场景读 SDK 的帧采样读数。
   *
   * 读数写进 `performance` / `performanceMatrix`；测量期间标签页必须保持可见，
   * 否则浏览器会暂停渲染、窗口被重置。
   */
  measurePerformanceMatrix(): Promise<void>;
  runBatchAnalysis(): Promise<void>;
  /** 用 `createMap({ terrain })` 重建地图，等 `ready` 兑现后记录读数并切回椭球地形。 */
  createWithTerrain(): Promise<void>;
  setWmsFilterEnabled(enabled: boolean): Promise<void>;
  reloadWms(): Promise<void>;
  snapshot(): VanillaExampleSnapshot;
  subscribe(listener: (snapshot: VanillaExampleSnapshot) => void): () => void;
}

const replacementGeoJson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Updated command point', status: 'ACTIVE' },
      geometry: { type: 'Point', coordinates: [116.397, 39.908] },
    },
    {
      type: 'Feature',
      properties: { name: 'Updated route', status: 'ACTIVE' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [116.1, 39.72],
          [116.42, 39.94],
          [116.78, 40.08],
        ],
      },
    },
  ],
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 时钟探针的 epoch 与采样：显式给出，便于由它算出 `SimulationClock` 的时间范围。 */
const CLOCK_PROBE_EPOCH = '2026-09-30T00:00:00Z';
const CLOCK_PROBE_SAMPLES = 24;
const CLOCK_PROBE_INTERVAL_SECONDS = 1;
/** 倍率取 8：几帧就能观察到明显推进，同时不会在探针结束前播完。 */
const CLOCK_PROBE_RATE = 8;
/** 等待的渲染帧数：留出足够余量，避免首帧还在建场景时就下结论。 */
const CLOCK_PROBE_FRAMES = 6;

/** 实体拾取探针的实体 id 与位置；位置显式给出，才能把它投影成点击坐标。 */
const PICK_PROBE_ENTITY_ID = 'pick-probe';
const PICK_PROBE_POSITION = { longitude: 116.5, latitude: 39.95, height: 20_000 } as const;

/** 默认按真实渲染帧等待；单测注入替代实现即可脱离浏览器运行。 */
function requestFrames(count: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let remaining = count;
    const step = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * 性能矩阵里的一行读数。
 *
 * 帧率与帧耗时都取自 SDK 自己的质量监测（`map.quality.snapshot`），不是探针另起一套
 * 计时器：这样矩阵反映的就是业务真正能读到的那个数。
 */
export interface VanillaPerformanceRow {
  /** 场景名。 */
  readonly scenario: string;
  /** 滑动窗口内的平均帧率。 */
  readonly fps: number;
  /** 滑动窗口内的平均帧耗时，单位为毫秒。 */
  readonly frameTimeMs: number;
  /** 中位帧耗时（P50），单位为毫秒。 */
  readonly p50Ms: number;
  /** 95 分位帧耗时（P95），单位为毫秒。 */
  readonly p95Ms: number;
  /** 窗口内最长的一帧，单位为毫秒。 */
  readonly maxMs: number;
  /** 达到长帧阈值（50 毫秒）的帧数。 */
  readonly longFrames: number;
  /**
   * 测量窗口内的浏览器长任务数（Long Tasks API，Chromium 才有）。
   *
   * 与长帧对照着看能区分卡在哪里：长帧多而长任务少，说明卡在 GPU 或合成；
   * 两者都多，说明主线程被 JS 占住了。取不到该 API 时为 `undefined`。
   */
  readonly longTasks: number | undefined;
  /** 窗口内的采样帧数；稳定读数应为满窗 60 帧。 */
  readonly samples: number;
  /** JS 堆占用（MB）；只有 Chromium 暴露该读数，取不到时为 `undefined`。 */
  readonly heapMB: number | undefined;
}

/**
 * 每个场景等待的渲染帧数。
 *
 * 质量监测的滑动窗口是 60 帧，多等 30 帧让窗口整体落在稳态上，避免把建场景那一帧算进去。
 */
const PERF_SETTLE_FRAMES = 90;

/** 矩阵使用的固定视角：所有场景从同一机位看同一片区域，读数才可比。 */
const PERF_CAMERA = { longitude: 116.4, latitude: 39.9, height: 900_000, pitch: -90 } as const;

/** 一个测量场景：搭建图层、可选切档，然后由探针统一等待与读数。 */
interface PerformanceScenario {
  readonly name: string;
  /** 本场景使用的质量档；省略表示沿用当前档。 */
  readonly profile?: QualityProfileId;
  /** 只覆盖分辨率缩放做隔离测量；与 `profile` 同时给出时先切档再覆盖。 */
  readonly resolutionScale?: number;
  /** 环境效果预设；省略表示晴。 */
  readonly environment?: VanillaEnvironmentPreset;
  /** 搭建场景；按图层 id 幂等，重复调用不会重复添加。 */
  readonly setup: (handles: ReadyHandles) => Promise<void>;
  /** 保留图层给下一个场景（用于"同一批图层、不同质量档"的成对测量）。 */
  readonly keepLayers?: boolean;
}

/** 性能矩阵需要的那部分 Viewer：只用来等瓦片加载收敛。 */
interface TileLoadingViewer {
  readonly scene?: {
    readonly globe?: {
      readonly tilesLoaded: boolean;
      readonly tileLoadProgressEvent: {
        addEventListener(listener: (pending: number) => void): () => void;
      };
    };
  };
}

/** 点位场景的确定性网格：同一片区域、同一数量，跨次运行可比。 */
function performancePoints(count: number): ExamplePointSpec[] {
  const points: ExamplePointSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    points.push({
      id: `perf-pt-${String(index)}`,
      longitude: 116 + ((index * 37) % 1_000) * 0.0006,
      latitude: 39.5 + ((index * 61) % 1_000) * 0.0006,
    });
  }
  return points;
}

/** CZML 场景：500 个带点图形的实体，走数据源渲染路径（与点位图层的批量集合不同）。 */
function performanceCzml(): readonly Record<string, unknown>[] {
  const packets: Record<string, unknown>[] = [{ id: 'document', version: '1.0' }];
  for (let entity = 0; entity < 500; entity += 1) {
    packets.push({
      id: `perf-czml-${String(entity)}`,
      position: {
        cartographicDegrees: [
          116 + (entity % 25) * 0.02,
          39.5 + Math.floor(entity / 25) * 0.02,
          60_000,
        ],
      },
      point: { pixelSize: 8, color: { rgba: [255, 214, 102, 255] } },
    });
  }
  return packets;
}

/** 读取 JS 堆占用；`performance.memory` 是非标准读数，且不含 GPU 显存。 */
function readHeapMB(): number | undefined {
  const memory = (performance as { readonly memory?: { readonly usedJSHeapSize: number } }).memory;
  return memory ? Math.round(memory.usedJSHeapSize / 1_048_576) : undefined;
}

/** 等瓦片加载收敛的上限：服务端不响应时不能让测量卡死。 */
const PERF_TILE_TIMEOUT_MS = 5_000;

/** 长任务计数器：统计主线程被占住超过 50 毫秒的任务数。 */
interface LongTaskCounter {
  /** 从零开始计数（每个场景只测自己的窗口）。 */
  reset(): void;
  /** 当前计数；环境不支持 Long Tasks API 时为 `undefined`。 */
  count(): number | undefined;
  /** 停止观察。 */
  disconnect(): void;
}

/**
 * 建立浏览器长任务计数器。
 *
 * 用的是浏览器的 Long Tasks API（目前只有 Chromium 实现），取不到时安静降级为 `undefined`，
 * 矩阵其余列照常给出——长任务是补充读数，不该因为它缺就让整张表不可用。
 */
function createLongTaskCounter(): LongTaskCounter {
  const supportedTypes = (
    PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }
  ).supportedEntryTypes;
  if (typeof PerformanceObserver !== 'function' || !supportedTypes?.includes('longtask')) {
    return { reset: () => undefined, count: () => undefined, disconnect: () => undefined };
  }
  let total = 0;
  const observer = new PerformanceObserver((list) => {
    total += list.getEntries().length;
  });
  observer.observe({ entryTypes: ['longtask'] });
  return {
    reset: () => {
      total = 0;
    },
    count: () => total,
    disconnect: () => {
      observer.disconnect();
    },
  };
}

/**
 * 等场景画完再采样。
 *
 * 瓦片在途时画面上要画的瓦片还少、渲染反而更便宜，直接采样会把"还没画完"读成稳态；
 * 显示不出来（没有 globe 或已经加载完）时立即返回。
 */
function waitForTiles(viewer: TileLoadingViewer, timeoutMs: number): Promise<void> {
  const globe = viewer.scene?.globe;
  if (!globe || globe.tilesLoaded) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      remove();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const remove = globe.tileLoadProgressEvent.addEventListener((pending: number) => {
      if (pending === 0) {
        finish();
      }
    });
  });
}

function isGeoJsonHandle(handle: LayerHandleLike): handle is GeoJsonHandleLike {
  return handle.type === 'geojson' && 'setData' in handle;
}

function isWmsHandle(handle: LayerHandleLike): handle is WmsHandleLike {
  return (
    handle.type === 'wms' &&
    'opacity' in handle &&
    'setOpacity' in handle &&
    'setFilter' in handle &&
    'reload' in handle
  );
}

export function createVanillaExampleController(
  dependencies: ExampleDependencies,
): VanillaExampleController {
  let container: string | HTMLElement | undefined;
  let map: ExampleMapLike | undefined;
  let geoJson: GeoJsonHandleLike | undefined;
  let wms: WmsHandleLike | undefined;
  let state: ExampleState = 'idle';
  let geoJsonVisible = true;
  let wmsOpacity = 0.72;
  let wmsFilterEnabled = false;
  let dataRevision = 0;
  let environment: VanillaEnvironmentPreset = 'clear';
  let lineOfSight: string | undefined;
  let camera: string | undefined;
  let points: string | undefined;
  let clusters: string | undefined;
  let czml: string | undefined;
  let clockReading: string | undefined;
  let entityPick: string | undefined;
  let entityPickScreen: string | undefined;
  let pickSubscription: (() => void) | undefined;
  const waitFrames = dependencies.waitFrames ?? requestFrames;
  let performance: string | undefined;
  let performanceMatrix: string | undefined;
  let batch: string | undefined;
  let terrain: string | undefined;
  let pointsHandle: PointsHandleLike | undefined;
  let pointsLabelsEnabled = true;
  let currentError: string | undefined;
  const listeners = new Set<(snapshot: VanillaExampleSnapshot) => void>();

  const snapshot = (): VanillaExampleSnapshot => {
    const value: VanillaExampleSnapshot = {
      state,
      layerCount: map?.layers.list().length ?? 0,
      geoJsonVisible,
      wmsOpacity,
      wmsFilterEnabled,
      dataRevision,
      environment,
      lineOfSight,
      camera,
      points,
      clusters,
      czml,
      clock: clockReading,
      entityPick,
      entityPickScreen,
      performance,
      performanceMatrix,
      batch,
      terrain,
    };
    return currentError ? { ...value, error: currentError } : value;
  };

  const notify = () => {
    const value = snapshot();
    for (const listener of listeners) {
      listener(value);
    }
  };

  const requireReady = (): ReadyHandles => {
    if (state !== 'ready' || !map || !geoJson || !wms) {
      throw new Error('The Vanilla example is not ready.');
    }
    return { geoJson, map, wms };
  };

  /** 应用环境预设；性能矩阵与面板按钮共用同一条路径，读数才与手动操作可比。 */
  const applyEnvironment = (target: ExampleMapLike, preset: VanillaEnvironmentPreset): void => {
    if (preset === 'clear') {
      target.environment.clearAll();
    } else if (preset === 'depthFog') {
      target.environment.set('depthFog', { density: 0.45, color: '#9fb6c8' });
    } else if (preset === 'haze') {
      target.environment.set('haze', { density: 0.0012, maxHeight: 800_000 });
    } else if (preset === 'rain') {
      target.environment.set('rain', { intensity: 'moderate', windDirection: 60 });
    } else {
      target.environment.set('snow', { intensity: 'light', flakeSize: 0.025 });
    }
  };

  /** 移除性能矩阵留下的全部图层；按前缀识别，矩阵中途失败也能清干净。 */
  const clearPerformanceLayers = async (handles: ReadyHandles): Promise<void> => {
    for (const info of handles.map.layers.list()) {
      if (info.id.startsWith('perf-')) {
        await handles.map.layers.remove(info.id);
      }
    }
  };

  const hasLayer = (handles: ReadyHandles, id: string): boolean =>
    handles.map.layers.list().some((layer) => layer.id === id);

  const ensurePoints = async (handles: ReadyHandles, count: number): Promise<void> => {
    const id = `perf-points-${String(count)}`;
    if (hasLayer(handles, id)) {
      return;
    }
    await handles.map.layers.add({ id, type: 'points', points: performancePoints(count) });
  };

  const ensurePolylines = async (handles: ReadyHandles): Promise<void> => {
    if (hasLayer(handles, 'perf-polylines')) {
      return;
    }
    const polylines = Array.from({ length: 2_000 }, (_, index) => {
      const west = 116 + (index % 40) * 0.01;
      const south = 39.5 + Math.floor(index / 40) * 0.01;
      return {
        id: `perf-line-${String(index)}`,
        positions: [
          { longitude: west, latitude: south },
          { longitude: west + 0.008, latitude: south + 0.004 },
          { longitude: west + 0.004, latitude: south + 0.008 },
        ],
      };
    });
    await handles.map.layers.add({ id: 'perf-polylines', type: 'polyline', polylines });
  };

  const ensureCzml = async (handles: ReadyHandles): Promise<void> => {
    if (hasLayer(handles, 'perf-czml')) {
      return;
    }
    await handles.map.layers.add({
      id: 'perf-czml',
      type: 'czml',
      data: performanceCzml(),
    });
  };

  const ensureWms = async (handles: ReadyHandles): Promise<void> => {
    if (hasLayer(handles, 'perf-wms')) {
      return;
    }
    await handles.map.layers.add({
      id: 'perf-wms',
      type: 'wms',
      url: dependencies.wmsUrl,
      layers: 'demo:coverage',
      parameters: { format: 'image/png', transparent: true },
    });
  };

  /** 组合场景：三层同时在场，用于观察叠加开销与降档效果。 */
  const ensureHeavyScene = async (handles: ReadyHandles): Promise<void> => {
    await ensurePoints(handles, 100_000);
    await ensureWms(handles);
  };

  /**
   * 浏览器端性能矩阵。
   *
   * 每个场景从同一机位测量 SDK 自己的帧采样读数：先冻住自动降档（否则测到的是"降档后"的开销），
   * 再等满一整个采样窗口。图层按 `perf-` 前缀统一回收。
   */
  const PERF_SCENARIOS: readonly PerformanceScenario[] = [
    { name: '空场景（椭球地形）', setup: () => Promise.resolve() },
    { name: '点位 5 000', setup: (handles) => ensurePoints(handles, 5_000) },
    { name: '点位 20 000', setup: (handles) => ensurePoints(handles, 20_000) },
    { name: '点位 100 000', setup: (handles) => ensurePoints(handles, 100_000) },
    { name: '折线 2 000', setup: ensurePolylines },
    { name: 'CZML 500 实体', setup: ensureCzml },
    { name: 'WMS 影像', setup: ensureWms },
    { name: '雨（环境效果）', environment: 'rain', setup: () => Promise.resolve() },
    {
      name: '点位 100 000 + 影像 + 雨',
      environment: 'rain',
      setup: ensureHeavyScene,
      keepLayers: true,
    },
    {
      name: '同上（low 档）',
      profile: 'low',
      environment: 'rain',
      setup: () => Promise.resolve(),
      keepLayers: true,
    },
    {
      // 隔离行：low 档与默认档差三项参数，这里只把分辨率缩放降到 0.75，
      // 用来判断"降档变慢"到底是分辨率造成的，还是别的参数。
      name: '同上（仅分辨率 0.75）',
      profile: 'default',
      resolutionScale: 0.75,
      environment: 'rain',
      setup: () => Promise.resolve(),
      keepLayers: true,
    },
    {
      // 对照行：同一批图层切回默认档再测一次。两次默认档读数的差值就是测量漂移，
      // 有它才能判断"切档后变快/变慢"是档位效果还是顺序与预热造成的。
      name: '同上（默认档·复测）',
      profile: 'default',
      environment: 'rain',
      setup: () => Promise.resolve(),
    },
  ];

  const start = async (
    nextContainer: string | HTMLElement,
    options: { terrain?: boolean; onCreated?: (created: ExampleMapLike) => void } = {},
  ) => {
    if (state === 'ready' || state === 'starting') {
      return;
    }
    container = nextContainer;
    state = 'starting';
    currentError = undefined;
    notify();

    const nextMap = dependencies.createMap({
      container: nextContainer,
      cesiumBaseUrl: '/cesium/',
      ...(options.terrain
        ? { terrain: { type: 'cesium-terrain', url: dependencies.terrainUrl } }
        : {}),
    });
    map = nextMap;
    // 同步回调：调用方在这里读到的地形 `pending` 才是"仍在加载"的真实状态，不会被后续 await 掩盖。
    options.onCreated?.(nextMap);

    try {
      const nextGeoJson = await nextMap.layers.add({
        id: 'example-geojson',
        type: 'geojson',
        data: dependencies.geoJsonUrl,
        style: {
          marker: { color: '#35d7a0', size: 15 },
          stroke: '#4ee2bd',
          strokeWidth: 3,
          fill: '#22a88455',
        },
      });
      const nextWms = await nextMap.layers.add({
        id: 'example-wms',
        type: 'wms',
        url: dependencies.wmsUrl,
        layers: 'demo:coverage',
        opacity: 0.72,
        parameters: { format: 'image/png', transparent: true },
        // 自定义请求头：示例用它验证鉴权头真的随瓦片请求发出（本地 fixture 会记录）。
        headers: { 'X-Example-Auth': EXAMPLE_AUTH_HEADER },
      });

      if (!isGeoJsonHandle(nextGeoJson) || !isWmsHandle(nextWms)) {
        throw new Error('The example received unexpected layer handles.');
      }

      geoJson = nextGeoJson;
      wms = nextWms;
      geoJsonVisible = true;
      wmsOpacity = nextWms.opacity;
      wmsFilterEnabled = false;
      dataRevision = 0;
      environment = 'clear';
      lineOfSight = undefined;
      camera = undefined;
      points = undefined;
      clusters = undefined;
      czml = undefined;
      clockReading = undefined;
      entityPick = undefined;
      entityPickScreen = undefined;
      performance = undefined;
      performanceMatrix = undefined;
      pickSubscription?.();
      pickSubscription = undefined;
      batch = undefined;
      terrain = undefined;
      pointsHandle = undefined;
      pointsLabelsEnabled = true;
      const target = nextMap.raw.viewer.dataSources?.get(0) ?? nextGeoJson;
      await nextMap.raw.viewer.flyTo(target);
      state = 'ready';
      notify();
    } catch (error: unknown) {
      currentError = errorMessage(error);
      state = 'error';
      await nextMap.destroy().catch(() => undefined);
      notify();
      throw error;
    }
  };

  const destroy = async () => {
    if (!map || state === 'idle') {
      return;
    }
    state = 'destroying';
    notify();
    pickSubscription?.();
    pickSubscription = undefined;
    await map.destroy();
    map = undefined;
    geoJson = undefined;
    wms = undefined;
    state = 'idle';
    notify();
  };

  return {
    start,
    async restart() {
      if (!container) {
        throw new Error('The Vanilla example has not been started.');
      }
      const restartContainer = container;
      await destroy();
      await start(restartContainer);
    },
    destroy,
    /**
     * 用 `createMap({ terrain })` 重建地图：先证明创建期声明的地形地址真的被请求、`ready` 可 await，
     * 再切回椭球地形（本地 fixture 只提供元数据，没有瓦片数据）。
     */
    async createWithTerrain() {
      if (!container) {
        throw new Error('The Vanilla example has not been started.');
      }
      const restartContainer = container;
      let pendingWhileLoading = false;
      await destroy();
      await start(restartContainer, {
        terrain: true,
        onCreated: (created) => {
          pendingWhileLoading = created.terrain.pending;
        },
      });
      const target = requireReady().map.terrain;
      await target.ready;
      terrain = `创建期声明 → ${target.type} / 加载中 pending=${String(pendingWhileLoading)} / 兑现后 pending=${String(target.pending)}`;
      await requireReady().map.terrain.set({ type: 'ellipsoid' });
      notify();
    },
    async replaceGeoJson() {
      const handles = requireReady();
      await handles.geoJson.setData(replacementGeoJson);
      dataRevision += 1;
      notify();
      const target = handles.map.raw.viewer.dataSources?.get(0) ?? handles.geoJson;
      await handles.map.raw.viewer.flyTo(target);
    },
    setGeoJsonVisible(visible) {
      requireReady().geoJson.setVisible(visible);
      geoJsonVisible = visible;
      notify();
    },
    setWmsOpacity(opacity) {
      requireReady().wms.setOpacity(opacity);
      wmsOpacity = opacity;
      notify();
    },
    setEnvironment(preset) {
      const handles = requireReady();
      applyEnvironment(handles.map, preset);
      environment = preset;
      notify();
    },
    async runLineOfSight() {
      const handles = requireReady();
      const result = await handles.map.analysis.run('line-of-sight', {
        from: { longitude: 116.3, latitude: 39.85, height: 600 },
        to: { longitude: 116.52, latitude: 40.02, height: 600 },
        samples: 32,
      });
      lineOfSight = result.visible
        ? `可见（最小余隙 ${result.minClearanceMeters.toFixed(1)} 米）`
        : `被遮挡（最小余隙 ${result.minClearanceMeters.toFixed(1)} 米，第 ${String(result.blockedAtIndex)} 个采样点）`;
      notify();
    },
    readCamera() {
      const handles = requireReady();
      const view = handles.map.camera.view;
      camera = `${view.longitude.toFixed(3)}, ${view.latitude.toFixed(3)} · ${String(Math.round(view.height))} 米 · 朝向 ${view.heading.toFixed(0)}°`;
      notify();
    },
    /** 添加一批带标签的点位（模拟"导入的点位表"）。 */
    async addPointLayer() {
      const handles = requireReady();
      const generated: ExamplePointSpec[] = [];
      for (let index = 0; index < 200; index += 1) {
        generated.push({
          id: `pt-${String(index)}`,
          // 在机场周边铺一片方形点位，便于观察聚合效果。
          longitude: 116.2 + (index % 20) * 0.01,
          latitude: 39.8 + Math.floor(index / 20) * 0.008,
          label: `P${String(index)}`,
        });
      }
      if (pointsHandle) {
        await handles.map.layers.remove(pointsHandle.id);
        pointsHandle = undefined;
      }
      const handle = await handles.map.layers.add({
        id: 'example-points',
        type: 'points',
        points: generated,
        labels: { enabled: pointsLabelsEnabled, maxLabels: 200 },
      });
      pointsHandle = handle;
      pointsLabelsEnabled = handle.labelCount > 0;
      points = `点位 ${String(handle.count)} / 标签 ${String(handle.labelCount)}`;
      notify();
    },
    togglePointLabels() {
      const handle = pointsHandle;
      if (!handle) {
        throw new Error('请先添加点位图层。');
      }
      pointsLabelsEnabled = !pointsLabelsEnabled;
      handle.setStyle({ labels: { enabled: pointsLabelsEnabled } });
      points = `点位 ${String(handle.count)} / 标签 ${String(handle.labelCount)}`;
      notify();
    },
    /** 按屏幕像素聚合并把结果作为新的点位图层渲染（自动 LOD 的最小形态）。 */
    clusterPoints() {
      const handles = requireReady();
      const perPixel = handles.map.camera.metersPerPixel;
      if (perPixel === undefined) {
        throw new Error('当前视角算不出每像素米数（相机未看向地表）。');
      }
      const source: GeoPoint[] = [];
      for (let index = 0; index < 2_000; index += 1) {
        source.push({
          longitude: 116 + ((index * 37) % 1_000) * 0.0005,
          latitude: 39.5 + ((index * 61) % 1_000) * 0.0005,
        });
      }
      const grouped = clusterPoints(source, { cellSizeMeters: perPixel * 48 });
      // 渲染：簇心作为点、大小随计数（这里用图层默认大小，业务可自行按 count 分档）。
      void handles.map.layers.add({
        id: 'example-clusters',
        type: 'points',
        points: grouped.map((cluster) => ({
          id: cluster.id,
          longitude: cluster.center.longitude,
          latitude: cluster.center.latitude,
        })),
      });
      clusters = `聚合 ${String(grouped.length)} 簇 / ${String(source.length)} 点（每簇 48 像素）`;
      notify();
    },
    /** 用 core 的 CZML 生成 + 图层，把一条轨迹交给 SDK 管理。 */
    async addCzmlLayer() {
      const handles = requireReady();
      const orbit = Array.from({ length: 60 }, (_, index) => ({
        longitude: 100 + index * 0.3,
        latitude: 20 + Math.sin(index / 5) * 8,
        height: 400_000 + index * 1_000,
      }));
      const document = czmlFromPositions('example-track', orbit, {
        intervalSeconds: 5,
        name: '示例轨迹',
        model: { url: 'https://example.com/placeholder.glb' },
      });
      const handle = await handles.map.layers.add({
        id: 'example-czml',
        type: 'czml',
        data: document,
      });
      czml = `实体 ${String(handle.entityCount)}（${String(orbit.length)} 个采样点）`;
      notify();
    },
    /**
     * 时钟探针：用 `SimulationClock` 驱动地图时钟，播放一条带点图形的 CZML 轨迹。
     *
     * 断言三件事，任何一条不成立都直接抛错（而不是写进读数里蒙混过去）：
     * 地图时间帧间真的推进了、推进量与源时钟一致（镜像成立）、播放期间 `animating` 为真。
     */
    async probeCzmlClock() {
      const handles = requireReady();
      const epochMs = Date.parse(CLOCK_PROBE_EPOCH);
      const orbit = Array.from({ length: CLOCK_PROBE_SAMPLES }, (_, index) => ({
        longitude: 116.2 + index * 0.03,
        latitude: 39.8 + Math.sin(index / 3) * 0.06,
        height: 60_000,
      }));
      const document = czmlFromPositions('clock-track', orbit, {
        epoch: CLOCK_PROBE_EPOCH,
        intervalSeconds: CLOCK_PROBE_INTERVAL_SECONDS,
        name: '时钟探针',
      });
      // SDK 只生成位置采样；点图形由业务在文档上追加，实体才可见、可拾取。
      const visible = document.map((packet, index) =>
        index === 0
          ? packet
          : { ...packet, point: { pixelSize: 14, color: { rgba: [255, 214, 102, 255] } } },
      );
      const handle = await handles.map.layers.add({
        id: 'example-czml-clock',
        type: 'czml',
        data: visible,
      });

      const source = new SimulationClock({
        mode: 'replay',
        startTime: epochMs,
        endTime: epochMs + (CLOCK_PROBE_SAMPLES - 1) * CLOCK_PROBE_INTERVAL_SECONDS * 1000,
        initialTime: epochMs,
        rate: CLOCK_PROBE_RATE,
      });
      const unbind = handles.map.clock.bind(source);
      try {
        source.play();
        const before = handles.map.clock.time;
        await waitFrames(CLOCK_PROBE_FRAMES);
        const after = handles.map.clock.time;
        const mirroredTime = source.snapshot.currentTime;
        const animating = handles.map.clock.snapshot.animating;

        if (after <= before) {
          throw new Error(`地图时钟没有随渲染帧推进：${String(before)} → ${String(after)}`);
        }
        if (mirroredTime !== after) {
          throw new Error(
            `地图时钟与源时钟不一致：源 ${String(mirroredTime)} / 地图 ${String(after)}`,
          );
        }
        if (!animating) {
          throw new Error('播放期间地图时钟的 animating 为 false。');
        }
        clockReading = `推进 ${String(after - before)} ms / 源时钟一致 / animating=${String(animating)} / 实体 ${String(handle.entityCount)}`;
      } finally {
        unbind();
        source.pause();
      }
      notify();
    },
    /** 布防实体拾取探针：加载静态实体、对准相机，并把点击坐标报给验收脚本。 */
    async armEntityPickProbe() {
      const handles = requireReady();
      const canvas = handles.map.raw.viewer.canvas;
      if (!canvas) {
        throw new Error('验收台拿不到画布，无法准备真实点击。');
      }
      const document = [
        { id: 'document', version: '1.0' },
        {
          id: PICK_PROBE_ENTITY_ID,
          name: '拾取探针',
          position: {
            cartographicDegrees: [
              PICK_PROBE_POSITION.longitude,
              PICK_PROBE_POSITION.latitude,
              PICK_PROBE_POSITION.height,
            ],
          },
          point: {
            pixelSize: 18,
            color: { rgba: [110, 220, 255, 255] },
            outlineColor: { rgba: [8, 24, 36, 255] },
            outlineWidth: 2,
          },
        },
      ];
      await handles.map.layers.add({ id: 'example-czml-pick', type: 'czml', data: document });

      entityPick = undefined;
      entityPickScreen = undefined;
      pickSubscription?.();
      // 先订阅再投影：布防之后的第一次点击就是探针要观察的那一次。
      pickSubscription = handles.map.picking.on('click', (event) => {
        const hit: PickingHit | undefined = event.hit;
        entityPick =
          hit?.kind === 'layer'
            ? `命中图层 ${hit.layerId ?? '(未知图层)'} / 实体 ${hit.objectId ?? '(无 id)'}`
            : `未命中托管图层（kind=${hit?.kind ?? 'none'}）`;
        entityPickScreen = undefined;
        notify();
      });

      handles.map.camera.setView({
        longitude: PICK_PROBE_POSITION.longitude,
        latitude: PICK_PROBE_POSITION.latitude,
        height: 90_000,
      });
      // 等实体真正进入渲染队列，否则投影出来的位置还不是它最终出现的地方。
      await waitFrames(2);
      const screen = handles.map.coordinates.toWindow(PICK_PROBE_POSITION);
      if (!screen) {
        throw new Error('探针实体不在视口内，无法投影出点击坐标。');
      }
      const rect = canvas.getBoundingClientRect();
      entityPickScreen = `${String(Math.round(rect.left + screen.x))},${String(Math.round(rect.top + screen.y))}`;
      notify();
    },
    /**
     * 浏览器端性能矩阵：固定机位、关自动降档，逐场景读 SDK 的帧采样。
     *
     * 关闭自动降档是关键——开着它测到的是"降档之后"的开销，会把重场景测得比轻场景还好看。
     * 结束后图层、环境与质量档都恢复原状，矩阵不在地图上留痕。
     */
    async measurePerformanceMatrix() {
      const handles = requireReady();
      const quality = handles.map.quality;
      const previousAdaptive = quality.adaptive;
      const previousQuality = quality.current;
      const rows: VanillaPerformanceRow[] = [];
      const longTasks = createLongTaskCounter();
      quality.setAdaptive(false);
      handles.map.camera.setView(PERF_CAMERA);
      notify();
      try {
        for (const scenario of PERF_SCENARIOS) {
          await scenario.setup(handles);
          applyEnvironment(handles.map, scenario.environment ?? 'clear');
          if (scenario.profile) {
            quality.setProfile(scenario.profile);
          }
          if (scenario.resolutionScale !== undefined) {
            quality.set({ resolutionScale: scenario.resolutionScale });
          }
          // 长任务只统计测量窗口：建场景（例如铺 10 万点）的开销不算进稳态读数。
          longTasks.reset();
          // 先等场景画完（瓦片收敛），再等满采样窗口；两步都做完读数才是稳态。
          await waitForTiles(handles.map.raw.viewer, PERF_TILE_TIMEOUT_MS);
          await waitFrames(PERF_SETTLE_FRAMES);
          const sample = quality.snapshot;
          rows.push({
            scenario: scenario.name,
            fps: Math.round(sample.fps * 10) / 10,
            frameTimeMs: Math.round(sample.frameTimeMs * 100) / 100,
            p50Ms: Math.round(sample.frameTimeP50Ms * 100) / 100,
            p95Ms: Math.round(sample.frameTimeP95Ms * 100) / 100,
            maxMs: Math.round(sample.frameTimeMaxMs * 100) / 100,
            longFrames: sample.longFrames,
            longTasks: longTasks.count(),
            samples: sample.sampleCount,
            heapMB: readHeapMB(),
          });
          if (!scenario.keepLayers) {
            await clearPerformanceLayers(handles);
          }
        }
      } finally {
        await clearPerformanceLayers(handles);
        applyEnvironment(handles.map, 'clear');
        environment = 'clear';
        longTasks.disconnect();
        quality.set(previousQuality);
        quality.setAdaptive(previousAdaptive);
        notify();
      }

      let slowest: VanillaPerformanceRow | undefined;
      let fastest: VanillaPerformanceRow | undefined;
      let worstFrame: VanillaPerformanceRow | undefined;
      for (const row of rows) {
        if (!slowest || row.fps < slowest.fps) {
          slowest = row;
        }
        if (!fastest || row.fps > fastest.fps) {
          fastest = row;
        }
        if (!worstFrame || row.maxMs > worstFrame.maxMs) {
          worstFrame = row;
        }
      }
      if (slowest && fastest && worstFrame) {
        // 摘要里带上最长帧：均值与 P95 都可能看不出单次顿挫，最长帧是最直观的那一个数。
        performance = `${String(rows.length)} 场景 · 最低 ${String(slowest.fps)} fps（${slowest.scenario}）· 最高 ${String(fastest.fps)} fps（${fastest.scenario}）· 最长帧 ${String(worstFrame.maxMs)} ms（${worstFrame.scenario}）`;
        performanceMatrix = JSON.stringify(rows);
      }
      notify();
    },
    /** 批量分析：20 个点各算一次坡度坡向，带进度读数。 */
    async runBatchAnalysis() {
      const handles = requireReady();
      const centers: GeoPoint[] = [];
      for (let index = 0; index < 20; index += 1) {
        centers.push({ longitude: 116.3 + index * 0.005, latitude: 39.9 + index * 0.002 });
      }
      const outcome = await runAnalysisBatch(
        handles.map.analysis,
        centers.map((center, index) => ({
          id: `cell-${String(index)}`,
          tool: 'slope-aspect' as const,
          input: { center, radiusMeters: 200 },
        })),
        { concurrency: 4 },
      );
      const ok = outcome.entries.filter((entry) => entry.ok).length;
      batch = `完成 ${String(ok)} / 失败 ${String(outcome.entries.length - ok)} / 总数 ${String(centers.length)}`;
      notify();
    },
    async setWmsFilterEnabled(enabled) {
      const handles = requireReady();
      await handles.wms.setFilter(enabled ? dependencies.createActiveFilter() : undefined);
      wmsFilterEnabled = enabled;
      notify();
    },
    async reloadWms() {
      await requireReady().wms.reload();
      notify();
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
}
