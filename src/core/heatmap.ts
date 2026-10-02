import { GisError } from './errors.js';
import type { GeoBBox, GeoPoint } from '../spatial/types.js';
import { MAX_BATCH_POINTS } from '../spatial/types.js';

/** 与 `clusterPoints()` 一致的米/度换算基准：球面平均半径。 */
const METERS_PER_DEGREE_LATITUDE = (2 * Math.PI * 6_371_008.8) / 360;

/** 长边像素数的取值范围。 */
const MIN_RESOLUTION = 16;
const MAX_RESOLUTION = 1_024;

/** 默认影响半径（米）与默认分辨率（长边像素）。 */
const DEFAULT_RADIUS_METERS = 800;
const DEFAULT_RESOLUTION = 256;

function invalidHeatmap(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'heatmap',
    operation,
  });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 热力图输入点位：经纬度加可选权重。 */
export interface HeatmapPoint extends GeoPoint {
  /**
   * 权重，默认 1；必须是非负有限数。
   *
   * 权重是相对量：`2` 的点在同一位置产生的密度是 `1` 的两倍，适合表达"计数 / 强度 / 重要度"。
   */
  readonly weight?: number;
}

/** 内置色带标识。 */
export type HeatmapColorRampId = 'thermal' | 'radar' | 'cool';

/** 自定义色带的一个色标。 */
export interface HeatmapColorStop {
  /** 密度比例，0 到 1；色标必须按 offset 升序且首尾覆盖 0 与 1。 */
  readonly offset: number;
  /** `#rgb` 或 `#rrggbb` 颜色。 */
  readonly color: string;
}

/** 色带：内置标识或自定义色标列表。 */
export type HeatmapColorRamp = HeatmapColorRampId | readonly HeatmapColorStop[];

/** 内置色带定义；可以整体取用，也可以自己写色标。 */
export const heatmapColorRamps: Readonly<Record<HeatmapColorRampId, readonly HeatmapColorStop[]>> =
  Object.freeze({
    thermal: Object.freeze([
      Object.freeze({ offset: 0, color: '#1d4ed8' }),
      Object.freeze({ offset: 0.3, color: '#06b6d4' }),
      Object.freeze({ offset: 0.55, color: '#22c55e' }),
      Object.freeze({ offset: 0.78, color: '#facc15' }),
      Object.freeze({ offset: 1, color: '#ef4444' }),
    ]),
    radar: Object.freeze([
      Object.freeze({ offset: 0, color: '#16a34a' }),
      Object.freeze({ offset: 0.5, color: '#facc15' }),
      Object.freeze({ offset: 0.75, color: '#f97316' }),
      Object.freeze({ offset: 1, color: '#dc2626' }),
    ]),
    cool: Object.freeze([
      Object.freeze({ offset: 0, color: '#0ea5e9' }),
      Object.freeze({ offset: 0.5, color: '#6366f1' }),
      Object.freeze({ offset: 1, color: '#d946ef' }),
    ]),
  });

/** 密度网格的构建参数。 */
export interface HeatmapGridOptions {
  /** 输入点位，至少一个；上限与批量点位一致（20 万）。 */
  readonly points: readonly HeatmapPoint[];
  /** 每个点的影响半径，单位为米，默认 800。 */
  readonly radiusMeters?: number;
  /**
   * 长边的像素（格）数，默认 256，范围 16 到 1024。
   *
   * 短边按覆盖范围的实际长宽比缩放，因此网格不会因为纬度或范围形状被拉伸。
   */
  readonly resolution?: number;
  /** 覆盖范围；省略时按点位包围盒外扩一个影响半径。 */
  readonly bounds?: GeoBBox;
}

/** 密度网格。 */
export interface HeatmapGrid {
  /** 网格宽度（列数）。 */
  readonly width: number;
  /** 网格高度（行数）；行 0 是北边，与图像行序一致。 */
  readonly height: number;
  /** 网格覆盖范围。 */
  readonly bounds: GeoBBox;
  /** 密度值，长度 `width * height`，行序为北到南。 */
  readonly density: Float32Array;
  /** 网格中的最大密度；用它归一化即可得到 0 到 1 的比例。 */
  readonly maxDensity: number;
  /** 参与计算的点数。 */
  readonly pointCount: number;
}

