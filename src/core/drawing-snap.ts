import type { GeoPosition, WindowCoordinates } from './controls.js';
import { GisError } from './errors.js';

/** 可吸附的顶点候选：地理坐标与其屏幕投影。 */
export interface SnapVertex {
  /** 顶点经纬高。 */
  readonly position: GeoPosition;
  /** 该顶点的屏幕坐标；投影失败（视锥外、被地球遮挡）的顶点不要放进来。 */
  readonly screen: WindowCoordinates;
}

/** 可吸附的线段候选：两端的地理坐标与屏幕投影。 */
export interface SnapSegment {
  /** 线段起点。 */
  readonly from: GeoPosition;
  /** 线段起点的屏幕坐标。 */
  readonly fromScreen: WindowCoordinates;
  /** 线段终点。 */
  readonly to: GeoPosition;
  /** 线段终点的屏幕坐标。 */
  readonly toScreen: WindowCoordinates;
}

/** 命中结果。 */
export interface SnapResult {
  /** 命中类型：顶点优先，其次线段。 */
  readonly kind: 'vertex' | 'edge';
  /** 吸附后的地理坐标：顶点候选直接取顶点，线段候选按屏幕比例在两端之间插值。 */
  readonly position: GeoPosition;
  /** 光标到命中目标的屏幕距离，单位为像素。 */
  readonly distancePixels: number;
}

/** 吸附配置。 */
export interface SnapOptions {
  /** 屏幕像素阈值，默认 12；超出阈值不吸附。 */
  readonly pixelTolerance?: number;
  /** 是否允许吸附到线段，默认 `false`（只吸附顶点，行为更可预测）。 */
  readonly includeEdges?: boolean;
  /**
   * 屏幕空间的距离换算，默认欧氏距离。
   *
   * 需要"更接近视觉感受"的终端可以传入自定义度量（例如加权的高宽比），
   * 只要保证返回值是像素量级即可。
   */
  readonly distance?: (a: WindowCoordinates, b: WindowCoordinates) => number;
}

/** 补齐默认值后的吸附配置。 */
export interface ResolvedSnapOptions {
  /** 屏幕像素阈值。 */
  readonly pixelTolerance: number;
  /** 是否允许吸附到线段。 */
  readonly includeEdges: boolean;
  /** 屏幕空间距离度量。 */
  readonly distance: (a: WindowCoordinates, b: WindowCoordinates) => number;
}

/** 默认的吸附阈值（像素），与绘制控制器的顶点命中保持一致。 */
export const DEFAULT_SNAP_PIXEL_TOLERANCE = 12;

/** 最大允许阈值，避免业务误配成"吸到半个屏幕外"。 */
export const MAX_SNAP_PIXEL_TOLERANCE = 64;

function euclidean(a: WindowCoordinates, b: WindowCoordinates): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function invalidSnap(message: string, operation = 'snap'): GisError {
  return new GisError(message, {
    code: 'INVALID_DRAWING_INPUT',
    module: 'drawing',
    operation,
  });
}

function assertFinite(value: number, name: string, operation: string): void {
  if (!Number.isFinite(value)) {
    throw invalidSnap(`${name} must be a finite number.`, operation);
  }
}

/**
 * 解析吸附配置：补齐默认值并校验范围。
 *
 * @param options - 调用方配置。
 * @returns 补齐后的配置。
 * @throws `INVALID_DRAWING_INPUT` 阈值非有限数或超出 1 到 64。
 */
export function resolveSnapOptions(options: SnapOptions = {}): ResolvedSnapOptions {
  const pixelTolerance = options.pixelTolerance ?? DEFAULT_SNAP_PIXEL_TOLERANCE;
  if (
    !Number.isFinite(pixelTolerance) ||
    pixelTolerance < 1 ||
    pixelTolerance > MAX_SNAP_PIXEL_TOLERANCE
  ) {
    throw invalidSnap(
      `Snap pixelTolerance must be a finite number between 1 and ${String(MAX_SNAP_PIXEL_TOLERANCE)}.`,
    );
  }
  return {
    pixelTolerance,
    includeEdges: options.includeEdges === true,
    distance: options.distance ?? euclidean,
  };
}

