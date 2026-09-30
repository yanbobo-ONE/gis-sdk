import type {
  AnalysisInputMap,
  AnalysisResultMap,
  EnvironmentEffectKind,
  EnvironmentEffectState,
} from '@yanbobo/gis-sdk/core';
import type { GeoJsonLayerSpec, WmsLayerSpec } from '@yanbobo/gis-sdk/layers';

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

type ExampleLayerSpec = GeoJsonLayerSpec | WmsLayerSpec;

/** 相机位姿读数（`map.camera.view`）。 */
interface CameraViewLike {
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly heading: number;
  readonly pitch: number;
  readonly roll: number;
}

interface ExampleMapLike {
  readonly state: string;
  readonly camera: { readonly view: CameraViewLike };
  readonly environment: {
    set(kind: EnvironmentEffectKind, options?: Record<string, unknown>): EnvironmentEffectState;
    clearAll(): void;
  };
  /** 示例只用到通视分析；其它工具按同一形状接入即可。 */
  readonly analysis: {
    run(
      tool: 'line-of-sight',
      input: AnalysisInputMap['line-of-sight'],
    ): Promise<AnalysisResultMap['line-of-sight']>;
  };
  readonly layers: {
    add(spec: ExampleLayerSpec): Promise<LayerHandleLike>;
    list(): readonly LayerInfoLike[];
  };
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
  }) => ExampleMapLike;
  readonly createActiveFilter: () => unknown;
  readonly geoJsonUrl: string;
  readonly wmsUrl: string;
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

  const start = async (nextContainer: string | HTMLElement) => {
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
    });
    map = nextMap;

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
