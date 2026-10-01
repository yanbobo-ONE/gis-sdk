import type { GeoPoint, GeoRing } from './types.js';
import { MAX_GEOMETRY_VERTICES, spatialError } from './types.js';
import { nearestPointOnPath } from './measure.js';

/** 抽稀结果。 */
export interface SimplifyResult {
  /** 抽稀后的顶点；首尾顶点一定保留。 */
  readonly points: GeoPoint[];
  /** 被移除的顶点数。 */
  readonly removedCount: number;
}

/**
 * 折线 / 环的抽稀（Ramer–Douglas–Peucker）。
 *
 * 距离口径是**米**：用 `nearestPointOnPath()` 求点到弦的最近点，因此抽稀结果在任何纬度都按
 * 真实地面距离判定，不像按度数判定那样在高纬度过抽。首尾顶点一定保留；闭合环（首尾同点）
 * 因此仍然闭合。
 *
 * 用显式栈而不是递归实现：十万级顶点也不会撞栈。
 *
 * @param points - 顶点序列；相邻重复点会先被去掉。
 * @param toleranceMeters - 容差，单位为米，必须为正；越大越"直"。
 * @returns 抽稀后的顶点与移除数量。
 * @throws `INVALID_SPATIAL_INPUT` 容差非法、顶点不足或超过上限。
 */
export function simplifyPath(points: GeoRing, toleranceMeters: number): SimplifyResult {
  const operation = 'simplifyPath';
  if (!Array.isArray(points)) {
    throw spatialError(
      'simplifyPath requires an array of points.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  if (points.length > MAX_GEOMETRY_VERTICES) {
    throw spatialError(
      `simplifyPath accepts at most ${String(MAX_GEOMETRY_VERTICES)} points.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  if (!Number.isFinite(toleranceMeters) || toleranceMeters <= 0) {
    throw spatialError(
      'simplifyPath toleranceMeters must be a positive finite number.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  const sequence: GeoPoint[] = [];
  for (const point of points) {
    const { longitude, latitude, ...rest } = (point ?? {}) as Partial<GeoPoint>;
    if (
      typeof longitude !== 'number' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude)
    ) {
      throw spatialError(
        'simplifyPath requires finite coordinates.',
        'INVALID_SPATIAL_INPUT',
        operation,
      );
    }
    const previous = sequence[sequence.length - 1];
    if (previous?.longitude === longitude && previous.latitude === latitude) {
      continue;
    }
    sequence.push({ ...rest, longitude, latitude });
  }
  if (sequence.length <= 2) {
    return { points: sequence, removedCount: 0 };
  }

  const keep: boolean[] = new Array<boolean>(sequence.length).fill(false);
  keep[0] = true;
  keep[sequence.length - 1] = true;
  // 显式栈：每项是待处理区间的起止下标。
  const stack: (readonly [number, number])[] = [[0, sequence.length - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) {
      continue;
    }
    const [start, end] = range;
    if (end - start < 2) {
      continue;
    }
    const from = sequence[start];
    const to = sequence[end];
    if (!from || !to) {
      continue;
    }
    let farthestIndex = -1;
    let farthestDistance = toleranceMeters;
    for (let index = start + 1; index < end; index += 1) {
      const point = sequence[index];
      if (!point) {
        continue;
      }
      const distance = nearestPointOnPath([from, to], point).distanceMeters;
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }
    if (farthestIndex > 0) {
      keep[farthestIndex] = true;
      stack.push([start, farthestIndex], [farthestIndex, end]);
    }
  }
  const simplified = sequence.filter((_, index) => keep[index] === true);
  return { points: simplified, removedCount: sequence.length - simplified.length };
}

/**
 * 抽稀一条闭合环并保持闭合。
 *
 * 与 {@link simplifyPath} 的唯一区别是先把环补成闭合（首尾同点）再抽稀，避免业务传进来的是
 * "未闭合但语义上闭合"的环时把最后一个顶点当作独立端点保留。
 *
 * @param ring - 环顶点。
 * @param toleranceMeters - 容差，单位为米。
 * @returns 抽稀后的闭合环与移除数量。
 * @throws `INVALID_SPATIAL_INPUT` 参数非法（同 {@link simplifyPath}）。
 */
export function simplifyRing(ring: GeoRing, toleranceMeters: number): SimplifyResult {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = first?.longitude === last?.longitude && first?.latitude === last?.latitude;
  const source = closed
    ? [...ring]
    : first
      ? [...ring, { longitude: first.longitude, latitude: first.latitude }]
      : [];
  return simplifyPath(source, toleranceMeters);
}
