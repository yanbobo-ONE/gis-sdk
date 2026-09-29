import type { GisMap, MapEngineAdapter } from '../core/contracts.js';
import { GisError } from '../core/errors.js';
import { resolveRenderQuality } from '../core/quality.js';
import type { RenderQuality } from '../core/quality.js';
import { MapRuntime } from '../core/map-runtime.js';
import { CesiumMapAdapter } from './cesium-map-adapter.js';
import type { QualityOptions } from './types.js';
import type {
  CesiumMap,
  CesiumSceneMode,
  CesiumWidgetOptions,
  CreateMapOptions,
  NormalizedQualityOptions,
  XyzBasemapSpec,
} from './types.js';

type NormalizedWidgetOptions = Readonly<Required<CesiumWidgetOptions>>;

/** @internal */
export interface NormalizedCreateMapOptions {
  readonly container: string | HTMLElement;
  readonly id: string;
  readonly cesiumBaseUrl?: string;
  readonly scene: Readonly<{ mode: CesiumSceneMode }>;
  readonly widgets: NormalizedWidgetOptions;
  readonly quality: Readonly<RenderQuality>;
  readonly qualityAdaptive: boolean;
  readonly basemap?: Readonly<XyzBasemapSpec>;
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

function invalidBasemap(
  message: string,
  code: 'INVALID_BASEMAP_CONFIG' | 'INVALID_BASEMAP_OPACITY',
) {
  return new GisError(message, {
    code,
    module: 'basemap',
    operation: 'createMap',
  });
}

function normalizeBasemap(spec: XyzBasemapSpec): Readonly<XyzBasemapSpec> {
  const type = (spec as unknown as { readonly type: string }).type;
  if (type !== 'xyz') {
    throw invalidBasemap('Initial basemap type must be xyz.', 'INVALID_BASEMAP_CONFIG');
  }

  const url = typeof spec.url === 'string' ? spec.url.trim() : '';
  if (!url || !url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
    throw invalidBasemap(
      'XYZ basemap URL must contain {z}, {x}, and {y} placeholders.',
      'INVALID_BASEMAP_CONFIG',
    );
  }
  if (
    spec.opacity !== undefined &&
    (!Number.isFinite(spec.opacity) || spec.opacity < 0 || spec.opacity > 1)
  ) {
    throw invalidBasemap(
      'Basemap opacity must be a finite number between 0 and 1.',
      'INVALID_BASEMAP_OPACITY',
    );
  }
  if (spec.visible !== undefined && typeof spec.visible !== 'boolean') {
    throw invalidBasemap('Basemap visibility must be a boolean.', 'INVALID_BASEMAP_CONFIG');
  }

  return Object.freeze({ ...spec, url });
}

function normalizeQuality(options: QualityOptions | undefined): NormalizedQualityOptions {
  const quality = resolveRenderQuality(options?.profile ?? 'default', {
    ...(options?.resolutionScale === undefined ? {} : { resolutionScale: options.resolutionScale }),
    ...(options?.terrainSse === undefined ? {} : { terrainSse: options.terrainSse }),
    ...(options?.modelLoadConcurrency === undefined
      ? {}
      : { modelLoadConcurrency: options.modelLoadConcurrency }),
  });
  const adaptive = options?.adaptive ?? true;
  if (typeof adaptive !== 'boolean') {
    throw new GisError('Quality adaptive must be a boolean.', {
      code: 'INVALID_QUALITY_CONFIG',
      module: 'quality',
      operation: 'createMap',
    });
  }
  return { quality, qualityAdaptive: adaptive };
}

function normalizeOptions(options: CreateMapOptions): NormalizedCreateMapOptions {
  const cesiumBaseUrl = normalizeBaseUrl(options.cesiumBaseUrl);
  const basemap = options.basemap ? normalizeBasemap(options.basemap) : undefined;
  const normalizedOptions = {
    container: normalizeContainer(options.container),
    id: options.id ?? globalThis.crypto.randomUUID(),
    scene: Object.freeze({ mode: options.scene?.mode ?? '3d' }),
    widgets: Object.freeze({ ...defaultWidgets, ...options.widgets }),
    ...normalizeQuality(options.quality),
    ...(basemap ? { basemap } : {}),
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