/**
 * 在候选顶点与线段中找出应该吸附的目标。
 *
 * 规则与参照实现的提案一致：**顶点优先**——阈值内有顶点就直接吸附顶点，无论线段是否更近；
 * 没有顶点时再看线段（`includeEdges` 打开才考虑）。这样在密集折线上，鼠标靠近交点时不会
 * 因为"线段更近"而错过顶点。
 *
 * 线段候选的吸附点按**屏幕比例**在两端之间插值：屏幕上的最近比例映射回经纬高，视觉上
 * 落点就贴在光标处；这是一种近似（严格解需要投影到测地线），在常用缩放下误差远小于一个像素。
 *
 * @param vertices - 顶点候选。
 * @param segments - 线段候选；`includeEdges` 为 `false` 时不参与。
 * @param cursor - 光标屏幕坐标。
 * @param options - 阈值、是否含线段与距离度量。
 * @returns 命中结果；没有命中的候选时返回 `undefined`。
 */
export function findSnapTarget(
  vertices: readonly SnapVertex[],
  segments: readonly SnapSegment[],
  cursor: WindowCoordinates,
  options: SnapOptions = {},
): SnapResult | undefined {
  const operation = 'findSnapTarget';
  assertFinite(cursor.x, 'cursor.x', operation);
  assertFinite(cursor.y, 'cursor.y', operation);
  const resolved = resolveSnapOptions(options);
  const measure = resolved.distance;

  let bestVertex: SnapResult | undefined;
  for (const vertex of vertices) {
    const distance = measure(vertex.screen, cursor);
    if (distance > resolved.pixelTolerance) {
      continue;
    }
    if (!bestVertex || distance < bestVertex.distancePixels) {
      bestVertex = { kind: 'vertex', position: vertex.position, distancePixels: distance };
    }
  }
  if (bestVertex) {
    return bestVertex;
  }
  if (!resolved.includeEdges) {
    return undefined;
  }

  let bestEdge: SnapResult | undefined;
  for (const segment of segments) {
    const projected = projectOnSegment(segment.fromScreen, segment.toScreen, cursor, measure);
    if (projected.distance > resolved.pixelTolerance) {
      continue;
    }
    if (!bestEdge || projected.distance < bestEdge.distancePixels) {
      bestEdge = {
        kind: 'edge',
        position: interpolatePosition(segment.from, segment.to, projected.ratio),
        distancePixels: projected.distance,
      };
    }
  }
  return bestEdge;
}

/** 屏幕空间投影：返回最近点距离与沿线段的比例（0 到 1）。 */
function projectOnSegment(
  from: WindowCoordinates,
  to: WindowCoordinates,
  cursor: WindowCoordinates,
  measure: (a: WindowCoordinates, b: WindowCoordinates) => number,
): { readonly distance: number; readonly ratio: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return { distance: measure(from, cursor), ratio: 0 };
  }
  const raw = ((cursor.x - from.x) * dx + (cursor.y - from.y) * dy) / lengthSquared;
  const ratio = Math.min(1, Math.max(0, raw));
  const closest = { x: from.x + dx * ratio, y: from.y + dy * ratio };
  return { distance: measure(closest, cursor), ratio };
}

/** 按比例在两端的经纬高之间插值；经度走最短弧。 */
function interpolatePosition(from: GeoPosition, to: GeoPosition, ratio: number): GeoPosition {
  const longitudeDelta = ((to.longitude - from.longitude + 540) % 360) - 180;
  const startHeight = from.height ?? 0;
  const endHeight = to.height ?? 0;
  return {
    longitude: ((from.longitude + longitudeDelta * ratio + 540) % 360) - 180,
    latitude: from.latitude + (to.latitude - from.latitude) * ratio,
    height: startHeight + (endHeight - startHeight) * ratio,
  };
}

/** 从一组顶点按相邻关系生成线段候选。 */
export function segmentsOf(vertices: readonly SnapVertex[]): SnapSegment[] {
  const segments: SnapSegment[] = [];
  for (let index = 0; index + 1 < vertices.length; index += 1) {
    const from = vertices[index];
    const to = vertices[index + 1];
    if (!from || !to) {
      continue;
    }
    segments.push({
      from: from.position,
      fromScreen: from.screen,
      to: to.position,
      toScreen: to.screen,
    });
  }
  return segments;
}
