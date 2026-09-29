import { GisError } from '../core/errors.js';
import type { GeoPosition } from '../core/controls.js';

/**
 * 空间计算使用的 WGS84 点。
 *
 * 与 {@link GeoPosition} 同构，可直接互传；不使用 `[经度, 纬度]` 数组，
 * 避免经纬颠倒这类静默算错的失效模式。
 *
 * 在投影坐标（如高斯带、UTM）语境下，`longitude` / `latitude` 字段按该 CRS 的含义解释：
 * 分别是东坐标与北坐标，单位为米。见 `transformGeoPoint`。
 */
export type GeoPoint = GeoPosition;

/** 顶点环或折线；首尾顶点可以重复，也可以不闭合。 */
export type GeoRing = readonly GeoPoint[];

/** 带洞多边形；`outer` 为外环，`holes` 为内环（洞）。 */
export interface GeoPolygon {
  /** 外环顶点，至少 3 个不重复顶点。 */
  readonly outer: GeoRing;
  /** 内环顶点；每个内环至少 3 个不重复顶点。 */
  readonly holes?: readonly GeoRing[];
}

/** 经纬度包围盒，使用 WGS84 度数。 */
export interface GeoBBox {
  /** 西边界经度。 */
  readonly west: number;
  /** 东边界经度。 */
  readonly east: number;
  /** 南边界纬度。 */
  readonly south: number;
  /** 北边界纬度。 */
  readonly north: number;
}

/** 单次批量计算的输入点数上限；超过时抛 `INVALID_SPATIAL_INPUT`。 */
export const MAX_BATCH_POINTS = 200_000;

/** 单个环或折线的顶点数上限；超过时抛 `INVALID_SPATIAL_INPUT`。 */
export const MAX_GEOMETRY_VERTICES = 200_000;

/**
 * 空间分析的算法版本。
 *
 * 下游在记录分析结果时应一并保存该值，便于回归对照；纯计算函数不逐个返回该字段。
 */
export const SPATIAL_ALGORITHM_VERSION = 1;

/** @internal */
export function spatialError(
  message: string,
  code:
    'INVALID_SPATIAL_INPUT' | 'INVALID_COORDINATES' | 'UNSUPPORTED_CRS' | 'INVALID_CRS_DEFINITION',
  operation: string,
  cause?: unknown,
): GisError {
  return new GisError(message, {
    code,
    module: 'spatial',
    operation,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** @internal */
export function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
