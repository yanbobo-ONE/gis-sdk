import type { GeoPoint, GeoRing } from './types.js';
import { MAX_GEOMETRY_VERTICES, spatialError } from './types.js';

/**
 * 凸包：安德鲁单调链（Andrew's monotone chain）。
 *
 * 在经纬度平面上做平面凸包——与 turf 的 `convex` 同一口径，适用于城市级到区域级范围；
 * 跨半球或跨越 180° 经线的点集不适合直接求平面凸包，应先投影到平面坐标系。
 *
 * 结果**首尾闭合**（首顶点在末尾重复一次），可直接交给多边形判断、面积量算与图层渲染。
 *
 * @param points - 输入点；重复点会被忽略。
 * @returns 凸包环；点数不足 3 或全部共线时返回退化的两点环（仍闭合）。
 * @throws `INVALID_SPATIAL_INPUT` 点数超过上限或坐标非法。
 */
export function convexHull(points: readonly GeoPoint[]): GeoRing {
  const operation = 'convexHull';
  if (!Array.isArray(points)) {
    throw spatialError(
      'convexHull requires an array of points.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  if (points.length > MAX_GEOMETRY_VERTICES) {
    throw spatialError(
      `convexHull accepts at most ${String(MAX_GEOMETRY_VERTICES)} points.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  const unique: GeoPoint[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    const { longitude, latitude } = (point ?? {}) as Partial<GeoPoint>;
    if (
      typeof longitude !== 'number' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    ) {
      throw spatialError(
        'convexHull requires finite WGS84 coordinates.',
        'INVALID_SPATIAL_INPUT',
        operation,
      );
    }
    const key = `${String(longitude)},${String(latitude)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({ longitude, latitude });
  }
  if (unique.length === 0) {
    return [];
  }
  unique.sort((left, right) => left.longitude - right.longitude || left.latitude - right.latitude);
  if (unique.length < 3) {
    return closeRing(unique);
  }

  const lower: GeoPoint[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: GeoPoint[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    if (!point) {
      continue;
    }
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  if (hull.length < 3) {
    // 全部共线：只剩两端点。
    const first = unique[0];
    const last = unique[unique.length - 1];
    return first && last ? closeRing([first, last]) : [];
  }
  return closeRing(hull);
}

/** 二维叉积：大于 0 表示逆时针转弯（含共线为 0）。 */
function cross(
  origin: GeoPoint | undefined,
  a: GeoPoint | undefined,
  b: GeoPoint | undefined,
): number {
  if (!origin || !a || !b) {
    return 0;
  }
  return (
    (a.longitude - origin.longitude) * (b.latitude - origin.latitude) -
    (a.latitude - origin.latitude) * (b.longitude - origin.longitude)
  );
}

function closeRing(points: GeoPoint[]): GeoRing {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return [];
  }
  if (first.longitude === last.longitude && first.latitude === last.latitude) {
    return points;
  }
  return [...points, { longitude: first.longitude, latitude: first.latitude }];
}
