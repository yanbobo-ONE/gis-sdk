import along from '@turf/along';
import area from '@turf/area';
import bbox from '@turf/bbox';
import bearing from '@turf/bearing';
import centerOfMass from '@turf/center-of-mass';
import destination from '@turf/destination';
import distance from '@turf/distance';
import length from '@turf/length';
import nearestPointOnLine from '@turf/nearest-point-on-line';

import {
  lineFeatureOf,
  multiPointFeatureOf,
  pointFeatureOf,
  polygonFeatureOf,
  toGeoPoint,
  toGeoPoints,
  toPositions,
  toPosition,
} from './geojson.js';
import type { GeoBBox, GeoPoint, GeoPolygon, GeoRing } from './types.js';
import { finite, spatialError } from './types.js';

/** 量算支持的距离单位。 */
export type MeasureUnit = 'meters' | 'kilometers' | 'nauticalmiles';

/** 距离量算结果。 */
export interface DistanceMeasurement {
  /** 距离，单位米；始终给出，便于统一比较。 */
  readonly meters: number;
  /** 按请求单位换算后的数值。 */
  readonly value: number;
  /** 本次使用的单位。 */
  readonly unit: MeasureUnit;
}

/** 面积量算结果。 */
export interface AreaMeasurement {
  /** 球面面积，单位为平方米。 */
  readonly squareMeters: number;
  /** 球面面积，单位为平方公里。 */
  readonly squareKilometers: number;
}

/** 方位角量算结果。 */
export interface BearingMeasurement {
  /** 起始方位角，单位为度，正北为 0，顺时针为正。 */
  readonly degrees: number;
}

/** 最近点量算结果。 */
export interface NearestPointMeasurement {
  /** 折线上距离目标最近的点。 */
  readonly point: GeoPoint;
  /** 最近点所在线段的起点索引（`points[index]` 到 `points[index + 1]`）。 */
  readonly index: number;
  /** 目标点到最近点的球面距离，单位为米。 */
  readonly distanceMeters: number;
  /** 从折线起点沿折线到最近点的距离，单位为米。 */
  readonly alongMeters: number;
}

/** 距离量算的可选参数。 */
export interface MeasureOptions {
  /** 结果单位，默认米。 */
  readonly units?: MeasureUnit;
}

const UNITS: readonly MeasureUnit[] = ['meters', 'kilometers', 'nauticalmiles'];