/** 栅格化参数。 */
export interface HeatmapColorizeOptions {
  /** 色带，默认 `'thermal'`。 */
  readonly colorRamp?: HeatmapColorRamp;
  /** 归一化上限；省略时用网格自己的 `maxDensity`。 */
  readonly maxDensity?: number;
  /** 整体透明度，0 到 1，默认 1；会乘到 alpha 上。 */
  readonly opacity?: number;
}

function parseHexColor(value: unknown, operation: string): [number, number, number] {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(text);
  const hexDigits = match?.[1];
  if (hexDigits === undefined || hexDigits === '') {
    throw invalidHeatmap(`Heatmap color "${text}" must be #rgb or #rrggbb.`, operation);
  }
  const hex = hexDigits;
  const expanded =
    hex.length === 3
      ? `${hex[0] ?? ''}${hex[0] ?? ''}${hex[1] ?? ''}${hex[1] ?? ''}${hex[2] ?? ''}${hex[2] ?? ''}`
      : hex;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function resolveRamp(
  ramp: HeatmapColorRamp | undefined,
  operation: string,
): readonly HeatmapColorStop[] {
  if (ramp === undefined) {
    return heatmapColorRamps.thermal;
  }
  if (typeof ramp === 'string') {
    const builtin = (
      heatmapColorRamps as Readonly<Record<string, readonly HeatmapColorStop[] | undefined>>
    )[ramp];
    if (!builtin) {
      throw invalidHeatmap(
        `Heatmap colorRamp "${ramp}" must be thermal, radar, cool, or an array of stops.`,
        operation,
      );
    }
    return builtin;
  }
  // Array.isArray 会把 readonly 数组收窄成 any[]，因此逐个重建校验后的色标数组。
  const candidates: unknown = ramp;
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 8) {
    throw invalidHeatmap('Heatmap colorRamp needs 2 to 8 stops.', operation);
  }
  const stops: HeatmapColorStop[] = [];
  let previousOffset = -1;
  for (const candidate of candidates) {
    const stop = candidate as { readonly offset?: unknown; readonly color?: unknown } | undefined;
    const offset = stop?.offset;
    if (!finiteNumber(offset) || offset < 0 || offset > 1 || offset <= previousOffset) {
      throw invalidHeatmap('Heatmap colorRamp stops must be sorted by offset in 0..1.', operation);
    }
    parseHexColor(stop?.color, operation);
    stops.push({ offset, color: stop?.color as string });
    previousOffset = offset;
  }
  if (stops[0]?.offset !== 0 || stops[stops.length - 1]?.offset !== 1) {
    throw invalidHeatmap(
      'Heatmap colorRamp must start at offset 0 and end at offset 1.',
      operation,
    );
  }
  return stops;
}

function metersPerDegreeLongitude(latitude: number): number {
  return METERS_PER_DEGREE_LATITUDE * Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
}

/**
 * 构建密度网格：把每个点的权重按**四次核**摊到影响半径内的格子上。
 *
 * 核函数 `(1 - d²/r²)²` 在半径处平滑归零，因此相邻点的密度叠加不会出现硬边；距离按
 * 点的纬度做米→度换算（与 `clusterPoints()` 同一套基准），在几十公里量级内足够精确。
 *
 * @throws `INVALID_SPATIAL_INPUT` 点位为空 / 超上限、经纬度或权重非法、半径或分辨率越界、
 * bounds 非法（含 west ≥ east）或带宽高为 0。
 */
