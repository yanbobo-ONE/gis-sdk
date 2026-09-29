import {
  lineString,
  multiPoint,
  point as pointFeature,
  polygon as polygonFeature,
} from '@turf/helpers';
import type { Feature, LineString, MultiPoint, Point, Polygon, Position } from 'geojson';

import type { GeoPoint, GeoPolygon, GeoRing } from './types.js';
import { finite, MAX_GEOMETRY_VERTICES, spatialError } from './types.js';

/** 环（多边形）所需的最少顶点数；首尾可重复。 @internal */
export const MIN_RING_VERTICES = 3;

/** 折线所需的最少顶点数。 @internal */
export const MIN_PATH_VERTICES = 2;

/** 校验一个点并转成 GeoJSON `Position`（保持经度在前、纬度在后的顺序）。 @internal */
export function toPosition(point: unknown, operation: string, name = 'point'): Position {
  const { longitude, latitude } = (point ?? {}) as Partial<GeoPoint>;
  if (!finite(longitude) || !finite(latitude)) {
    throw spatialError(
      `Spatial ${name} must contain finite longitude and latitude.`,
      'INVALID_COORDINATES',
      operation,
    );
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw spatialError(
      `Spatial ${name} is outside the WGS84 degree range.`,
      'INVALID_COORDINATES',
      operation,
    );
  }
  // 只做二维数学：高度不参与 GeoJSON 计算，避免 turf 在三维坐标上产生歧义。
  return [longitude, latitude];
}

/** 校验并转换一条顶点序列。 @internal */
export function toPositions(
  vertices: unknown,
  operation: string,
  name: string,
  minVertices: number,
): Position[] {
  if (!Array.isArray(vertices)) {
    throw spatialError(
      `Spatial ${name} must be an array of vertices.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  if (vertices.length < minVertices) {
    throw spatialError(
      `Spatial ${name} requires at least ${String(minVertices)} vertices.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  if (vertices.length > MAX_GEOMETRY_VERTICES) {
    throw spatialError(
      `Spatial ${name} exceeds the ${String(MAX_GEOMETRY_VERTICES)} vertex limit.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  return vertices.map((vertex, index) =>
    toPosition(vertex, operation, `${name}[${String(index)}]`),
  );
}

/** 首尾相同即视为已闭合，避免重复顶点影响面积与绕向计算。 @internal */
export function closeRing(positions: Position[]): Position[] {
  const first = positions[0];
  const last = positions[positions.length - 1];
  const [firstLongitude, firstLatitude] = first ?? [];
  if (firstLongitude === undefined || firstLatitude === undefined || !last) {
    return positions;
  }
  if (firstLongitude === last[0] && firstLatitude === last[1]) {
    return positions;
  }
  return [...positions, [firstLongitude, firstLatitude]];
}

/** 校验并转换一条环。 @internal */
export function toRing(ring: unknown, operation: string, name: string): Position[] {
  return closeRing(toPositions(ring, operation, name, MIN_RING_VERTICES));
}

/**
 * 校验并转换一个带洞多边形。
 *
 * 洞的数量与顶点数同样受限额约束；环在此处统一闭合。
 * @internal
 */
export function toPolygon(polygon: unknown, operation: string): Position[][] {
  const { outer, holes } = (polygon ?? {}) as Partial<GeoPolygon>;
  const rings: Position[][] = [toRing(outer, operation, 'polygon.outer')];
  if (holes !== undefined) {
    if (!Array.isArray(holes)) {
      throw spatialError(
        'Spatial polygon.holes must be an array of rings.',
        'INVALID_SPATIAL_INPUT',
        operation,
      );
    }
    holes.forEach((hole, index) => {
      rings.push(toRing(hole, operation, `polygon.holes[${String(index)}]`));
    });
  }
  return rings;
}

/** 点要素。 @internal */
export function pointFeatureOf(point: unknown, operation: string): Feature<Point> {
  return pointFeature(toPosition(point, operation));
}

/** 折线要素。 @internal */
export function lineFeatureOf(points: unknown, operation: string): Feature<LineString> {
  return lineString(toPositions(points, operation, 'path', MIN_PATH_VERTICES));
}

/**
 * 点集要素；用于质心与包围盒一类按顶点集合计算的方法。
 *
 * 包围盒允许只有一个顶点，因此这里把最少顶点数开放给调用方。
 * @internal
 */
export function multiPointFeatureOf(
  points: unknown,
  operation: string,
  minVertices = MIN_PATH_VERTICES,
): Feature<MultiPoint> {
  return multiPoint(toPositions(points, operation, 'points', minVertices));
}

/** 多边形要素（含洞）。 @internal */
export function polygonFeatureOf(polygon: unknown, operation: string): Feature<Polygon> {
  const rings = toPolygon(polygon, operation);
  const outer = rings[0];
  if (!outer) {
    throw spatialError('Spatial polygon is empty.', 'INVALID_SPATIAL_INPUT', operation);
  }
  return polygonFeature(rings, undefined);
}

/**
 * 顶点序列 → 业务点序列。
 *
 * turf 返回的坐标同样是「经度在前」，这里集中转换回对象形式；
 * 转换点只有一个，方便用南北半球样例锁死顺序。
 * @internal
 */
export function toGeoPoints(positions: readonly Position[]): GeoPoint[] {
  return positions.map((position) => ({
    longitude: position[0] ?? 0,
    latitude: position[1] ?? 0,
  }));
}

/** GeoJSON Position → 业务点。 @internal */
export function toGeoPoint(position: Position): GeoPoint {
  return { longitude: position[0] ?? 0, latitude: position[1] ?? 0 };
}

/** 顶点序列 → 环。 @internal */
export function toGeoRing(positions: readonly Position[]): GeoRing {
  return toGeoPoints(positions);
}

/**
 * 判断输入是「环/顶点序列」还是「带洞多边形」。
 *
 * 数组按顶点序列处理；对象按多边形处理（`outer` + 可选 `holes`）。
 * @internal
 */
export function ringInputOf(input: unknown, operation: string): Position[][] {
  if (Array.isArray(input)) {
    return [toRing(input, operation, 'ring')];
  }
  return toPolygon(input, operation);
}
