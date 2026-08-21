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

interface ExampleMapLike {
  readonly state: string;
  readonly layers: {
    add(spec: unknown): Promise<GeoJsonHandleLike | WmsHandleLike>;
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

export interface VanillaExampleSnapshot {
  readonly state: ExampleState;
  readonly layerCount: number;
  readonly geoJsonVisible: boolean;
  readonly wmsOpacity: number;
  readonly wmsFilterEnabled: boolean;
  readonly dataRevision: number;
  readonly error?: string;
}

export interface VanillaExampleController {
  start(container: string | HTMLElement): Promise<void>;
  restart(): Promise<void>;
  destroy(): Promise<void>;
  replaceGeoJson(): Promise<void>;
  setGeoJsonVisible(visible: boolean): void;
  setWmsOpacity(opacity: number): void;
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
  let currentError: string | undefined;
  const listeners = new Set<(snapshot: VanillaExampleSnapshot) => void>();

  const snapshot = (): VanillaExampleSnapshot => {
    const value = {
      state,
      layerCount: map?.layers.list().length ?? 0,
      geoJsonVisible,
      wmsOpacity,
      wmsFilterEnabled,
      dataRevision,
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

      if (nextGeoJson.type !== 'geojson' || nextWms.type !== 'wms') {
        throw new Error('The example received unexpected layer handles.');
      }

      geoJson = nextGeoJson;
      wms = nextWms;
      geoJsonVisible = true;
      wmsOpacity = nextWms.opacity;
      wmsFilterEnabled = false;
      dataRevision = 0;
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