export function buildHeatmapGrid(options: HeatmapGridOptions): HeatmapGrid {
  const requested = (options as HeatmapGridOptions | undefined) ?? ({} as HeatmapGridOptions);
  const rawPoints: unknown = requested.points;
  if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
    throw invalidHeatmap('Heatmap needs at least one point.', 'buildHeatmapGrid');
  }
  const points = rawPoints as readonly HeatmapPoint[];
  if (points.length > MAX_BATCH_POINTS) {
    throw invalidHeatmap(
      `Heatmap accepts at most ${String(MAX_BATCH_POINTS)} points.`,
      'buildHeatmapGrid',
    );
  }
  const radiusMeters = requested.radiusMeters ?? DEFAULT_RADIUS_METERS;
  if (!finiteNumber(radiusMeters) || radiusMeters <= 0) {
    throw invalidHeatmap(
      'Heatmap radiusMeters must be a positive finite number.',
      'buildHeatmapGrid',
    );
  }
  const resolution = requested.resolution ?? DEFAULT_RESOLUTION;
  if (
    !Number.isSafeInteger(resolution) ||
    resolution < MIN_RESOLUTION ||
    resolution > MAX_RESOLUTION
  ) {
    throw invalidHeatmap(
      `Heatmap resolution must be an integer between ${String(MIN_RESOLUTION)} and ${String(MAX_RESOLUTION)}.`,
      'buildHeatmapGrid',
    );
  }

  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [index, candidate] of points.entries()) {
    const point = candidate as
      | { readonly longitude?: unknown; readonly latitude?: unknown; readonly weight?: unknown }
      | undefined;
    if (
      !point ||
      !finiteNumber(point.longitude) ||
      !finiteNumber(point.latitude) ||
      Math.abs(point.longitude) > 180 ||
      Math.abs(point.latitude) > 90
    ) {
      throw invalidHeatmap(
        `Heatmap point ${String(index)} needs longitude in -180..180 and latitude in -90..90.`,
        'buildHeatmapGrid',
      );
    }
    const weight = point.weight ?? 1;
    if (!finiteNumber(weight) || weight < 0) {
      throw invalidHeatmap(
        `Heatmap point ${String(index)} weight must be a non-negative finite number.`,
        'buildHeatmapGrid',
      );
    }
    west = Math.min(west, point.longitude);
    east = Math.max(east, point.longitude);
    south = Math.min(south, point.latitude);
    north = Math.max(north, point.latitude);
  }

  if (requested.bounds !== undefined) {
    const { west: bWest, east: bEast, south: bSouth, north: bNorth } = requested.bounds;
    if (
      !finiteNumber(bWest) ||
      !finiteNumber(bEast) ||
      !finiteNumber(bSouth) ||
      !finiteNumber(bNorth) ||
      bWest < -180 ||
      bEast > 180 ||
      bSouth < -90 ||
      bNorth > 90 ||
      bWest >= bEast ||
      bSouth >= bNorth
    ) {
      throw invalidHeatmap('Heatmap bounds must be valid WGS84 degree bounds.', 'buildHeatmapGrid');
    }
    west = bWest;
    east = bEast;
    south = bSouth;
    north = bNorth;
  } else {
    // 默认范围：包围盒外扩一个影响半径；点重合时也能得到一个非零范围。
    const centerLatitude = (south + north) / 2;
    const latitudePadding = radiusMeters / METERS_PER_DEGREE_LATITUDE;
    const longitudePadding = radiusMeters / metersPerDegreeLongitude(centerLatitude);
    west = Math.max(-180, west - longitudePadding);
    east = Math.min(180, east + longitudePadding);
    south = Math.max(-90, south - latitudePadding);
    north = Math.min(90, north + latitudePadding);
  }

  const centerLatitude = (south + north) / 2;
  const extentXMeters = (east - west) * metersPerDegreeLongitude(centerLatitude);
  const extentYMeters = (north - south) * METERS_PER_DEGREE_LATITUDE;
  const longerSide = Math.max(extentXMeters, extentYMeters);
  if (!(longerSide > 0)) {
    throw invalidHeatmap('Heatmap bounds collapse to zero area.', 'buildHeatmapGrid');
  }
  const cellSizeMeters = longerSide / resolution;
  const width = Math.max(1, Math.round(extentXMeters / cellSizeMeters));
  const height = Math.max(1, Math.round(extentYMeters / cellSizeMeters));

  const density = new Float32Array(width * height);
  const degreesPerCellX = (east - west) / width;
  const degreesPerCellY = (north - south) / height;
  let maxDensity = 0;

  for (const point of points) {
    const weight = point.weight ?? 1;
    if (weight === 0) {
      continue;
    }
    const metersPerDegreeX = metersPerDegreeLongitude(point.latitude);
    const radiusDegreesX = radiusMeters / metersPerDegreeX;
    const radiusDegreesY = radiusMeters / METERS_PER_DEGREE_LATITUDE;
    const minColumn = Math.max(
      0,
      Math.floor((point.longitude - radiusDegreesX - west) / degreesPerCellX),
    );
    const maxColumn = Math.min(
      width - 1,
      Math.ceil((point.longitude + radiusDegreesX - west) / degreesPerCellX),
    );
    const minRow = Math.max(
      0,
      Math.floor((north - radiusDegreesY - point.latitude) / degreesPerCellY),
    );
    const maxRow = Math.min(
      height - 1,
      Math.ceil((north + radiusDegreesY - point.latitude) / degreesPerCellY),
    );

    for (let row = minRow; row <= maxRow; row += 1) {
      const cellLatitude = north - (row + 0.5) * degreesPerCellY;
      const dy = (cellLatitude - point.latitude) * METERS_PER_DEGREE_LATITUDE;
      for (let column = minColumn; column <= maxColumn; column += 1) {
        const cellLongitude = west + (column + 0.5) * degreesPerCellX;
        const dx = (cellLongitude - point.longitude) * metersPerDegreeX;
        const ratioSquared = (dx * dx + dy * dy) / (radiusMeters * radiusMeters);
        if (ratioSquared >= 1) {
          continue;
        }
        const falloff = (1 - ratioSquared) * (1 - ratioSquared);
        const index = row * width + column;
        density[index] = (density[index] ?? 0) + weight * falloff;
      }
    }
  }

  // 最大值从**存储后**的网格取：密度存在 Float32Array 里，用累加用的 double 会与
  // 调用方读到的峰值差一丝，归一化时对不上。
  for (const value of density) {
    maxDensity = Math.max(maxDensity, value);
  }

  return Object.freeze({
    width,
    height,
    bounds: Object.freeze({ west, south, east, north }),
    density,
    maxDensity,
    pointCount: points.length,
  });
}

