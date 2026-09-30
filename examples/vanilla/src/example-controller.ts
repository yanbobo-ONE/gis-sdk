import { clusterPoints, czmlFromPositions, runAnalysisBatch } from '@yanbobo/gis-sdk/core';
import type {
  AnalysisController,
  CameraController,
  EnvironmentController,
  GeoPoint,
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
  readonly camera: Pick<CameraController, 'view' | 'metersPerPixel'>;
  readonly environment: Pick<EnvironmentController, 'set' | 'clearAll'>;
  /** 创建期地形的读数与切换：示例验证 `ready` / `pending` / `set` 确实随发布包一起可用。 */
  readonly terrain: Pick<TerrainController, 'type' | 'pending' | 'ready' | 'set'>;
  readonly analysis: AnalysisController;
  readonly layers: Pick<LayerManager, 'add' | 'list' | 'remove'>;
  readonly raw: {
    readonly viewer: {
      readonly dataSources?: { get(index: number): unknown };
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

  const requireReady = () => {
    if (state !== 'ready' || !map || !geoJson || !wms) {
      throw new Error('The Vanilla example is not ready.');
    }
    return { geoJson, map, wms };
  };

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
      if (preset === 'clear') {
        handles.map.environment.clearAll();
      } else if (preset === 'depthFog') {
        handles.map.environment.set('depthFog', { density: 0.45, color: '#9fb6c8' });
      } else if (preset === 'haze') {
        handles.map.environment.set('haze', { density: 0.0012, maxHeight: 800_000 });
      } else if (preset === 'rain') {
        handles.map.environment.set('rain', { intensity: 'moderate', windDirection: 60 });
      } else {
        handles.map.environment.set('snow', { intensity: 'light', flakeSize: 0.025 });
      }
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
