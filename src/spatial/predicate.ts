import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import rewind from '@turf/rewind';
import type { Feature, Polygon } from 'geojson';

import { polygonFeatureOf, pointFeatureOf, toGeoPoint, toPositions, toRing } from './geojson.js';
import { measureBBox } from './measure.js';
import type { GeoPoint, GeoPolygon, GeoRing } from './types.js';
import { MAX_BATCH_POINTS, spatialError } from './types.js';

/** 点在多边形内判断的选项。 */
export interface PointInPolygonOptions {
  /**
   * 是否忽略边界，默认 `false`（边界点算命中）。
   *
   * 设为 `true` 时落在环上的点返回 `false`，适合"必须严格落在区内"的判定。
   */
  readonly ignoreBoundary?: boolean;
}

/** 批量点面判断结果。 */
export interface FilterPointsInPolygonResult {
  /** 命中点在输入数组中的下标，升序。 */
  readonly indexes: readonly number[];
  /** 命中的点，顺序与 `indexes` 一致。 */
  readonly points: readonly GeoPoint[];
  /** 命中数量，等于 `indexes.length`。 */
  readonly count: number;
}

/** 环绕向。 */
export type RingWinding = 'clockwise' | 'counterclockwise';

function requirePoints(points: unknown, operation: string): GeoPoint[] {
  if (!Array.isArray(points)) {
    throw spatialError(
      'Spatial points must be an array of vertices.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  if (points.length > MAX_BATCH_POINTS) {
    throw spatialError(
      `Spatial points exceed the ${String(MAX_BATCH_POINTS)} point limit; split the batch first.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  return toPositions(points, operation, 'points', 0).map(toGeoPoint);
}

/**
 * 判断点是否落在多边形内，支持外环与内环（洞）。
 *
 * @param point - 待判断点。
 * @param polygon - 带洞多边形；只传外环时用 `{ outer: ring }`。
 * @param options - 边界点归属配置。
 * @returns 是否命中。
 * @throws `INVALID_COORDINATES` 坐标非法；`INVALID_SPATIAL_INPUT` 多边形顶点不足或形状不对。
 */
export function isPointInPolygon(
  point: GeoPoint,
  polygon: GeoPolygon,
  options: PointInPolygonOptions = {},
): boolean {
  const operation = 'isPointInPolygon';
  return booleanPointInPolygon(
    pointFeatureOf(point, operation),
    polygonFeatureOf(polygon, operation),
    { ignoreBoundary: options.ignoreBoundary === true },
  );
}

/**
 * 批量判断点是否落在多边形内。
 *
 * 先用多边形包围盒做预筛，只有落在包围盒内的点才进入逐点判断；万级点位下这一步
 * 省掉大部分开销。
 *
 * @param points - 待判断点集，数量上限见 {@link MAX_BATCH_POINTS}。
 * @param polygon - 带洞多边形。
 * @param options - 边界点归属配置。
 * @returns 命中下标、命中点与命中数量。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function filterPointsInPolygon(
  points: readonly GeoPoint[],
  polygon: GeoPolygon,
  options: PointInPolygonOptions = {},
): FilterPointsInPolygonResult {
  const operation = 'filterPointsInPolygon';
  const candidates = requirePoints(points, operation);
  const feature = polygonFeatureOf(polygon, operation);
  const bounds = measureBBox(polygon);

  const indexes: number[] = [];
  const hits: GeoPoint[] = [];
  candidates.forEach((candidate, index) => {
    if (
      candidate.longitude < bounds.west ||
      candidate.longitude > bounds.east ||
      candidate.latitude < bounds.south ||
      candidate.latitude > bounds.north
    ) {
      return;
    }
    if (
      booleanPointInPolygon(pointFeatureOf(candidate, operation), feature, {
        ignoreBoundary: options.ignoreBoundary === true,
      })
    ) {
      indexes.push(index);
      hits.push(candidate);
    }
  });

  return { indexes, points: hits, count: indexes.length };
}

/**
 * 规范化环的绕向，返回闭合环。
 *
 * @param ring - 输入环，至少 3 个顶点。
 * @param direction - 目标绕向；GeoJSON（RFC 7946）要求外环逆时针。
 * @returns 按目标绕向排列的闭合环。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function normalizeRingWinding(ring: GeoRing, direction: RingWinding): GeoRing {
  const operation = 'normalizeRingWinding';
  // 类型上只有两个取值，运行时（JS 调用方）仍可能传入别的字符串。
  const requested: unknown = direction;
  if (requested !== 'clockwise' && requested !== 'counterclockwise') {
    throw spatialError(
      'Ring winding must be clockwise or counterclockwise.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  const positions = toRing(ring, operation, 'ring');
  // turf 的 rewind 声明返回几何/要素联合类型；传入要素时实际返回同类型要素。
  const normalized = rewind(polygonFeatureOf({ outer: positions.map(toGeoPoint) }, operation), {
    reverse: direction === 'clockwise',
  }) as Feature<Polygon>;
  const outer = normalized.geometry.coordinates[0] ?? [];
  return outer.map(toGeoPoint);
}
