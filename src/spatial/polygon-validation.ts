import type { GeoPoint, GeoPolygon } from './types.js';
import { MAX_GEOMETRY_VERTICES, spatialError } from './types.js';
import { isPointInPolygon } from './predicate.js';

/** 多边形问题代码。 */
export type PolygonIssueCode =
  | 'TOO_FEW_VERTICES'
  | 'UNCLOSED_RING'
  | 'DUPLICATE_VERTEX'
  | 'SELF_INTERSECTION'
  | 'HOLE_OUTSIDE_SHELL'
  | 'HOLE_INTERSECTS_SHELL';

/** 一条多边形问题。 */
export interface PolygonIssue {
  /** 稳定问题代码，业务按它分支。 */
  readonly code: PolygonIssueCode;
  /** 面向使用者的中文说明。 */
  readonly message: string;
  /** 问题所在环：`outer` 为外环，数字为内环下标。 */
  readonly ring: 'outer' | number;
  /** 相关顶点下标；问题是"两个顶点之间"时给出靠前的那个。 */
  readonly vertexIndex?: number;
}

/** 多边形校验配置。 */
export interface ValidatePolygonOptions {
  /**
   * 是否要求外环与内环显式闭合（首尾同点），默认 `false`。
   *
   * 关闭时允许"未闭合但语义闭合"的环——SDK 的面积与判断函数都会自动闭合它们。
   */
  readonly requireClosed?: boolean;
  /** 是否做自交检测，默认 `true`；多边形顶点很多时可按需关闭。 */
  readonly checkSelfIntersection?: boolean;
}

/** 单个环的自交检测上限：超过该顶点数时跳过自交检测，避免 O(n log n + k) 的扫描退化。 */
const SELF_INTERSECTION_VERTEX_LIMIT = 20_000;

/**
 * 校验多边形的结构合法性。
 *
 * 检查项：顶点是否足够、是否需要闭合、是否有重复顶点、外环/内环是否自交、洞是否落在壳内并与
 * 壳相交。**返回问题列表而不是抛错**——业务在绘制提交、数据入库前可以按自己的策略处理
 * （拒绝、修正、仅告警），这也是绘制文档里"SDK 不做拓扑校验"的补充：校验函数提供好了，
 * 何时校验由业务决定。
 *
 * 自交检测用包围盒扫描：按经度区间排序后只比较可能相交的线段对，城市级多边形（几千顶点）
 * 实测远快于朴素 O(n²)。顶点数超过 20000 时跳过自交检测（其余检查照常执行）。
 *
 * @param polygon - 带洞多边形。
 * @param options - 是否要求闭合、是否检测自交。
 * @returns 问题列表；空数组表示通过。
 * @throws `INVALID_SPATIAL_INPUT` 多边形结构非法（不是对象、环不是数组、坐标非有限值、超限额）。
 */