/**
 * 把密度网格着色成 RGBA 像素（行序北到南，与图像一致）。
 *
 * 颜色由色带按归一化密度插值得到；**alpha 也随密度增长**（`alpha = t × opacity`），
 * 因此密度为零的格子完全透明，影像图层叠加时不会遮住底图。
 *
 * @throws `INVALID_SPATIAL_INPUT` 色带非法、`maxDensity` 非正或 `opacity` 越界。
 */
export function colorizeHeatmap(
  grid: HeatmapGrid,
  options: HeatmapColorizeOptions = {},
): Uint8ClampedArray {
  const stops = resolveRamp(options.colorRamp, 'colorizeHeatmap');
  const opacity = options.opacity ?? 1;
  if (!finiteNumber(opacity) || opacity < 0 || opacity > 1) {
    throw invalidHeatmap('Heatmap opacity must be between 0 and 1.', 'colorizeHeatmap');
  }
  const limit = options.maxDensity ?? grid.maxDensity;
  if (!finiteNumber(limit) || limit <= 0) {
    throw invalidHeatmap('Heatmap maxDensity must be a positive finite number.', 'colorizeHeatmap');
  }

  const colors = stops.map((stop) => ({
    offset: stop.offset,
    rgb: parseHexColor(stop.color, 'colorizeHeatmap'),
  }));
  const pixels = new Uint8ClampedArray(grid.width * grid.height * 4);

  for (let index = 0; index < grid.density.length; index += 1) {
    const value = grid.density[index] ?? 0;
    const ratio = Math.min(1, Math.max(0, value / limit));
    if (ratio === 0) {
      continue;
    }
    let upper = 1;
    while (upper < colors.length - 1 && (colors[upper]?.offset ?? 1) < ratio) {
      upper += 1;
    }
    const low = colors[upper - 1] ?? colors[0];
    const high = colors[upper] ?? low;
    if (!low || !high) {
      continue;
    }
    const span = high.offset - low.offset;
    const local = span <= 0 ? 0 : (ratio - low.offset) / span;
    const offset = index * 4;
    pixels[offset] = low.rgb[0] + (high.rgb[0] - low.rgb[0]) * local;
    pixels[offset + 1] = low.rgb[1] + (high.rgb[1] - low.rgb[1]) * local;
    pixels[offset + 2] = low.rgb[2] + (high.rgb[2] - low.rgb[2]) * local;
    pixels[offset + 3] = Math.round(ratio * opacity * 255);
  }

  return pixels;
}
