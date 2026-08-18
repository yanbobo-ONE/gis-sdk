import type { GisMap, MapEngineAdapter } from '../core/contracts.js';
import { GisError } from '../core/errors.js';
import { MapRuntime } from '../core/map-runtime.js';
import { CesiumMapAdapter } from './cesium-map-adapter.js';
import type { CesiumMap, CesiumSceneMode, CesiumWidgetOptions, CreateMapOptions } from './types.js';

type NormalizedWidgetOptions = Readonly<Required<CesiumWidgetOptions>>;

/** @internal */
export interface NormalizedCreateMapOptions {
  readonly container: string | HTMLElement;
  readonly id: string;
  readonly cesiumBaseUrl?: string;
  readonly scene: Readonly<{ mode: CesiumSceneMode }>;
  readonly widgets: NormalizedWidgetOptions;
}

/** @internal */
export type MapAdapterFactory<TRaw> = (
  options: NormalizedCreateMapOptions,
) => MapEngineAdapter<TRaw>;

const defaultWidgets: NormalizedWidgetOptions = Object.freeze({
  animation: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  selectionIndicator: false,
  timeline: false,
});

function normalizeContainer(container: string | HTMLElement): string | HTMLElement {
  if (typeof container !== 'string') {
    return container;
  }

  const normalizedContainer = container.trim();
  if (normalizedContainer.length === 0) {
    throw new GisError('Map container must be a non-empty element id or HTMLElement.', {
      code: 'INVALID_CONTAINER',
      module: 'cesium',
      operation: 'createMap',
    });
  }

  return normalizedContainer;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return undefined;
  }

  try {
    const url = new URL(normalizedValue);
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
    return url.toString();
  } catch {
    return `${normalizedValue.replace(/\/+$/u, '')}/`;
  }
}

function normalizeOptions(options: CreateMapOptions): NormalizedCreateMapOptions {
  const cesiumBaseUrl = normalizeBaseUrl(options.cesiumBaseUrl);
  const normalizedOptions = {
    container: normalizeContainer(options.container),
    id: options.id ?? globalThis.crypto.randomUUID(),
    scene: Object.freeze({ mode: options.scene?.mode ?? '3d' }),
    widgets: Object.freeze({ ...defaultWidgets, ...options.widgets }),
  } satisfies Omit<NormalizedCreateMapOptions, 'cesiumBaseUrl'>;

  return Object.freeze(cesiumBaseUrl ? { ...normalizedOptions, cesiumBaseUrl } : normalizedOptions);
}

/** @internal */
export function createMapWithFactory<TRaw>(
  options: CreateMapOptions,
  factory: MapAdapterFactory<TRaw>,
): GisMap<TRaw> {
  const normalizedOptions = normalizeOptions(options);
  return new MapRuntime(normalizedOptions.id, factory(normalizedOptions));
}

/**
 * 创建一个可直接使用的 Cesium 地图实例。
 *
 * 默认不创建在线底图，也不启用 Cesium ion，因此无需 ion token 即可启动空白地球。
 *
 * @example
 * ```ts
 * const map = createMap({
 *   container: 'map',
 *   cesiumBaseUrl: '/cesium/',
 * })
 *
 * map.resize()
 * await map.destroy()
 * ```
 *
 * @throws {@link GisError} 容器为空，或与已经锁定的 Cesium 静态资源地址冲突时抛出。
 */
export function createMap(options: CreateMapOptions): CesiumMap {
  return createMapWithFactory(options, (normalizedOptions) => {
    return new CesiumMapAdapter(normalizedOptions);
  });
}
