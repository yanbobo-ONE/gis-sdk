import type { GisMap, MapEngineAdapter } from '../core/contracts.js';
import type { TerrainSpec } from '../core/controls.js';
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
  /** 长帧读数阈值；省略时由质量监测取默认值 50。 */
  readonly qualityLongFrameMs?: number;
  readonly basemap?: Readonly<XyzBasemapSpec>;
  readonly terrain?: Readonly<TerrainSpec>;
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

function invalidTerrain(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_TERRAIN_CONFIG',
    module: 'terrain',
    operation: 'createMap',
  });
}

function normalizeTerrain(spec: TerrainSpec): Readonly<TerrainSpec> {
  const requested = spec as unknown as {
    readonly type: string;
    readonly url?: unknown;
    readonly requestVertexNormals?: unknown;
    readonly requestWaterMask?: unknown;
  };
  if (requested.type === 'ellipsoid') {
    return Object.freeze({ type: 'ellipsoid' });
  }
  if (requested.type !== 'cesium-terrain') {
    throw invalidTerrain('Initial terrain type must be "ellipsoid" or "cesium-terrain".');
  }

  const url = typeof requested.url === 'string' ? requested.url.trim() : '';
  if (!url) {
    throw invalidTerrain('Cesium terrain URL must be non-empty.');
  }

  const requestVertexNormals = requested.requestVertexNormals;
  if (requestVertexNormals !== undefined && typeof requestVertexNormals !== 'boolean') {
    throw invalidTerrain('Terrain requestVertexNormals must be a boolean.');
  }
  const requestWaterMask = requested.requestWaterMask;
  if (requestWaterMask !== undefined && typeof requestWaterMask !== 'boolean') {
    throw invalidTerrain('Terrain requestWaterMask must be a boolean.');
  }

  // 按已知字段重建：未知键不会透传进地形服务请求。
  return Object.freeze({
    type: 'cesium-terrain',
    url,
    ...(requestVertexNormals === undefined ? {} : { requestVertexNormals }),
    ...(requestWaterMask === undefined ? {} : { requestWaterMask }),
  });
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
  const longFrameMs = options?.longFrameMs;
  if (longFrameMs !== undefined && (!Number.isFinite(longFrameMs) || longFrameMs <= 0)) {
    throw new GisError('Quality longFrameMs must be a positive finite number.', {
      code: 'INVALID_QUALITY_CONFIG',
      module: 'quality',
      operation: 'createMap',
    });
  }
  return {
    quality,
    qualityAdaptive: adaptive,
    ...(longFrameMs === undefined ? {} : { qualityLongFrameMs: longFrameMs }),
  };
}

function normalizeOptions(options: CreateMapOptions): NormalizedCreateMapOptions {
  const cesiumBaseUrl = normalizeBaseUrl(options.cesiumBaseUrl);
  const basemap = options.basemap ? normalizeBasemap(options.basemap) : undefined;
  const terrain = options.terrain ? normalizeTerrain(options.terrain) : undefined;
  const normalizedOptions = {
    container: normalizeContainer(options.container),
    id: options.id ?? globalThis.crypto.randomUUID(),
    scene: Object.freeze({ mode: options.scene?.mode ?? '3d' }),
    widgets: Object.freeze({ ...defaultWidgets, ...options.widgets }),
    ...normalizeQuality(options.quality),
    ...(basemap ? { basemap } : {}),
    ...(terrain ? { terrain } : {}),
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
 * 底图瓦片与地形服务的地址都由调用方通过 `basemap` / `terrain` 给出，SDK 不内置任何
 * 外部服务地址。
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