export function validatePolygon(
  polygon: GeoPolygon,
  options: ValidatePolygonOptions = {},
): readonly PolygonIssue[] {
  const operation = 'validatePolygon';
  // JS 调用方可能传入非对象：这里读一遍再做形状判断，避免直接访问属性抛原生错误。
  const candidate: unknown = polygon;
  if (typeof candidate !== 'object' || candidate === null) {
    throw spatialError(
      'validatePolygon requires a polygon object.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  const issues: PolygonIssue[] = [];
  const outer = readRing(polygon.outer, 'outer', operation, issues);
  const holes = (polygon.holes ?? []).map((hole, index) =>
    readRing(hole, index, operation, issues),
  );
  const requireClosed = options.requireClosed === true;
  const checkSelfIntersection = options.checkSelfIntersection !== false;

  for (const ring of [outer, ...holes]) {
    validateRing(ring.points, ring.label, issues, requireClosed, checkSelfIntersection);
  }
  if (outer.points.length >= 3) {
    holes.forEach((hole) => {
      validateHole(hole.points, outer.points, hole.label, issues);
    });
  }
  return issues;
}

interface ParsedRing {
  readonly points: GeoPoint[];
  readonly label: 'outer' | number;
}

function readRing(
  ring: unknown,
  label: 'outer' | number,
  operation: string,
  issues: PolygonIssue[],
): ParsedRing {
  if (!Array.isArray(ring)) {
    throw spatialError(
      'Polygon rings must be arrays of points.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  if (ring.length > MAX_GEOMETRY_VERTICES) {
    throw spatialError(
      `Polygon rings accept at most ${String(MAX_GEOMETRY_VERTICES)} vertices.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  const points: GeoPoint[] = [];
  for (const entry of ring as readonly unknown[]) {
    const { longitude, latitude } = (entry ?? {}) as Partial<GeoPoint>;
    if (
      typeof longitude !== 'number' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    ) {
      throw spatialError(
        'Polygon vertices must be finite WGS84 coordinates.',
        'INVALID_SPATIAL_INPUT',
        operation,
      );
    }
    points.push({ longitude, latitude });
  }
  if (points.length === 0) {
    issues.push({
      code: 'TOO_FEW_VERTICES',
      message: `环 ${formatLabel(label)} 没有任何顶点。`,
      ring: label,
    });
  }
  return { points, label };
}

function validateRing(
  points: readonly GeoPoint[],
  label: 'outer' | number,
  issues: PolygonIssue[],
  requireClosed: boolean,
  checkSelfIntersection: boolean,
): void {
  if (points.length < 3) {
    if (points.length > 0) {
      issues.push({
        code: 'TOO_FEW_VERTICES',
        message: `环 ${formatLabel(label)} 至少需要 3 个顶点。`,
        ring: label,
      });
    }
    return;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const closed = first?.longitude === last?.longitude && first?.latitude === last?.latitude;
  if (requireClosed && !closed) {
    issues.push({
      code: 'UNCLOSED_RING',
      message: `环 ${formatLabel(label)} 未闭合（首尾顶点不同）。`,
      ring: label,
    });
  }
  const uniqueCount = countUniqueVertices(points, closed);
  if (uniqueCount < 3) {
    issues.push({
      code: 'TOO_FEW_VERTICES',
      message: `环 ${formatLabel(label)} 去重后不足 3 个顶点。`,
      ring: label,
    });
    return;
  }
  const duplicateIndex = findDuplicateVertex(points);
  if (duplicateIndex >= 0) {
    issues.push({
      code: 'DUPLICATE_VERTEX',
      message: `环 ${formatLabel(label)} 的顶点 ${String(duplicateIndex)} 与其它顶点重复。`,
      ring: label,
      vertexIndex: duplicateIndex,
    });
  }
  if (checkSelfIntersection && points.length <= SELF_INTERSECTION_VERTEX_LIMIT) {
    const intersection = findSelfIntersection(points, closed);
    if (intersection) {
      issues.push({
        code: 'SELF_INTERSECTION',
        message: `环 ${formatLabel(label)} 自交（顶点 ${String(intersection[0])} 与 ${String(intersection[1])} 之间）。`,
        ring: label,
        vertexIndex: intersection[0],
      });
    }
  }
}

function validateHole(
  hole: readonly GeoPoint[],
  outer: readonly GeoPoint[],
  label: 'outer' | number,
  issues: PolygonIssue[],
): void {
  const outerShell: GeoPolygon = { outer };
  hole.forEach((vertex, index) => {
    if (!isPointInPolygon(vertex, outerShell)) {
      issues.push({
        code: 'HOLE_OUTSIDE_SHELL',
        message: `${formatLabel(label)} 的顶点 ${String(index)} 落在壳外。`,
        ring: label,
        vertexIndex: index,
      });
    }
  });
  const intersection = findRingIntersection(hole, outer);
  if (intersection) {
    issues.push({
      code: 'HOLE_INTERSECTS_SHELL',
      message: `${formatLabel(label)} 与壳相交（顶点 ${String(intersection[0])} 附近）。`,
      ring: label,
      vertexIndex: intersection[0],
    });
  }
}

/** 去重后的顶点数；闭合环去掉重复的首尾。 */
function countUniqueVertices(points: readonly GeoPoint[], closed: boolean): number {
  const seen = new Set<string>();
  const limit = closed ? points.length - 1 : points.length;
  for (let index = 0; index < limit; index += 1) {
    const point = points[index];
    if (point) {
      seen.add(`${String(point.longitude)},${String(point.latitude)}`);
    }
  }
  return seen.size;
}

/** 首个与其它顶点重复的下标；闭合环的首尾重复不算问题。 */
function findDuplicateVertex(points: readonly GeoPoint[]): number {
  const seen = new Map<string, number>();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point) {
      continue;
    }
    const key = `${String(point.longitude)},${String(point.latitude)}`;
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, index);
      continue;
    }
    // 闭合点（首=尾）在环上是正常写法。
    if (previous === 0 && index === points.length - 1) {
      continue;
    }
    return index;
  }
  return -1;
}

interface Segment {
  /** 所属环：自交检测时同一环，洞与壳比较时用 0/1 区分。 */
  readonly group: number;
  readonly index: number;
  readonly from: GeoPoint;
  readonly to: GeoPoint;
  readonly minLongitude: number;
  readonly maxLongitude: number;
  readonly minLatitude: number;
  readonly maxLatitude: number;
}

/** 把环拆成线段；未闭合的环按隐式闭合处理。 */
function ringSegments(points: readonly GeoPoint[], group = 0): Segment[] {
  const segments: Segment[] = [];
  // 未闭合的环按"隐式闭合"处理，因此段数总是顶点数减一。
  const count = points.length - 1;
  for (let index = 0; index < count; index += 1) {
    const from = points[index];
    const to = points[index + 1] ?? points[0];
    if (!from || !to) {
      continue;
    }
    segments.push({
      group,
      index,
      from,
      to,
      minLongitude: Math.min(from.longitude, to.longitude),
      maxLongitude: Math.max(from.longitude, to.longitude),
      minLatitude: Math.min(from.latitude, to.latitude),
      maxLatitude: Math.max(from.latitude, to.latitude),
    });
  }
  return segments;
}

function findSelfIntersection(
  points: readonly GeoPoint[],
  closed: boolean,
): readonly [number, number] | undefined {
  const segments = ringSegments(points);
  return findIntersectionPairs(segments, (left, right) => {
    // 相邻线段共享顶点，不算自交；闭合环的最后一段与第一段也相邻。
    const adjacent =
      Math.abs(left.index - right.index) === 1 ||
      (closed && left.index === 0 && right.index === segments.length - 1);
    return !adjacent;
  });
}

function findRingIntersection(
  left: readonly GeoPoint[],
  right: readonly GeoPoint[],
): readonly [number, number] | undefined {
  // 只比较"洞的线段 × 壳的线段"：同环内部共享顶点，不应该被判成交叉。
  return findIntersectionPairs(
    [...ringSegments(left, 0), ...ringSegments(right, 1)],
    (first, second) => first.group !== second.group,
  );
}

/** 包围盒扫描：按最小经度排序后只比较区间重叠的线段对。 */
function findIntersectionPairs(
  segments: readonly Segment[],
  shouldCompare: (left: Segment, right: Segment) => boolean,
): readonly [number, number] | undefined {
  const ordered = [...segments].sort((left, right) => left.minLongitude - right.minLongitude);
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (!current) {
      continue;
    }
    for (let next = index + 1; next < ordered.length; next += 1) {
      const candidate = ordered[next];
      if (!candidate) {
        continue;
      }
      if (candidate.minLongitude > current.maxLongitude) {
        break;
      }
      if (!shouldCompare(current, candidate)) {
        continue;
      }
      if (
        current.maxLatitude < candidate.minLatitude ||
        candidate.maxLatitude < current.minLatitude
      ) {
        continue;
      }
      if (segmentsIntersect(current.from, current.to, candidate.from, candidate.to)) {
        return [current.index, candidate.index];
      }
    }
  }
  return undefined;
}

/** 标准线段相交判定：跨立试验 + 共线重叠。 */
function segmentsIntersect(a: GeoPoint, b: GeoPoint, c: GeoPoint, d: GeoPoint): boolean {
  const d1 = orientation(c, d, a);
  const d2 = orientation(c, d, b);
  const d3 = orientation(a, b, c);
  const d4 = orientation(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(c, d, a)) {
    return true;
  }
  if (d2 === 0 && onSegment(c, d, b)) {
    return true;
  }
  if (d3 === 0 && onSegment(a, b, c)) {
    return true;
  }
  if (d4 === 0 && onSegment(a, b, d)) {
    return true;
  }
  return false;
}

function orientation(p: GeoPoint, q: GeoPoint, r: GeoPoint): number {
  const value =
    (q.latitude - p.latitude) * (r.longitude - q.longitude) -
    (q.longitude - p.longitude) * (r.latitude - q.latitude);
  if (Math.abs(value) < 1e-12) {
    return 0;
  }
  return value > 0 ? 1 : -1;
}

function onSegment(p: GeoPoint, q: GeoPoint, r: GeoPoint): boolean {
  return (
    r.longitude <= Math.max(p.longitude, q.longitude) &&
    r.longitude >= Math.min(p.longitude, q.longitude) &&
    r.latitude <= Math.max(p.latitude, q.latitude) &&
    r.latitude >= Math.min(p.latitude, q.latitude)
  );
}

function formatLabel(label: 'outer' | number): string {
  return label === 'outer' ? '外环' : `内环 ${String(label)}`;
}