function normalizeUnits(units: unknown, operation: string): MeasureUnit {
  if (units === undefined) {
    return 'meters';
  }
  if (typeof units !== 'string' || !UNITS.includes(units as MeasureUnit)) {
    throw spatialError(
      'Measure units must be meters, kilometers, or nauticalmiles.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  return units as MeasureUnit;
}

function measurement(meters: number, unit: MeasureUnit): DistanceMeasurement {
  const factor = unit === 'kilometers' ? 1_000 : unit === 'nauticalmiles' ? 1_852 : 1;
  return { meters, value: meters / factor, unit };
}

function requireNonNegative(value: unknown, name: string, operation: string): number {
  if (!finite(value) || value < 0) {
    throw spatialError(
      `${name} must be a non-negative finite number.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  return value;
}

/** 提取包围盒所需的顶点：单个点、顶点序列或带洞多边形都可以。 */
function vertexListOf(input: unknown, operation: string): number[][] {
  if (Array.isArray(input)) {
    return toPositions(input, operation, 'points', 1);
  }
  if (input !== null && typeof input === 'object' && 'outer' in input) {
    return polygonFeatureOf(input, operation).geometry.coordinates.flat();
  }
  return [pointFeatureOf(input, operation).geometry.coordinates];
}

/**
 * 量算两点之间的球面距离。
 *
 * @param from - 起点。
 * @param to - 终点。
 * @param options - 结果单位，默认米。
 * @returns 米制距离与按单位换算后的数值。
 * @throws `INVALID_COORDINATES` 坐标非法；`INVALID_SPATIAL_INPUT` 单位不受支持。
 */
export function measureDistance(
  from: GeoPoint,
  to: GeoPoint,
  options: MeasureOptions = {},
): DistanceMeasurement {
  const operation = 'measureDistance';
  const unit = normalizeUnits(options.units, operation);
  const meters = distance(pointFeatureOf(from, operation), pointFeatureOf(to, operation), {
    units: 'meters',
  });
  return measurement(meters, unit);
}

/**
 * 量算折线总长。
 *
 * @param points - 折线顶点，至少 2 个。
 * @param options - 结果单位，默认米。
 * @returns 米制长度与按单位换算后的数值。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function measurePathLength(
  points: GeoRing,
  options: MeasureOptions = {},
): DistanceMeasurement {
  const operation = 'measurePathLength';
  const unit = normalizeUnits(options.units, operation);
  const meters = length(lineFeatureOf(points, operation), { units: 'meters' });
  return measurement(meters, unit);
}

/**
 * 量算多边形球面面积。
 *
 * 传入顶点序列时按单个环计算；传入 `{ outer, holes }` 时内环（洞）面积会被扣除。
 *
 * @param input - 顶点环或带洞多边形。
 * @returns 平方米与平方公里面积。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function measureArea(input: GeoRing | GeoPolygon): AreaMeasurement {
  const operation = 'measureArea';
  // 顶点序列按单环处理；带洞多边形先校验外环与内环，再交给 turf 计算并扣除洞面积。
  const feature = Array.isArray(input)
    ? polygonFeatureOf({ outer: input }, operation)
    : polygonFeatureOf(input, operation);
  const squareMeters = area(feature);
  return { squareMeters, squareKilometers: squareMeters / 1_000_000 };
}

/**
 * 量算两点之间的起始方位角。
 *
 * @param from - 起点。
 * @param to - 终点。
 * @returns 方位角，单位为度，取值范围 -180 到 180。
 * @throws `INVALID_COORDINATES`。
 */
export function measureBearing(from: GeoPoint, to: GeoPoint): BearingMeasurement {
  const operation = 'measureBearing';
  return {
    degrees: bearing(pointFeatureOf(from, operation), pointFeatureOf(to, operation)),
  };
}

/**
 * 由起点、方位角与距离推算目标点。
 *
 * @param origin - 起点。
 * @param bearingDegrees - 方位角，单位为度，正北为 0，顺时针为正。
 * @param distanceMeters - 距离，单位为米，不能为负。
 * @returns 目标点。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function measureDestination(
  origin: GeoPoint,
  bearingDegrees: number,
  distanceMeters: number,
): GeoPoint {
  const operation = 'measureDestination';
  if (!finite(bearingDegrees)) {
    throw spatialError(
      'Bearing must be a finite number of degrees.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  requireNonNegative(distanceMeters, 'distanceMeters', operation);
  const target = destination(pointFeatureOf(origin, operation), distanceMeters, bearingDegrees, {
    units: 'meters',
  });
  return toGeoPoint(target.geometry.coordinates);
}

/**
 * 量算包围盒，可直接喂 `map.camera.setView()` 或 `flyTo()`。
 *
 * 输入顶点跨越日期变更线时返回的是经度最小/最大值（可能接近 ±180 的两端），
 * 不做跨线归一化——跨线包围盒需要业务决定用哪条边表示。
 *
 * @param input - 单个点、顶点序列或带洞多边形。
 * @returns 经纬度包围盒。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function measureBBox(input: GeoPoint | GeoRing | GeoPolygon): GeoBBox {
  const operation = 'measureBBox';
  // 多边形的包围盒等于其顶点包围盒，因此三种输入统一按顶点集合计算。
  const feature = multiPointFeatureOf(toGeoPoints(vertexListOf(input, operation)), operation, 1);
  const [west, south, east, north] = bbox(feature);
  return { west, east, south, north };
}

/**
 * 量算质心。
 *
 * 传入带洞多边形时按**面积质心**计算；传入顶点序列时按**顶点平均**计算。
 *
 * @param input - 顶点序列或带洞多边形。
 * @returns 质心点。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function measureCenterOfMass(input: GeoRing | GeoPolygon): GeoPoint {
  const operation = 'measureCenterOfMass';
  const feature = Array.isArray(input)
    ? multiPointFeatureOf(input, operation)
    : polygonFeatureOf(input, operation);
  return toGeoPoint(centerOfMass(feature).geometry.coordinates);
}

/**
 * 沿折线取等距点。
 *
 * @param points - 折线顶点，至少 2 个。
 * @param distanceMeters - 距起点的距离，单位为米；超过折线总长时返回终点。
 * @returns 折线上的点。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function pointAlongPath(points: GeoRing, distanceMeters: number): GeoPoint {
  const operation = 'pointAlongPath';
  requireNonNegative(distanceMeters, 'distanceMeters', operation);
  const line = lineFeatureOf(points, operation);
  const totalMeters = length(line, { units: 'meters' });
  const clamped = Math.min(distanceMeters, totalMeters);
  const result = along(line, clamped, { units: 'meters' });
  return toGeoPoint(result.geometry.coordinates);
}

/**
 * 求折线上距离目标最近的点。
 *
 * 距离按 `units: 'meters'` 计算，取 turf 的 `pointDistance`（目标点到最近点）与
 * `totalDistance`（沿折线到最近点），不使用已废弃的 `dist` / `location` 字段。
 *
 * @param points - 折线顶点，至少 2 个。
 * @param target - 目标点。
 * @returns 最近点、所在线段索引、目标点到最近点的距离与沿折线的距离。
 * @throws `INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`。
 */
export function nearestPointOnPath(points: GeoRing, target: GeoPoint): NearestPointMeasurement {
  const operation = 'nearestPointOnPath';
  const nearest = nearestPointOnLine(
    lineFeatureOf(points, operation),
    toPosition(target, operation),
    { units: 'meters' },
  );
  return {
    point: toGeoPoint(nearest.geometry.coordinates),
    index: nearest.properties.segmentIndex,
    distanceMeters: nearest.properties.pointDistance,
    alongMeters: nearest.properties.totalDistance,
  };
}
