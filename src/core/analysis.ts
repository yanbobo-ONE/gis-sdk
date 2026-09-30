import type { TerrainSample, TerrainSamplePoint } from './controls.js';
import type { SPATIAL_ALGORITHM_VERSION } from '../spatial/types.js';
import type { GeoBBox, GeoPoint, GeoPolygon, GeoRing } from '../spatial/types.js';
import type { FilterPointsInPolygonResult } from '../spatial/predicate.js';
import type {
  AreaMeasurement,
  BearingMeasurement,
  DistanceMeasurement,
} from '../spatial/measure.js';

/**
 * 内置分析工具 ID；插件注册的工具沿用同一命名规则。
 *
 * PRD 一期工具为 `distance`、`surface-distance`、`area`、`bearing`、
 * `terrain-sample`、`line-of-sight`、`viewshed`、`slope-aspect`、`transform`；
 * `point-in-polygon`、`points-in-polygon`、`bbox`、`center-of-mass` 属需求驱动的补强项；
 * `convex-hull`、`simplify` 是 P2 批处理工具（凸包与轨迹抽稀）。
 */
export type AnalysisToolId =
  | 'convex-hull'
  | 'simplify'
  | 'distance'
  | 'surface-distance'
  | 'area'
  | 'bearing'
  | 'terrain-sample'
  | 'line-of-sight'
  | 'viewshed'
  | 'slope-aspect'
  | 'transform'
  | 'point-in-polygon'
  | 'points-in-polygon'
  | 'bbox'
  | 'center-of-mass';

/** 分析执行选项。 */
export interface AnalysisRunOptions {
  /**
   * 取消尚未完成的分析。
   *
   * 与 `map.terrain.sample()` 一致：已发出的请求不会撤回，但结果不再返回，
   * 调用方收到以 `ABORTED` 语义拒绝的 `GisError`。
   */
  readonly signal?: AbortSignal;
}

/** 所有分析结果共有的元信息。 */
export interface AnalysisResultMeta {
  /** 计算所用的算法版本，取值见 `SPATIAL_ALGORITHM_VERSION`。 */
  readonly algorithmVersion: typeof SPATIAL_ALGORITHM_VERSION;
}

/** 凸包工具输入。 */
export interface AnalysisConvexHullInput {
  /** 待求凸包的点集。 */
  readonly points: readonly GeoPoint[];
}

/** 凸包结果。 */
export interface AnalysisConvexHullResult {
  /** 闭合的凸包环（首尾同点）。 */
  readonly hull: GeoRing;
  /** 参与计算的去重后点数。 */
  readonly pointCount: number;
}

/** 抽稀工具输入。 */
export interface AnalysisSimplifyInput {
  /** 待抽稀的顶点序列（折线或环）。 */
  readonly points: GeoRing;
  /** 容差，单位为米，必须为正。 */
  readonly toleranceMeters: number;
}

/** 抽稀结果。 */
export interface AnalysisSimplifyResult {
  /** 抽稀后的顶点；首尾保留，输入是环时保持闭合。 */
  readonly points: GeoPoint[];
  /** 输入顶点数。 */
  readonly originalCount: number;
  /** 被移除的顶点数。 */
  readonly removedCount: number;
}

/** 距离类工具输入。 */
export interface AnalysisDistanceInput {
  /** 起点。 */
  readonly from: GeoPoint;
  /** 终点。 */
  readonly to: GeoPoint;
  /** 结果单位，默认米。 */
  readonly units?: DistanceMeasurement['unit'];
}

/** 地表距离输入；比直线距离多一次地形采样。 */
export interface AnalysisSurfaceDistanceInput extends AnalysisDistanceInput {
  /** 沿线采样点数，默认由实现决定。 */
  readonly samples?: number;
}

/** 地表距离结果。 */
export interface AnalysisSurfaceDistanceResult extends DistanceMeasurement {
  /** 实际参与计算的采样点数。 */
  readonly sampleCount: number;
}

/** 面积工具输入。 */
export interface AnalysisAreaInput {
  /** 顶点环或带洞多边形。 */
  readonly polygon: GeoRing | GeoPolygon;
}

/** 方位角工具输入。 */
export interface AnalysisBearingInput {
  /** 起点。 */
  readonly from: GeoPoint;
  /** 终点。 */
  readonly to: GeoPoint;
}

/** 地形采样工具输入。 */
export interface AnalysisTerrainSampleInput {
  /** 待采样点。 */
  readonly points: readonly TerrainSamplePoint[];
  /** 采样策略，语义与 `map.terrain.sample()` 相同。 */
  readonly strategy?: 'most-detailed' | 'level';
  /** `level` 策略使用的层级。 */
  readonly level?: number;
}

/** 通视分析输入。 */
export interface AnalysisLineOfSightInput {
  /** 观察点。 */
  readonly from: GeoPoint;
  /** 目标点。 */
  readonly to: GeoPoint;
  /** 沿线采样点数，默认由实现决定。 */
  readonly samples?: number;
  /** 是否把地形高度纳入判断，默认 `true`。 */
  readonly includeTerrain?: boolean;
}

/** 通视分析结果。 */
export interface AnalysisLineOfSightResult {
  /** 两点之间是否可见。 */
  readonly visible: boolean;
  /** 实际采样点数。 */
  readonly sampleCount: number;
  /** 视线到地形的最小余隙，单位为米；为负表示已被地形遮挡。 */
  readonly minClearanceMeters: number;
  /** 首个遮挡点所在的采样序号；可见时为 `undefined`。 */
  readonly blockedAtIndex: number | undefined;
}

/** 视域分析输入（基础版）。 */
export interface AnalysisViewshedInput {
  /** 观察点。 */
  readonly center: GeoPoint;
  /** 分析半径，单位为米。 */
  readonly radiusMeters: number;
  /** 方位采样数，默认由实现决定。 */
  readonly samples?: number;
}

/** 视域分析结果（基础版）。 */
export interface AnalysisViewshedResult {
  /** 可见范围边界；按方位顺序排列，可直接作为结果图层的环。 */
  readonly horizon: GeoRing;
  /** 实际方位采样数。 */
  readonly sampleCount: number;
  /** 视线被地形截断的最短距离，单位为米。 */
  readonly blockedDistanceMeters: number;
}

/** 坡度坡向输入（基础版）。 */
export interface AnalysisSlopeAspectInput {
  /** 采样中心点。 */
  readonly center: GeoPoint;
  /** 采样半径，单位为米。 */
  readonly radiusMeters: number;
  /** 邻域采样数，默认由实现决定。 */
  readonly samples?: number;
}

/** 坡度坡向结果（基础版）。 */
export interface AnalysisSlopeAspectResult {
  /** 坡度，单位为度，`0` 表示水平。 */
  readonly slopeDegrees: number;
  /** 坡向，单位为度，正北为 0，顺时针为正，指向下坡方向。 */
  readonly aspectDegrees: number;
  /** 实际参与拟合的采样点数（不含中心点本身）。 */
  readonly sampleCount: number;
  /** 中心点的椭球高，单位为米；取自输入或地形采样。 */
  readonly centerHeightMeters: number;
}

/** CRS 转换工具输入。 */
export interface AnalysisTransformInput {
  /** 待转换点；字段含义随 CRS 变化，见 `transformGeoPoint`。 */
  readonly point: GeoPoint;
  /** 源 CRS 标识。 */
  readonly from: string;
  /** 目标 CRS 标识。 */
  readonly to: string;
}

/** 单点面判断输入。 */
export interface AnalysisPointInPolygonInput {
  /** 待判断点。 */
  readonly point: GeoPoint;
  /** 带洞多边形。 */
  readonly polygon: GeoPolygon;
  /** 是否忽略边界，默认 `false`。 */
  readonly ignoreBoundary?: boolean;
}

/** 单点面判断结果。 */
export interface AnalysisPointInPolygonResult {
  /** 是否落在多边形内。 */
  readonly inside: boolean;
}

/** 批量点面判断输入。 */
export interface AnalysisPointsInPolygonInput {
  /** 待判断点集。 */
  readonly points: readonly GeoPoint[];
  /** 带洞多边形。 */
  readonly polygon: GeoPolygon;
  /** 是否忽略边界，默认 `false`。 */
  readonly ignoreBoundary?: boolean;
}

/** 包围盒工具输入。 */
export interface AnalysisBBoxInput {
  /** 单个点、顶点序列或带洞多边形。 */
  readonly input: GeoPoint | GeoRing | GeoPolygon;
}

/** 质心工具输入。 */
export interface AnalysisCenterOfMassInput {
  /** 顶点序列或带洞多边形。 */
  readonly input: GeoRing | GeoPolygon;
}

/** 工具 ID 到输入类型的映射。 */
export interface AnalysisInputMap {
  /** 凸包输入。 */
  readonly 'convex-hull': AnalysisConvexHullInput;
  /** 抽稀输入。 */
  readonly simplify: AnalysisSimplifyInput;
  /** 两点距离输入。 */
  readonly distance: AnalysisDistanceInput;
  /** 地表距离输入，沿线叠加地形高度。 */
  readonly 'surface-distance': AnalysisSurfaceDistanceInput;
  /** 多边形面积输入。 */
  readonly area: AnalysisAreaInput;
  /** 方位角输入。 */
  readonly bearing: AnalysisBearingInput;
  /** 批量地形采样输入。 */
  readonly 'terrain-sample': AnalysisTerrainSampleInput;
  /** 两点通视输入。 */
  readonly 'line-of-sight': AnalysisLineOfSightInput;
  /** 视域分析输入。 */
  readonly viewshed: AnalysisViewshedInput;
  /** 坡度坡向输入。 */
  readonly 'slope-aspect': AnalysisSlopeAspectInput;
  /** CRS 转换输入。 */
  readonly transform: AnalysisTransformInput;
  /** 单点面判断输入。 */
  readonly 'point-in-polygon': AnalysisPointInPolygonInput;
  /** 批量点面判断输入。 */
  readonly 'points-in-polygon': AnalysisPointsInPolygonInput;
  /** 包围盒输入。 */
  readonly bbox: AnalysisBBoxInput;
  /** 质心输入。 */
  readonly 'center-of-mass': AnalysisCenterOfMassInput;
}

/** 工具 ID 到结果类型的映射。 */
export interface AnalysisResultMap {
  /** 凸包结果。 */
  readonly 'convex-hull': AnalysisConvexHullResult & AnalysisResultMeta;
  /** 抽稀结果。 */
  readonly simplify: AnalysisSimplifyResult & AnalysisResultMeta;
  /** 距离量算结果。 */
  readonly distance: DistanceMeasurement & AnalysisResultMeta;
  /** 地表距离量算结果。 */
  readonly 'surface-distance': AnalysisSurfaceDistanceResult & AnalysisResultMeta;
  /** 面积量算结果。 */
  readonly area: AreaMeasurement & AnalysisResultMeta;
  /** 方位角量算结果。 */
  readonly bearing: BearingMeasurement & AnalysisResultMeta;
  /** 地形采样结果；与 `map.terrain.sample()` 返回同构，故不附加算法版本。 */
  readonly 'terrain-sample': readonly TerrainSample[];
  /** 通视分析结果。 */
  readonly 'line-of-sight': AnalysisLineOfSightResult & AnalysisResultMeta;
  /** 视域分析结果。 */
  readonly viewshed: AnalysisViewshedResult & AnalysisResultMeta;
  /** 坡度坡向结果。 */
  readonly 'slope-aspect': AnalysisSlopeAspectResult & AnalysisResultMeta;
  /** CRS 转换结果：字段含义随目标 CRS 变化。 */
  readonly transform: GeoPoint & AnalysisResultMeta;
  /** 单点面判断结果。 */
  readonly 'point-in-polygon': AnalysisPointInPolygonResult & AnalysisResultMeta;
  /** 批量点面判断结果。 */
  readonly 'points-in-polygon': FilterPointsInPolygonResult & AnalysisResultMeta;
  /** 包围盒结果。 */
  readonly bbox: GeoBBox & AnalysisResultMeta;
  /** 质心结果。 */
  readonly 'center-of-mass': GeoPoint & AnalysisResultMeta;
}

/** 分析工具的只读描述。 */
export interface AnalysisToolDescriptor {
  /** 工具 ID。 */
  readonly id: AnalysisToolId;
  /** 工具来源：内置或插件注册。 */
  readonly source: 'builtin' | 'plugin';
  /** 面向使用者的中文名称。 */
  readonly title: string;
  /** 一句话说明该工具做什么、需要什么输入。 */
  readonly description: string;
}

/**
 * 类型化分析控制器。
 *
 * 按工具 ID 窄化输入与输出类型；取消走 `AbortSignal`，与 `map.terrain.sample()` 保持一致。
 * 输入输出统一使用 `{ longitude, latitude }` 形式的对象，不使用 `[lng, lat]` 数组。
 *
 * @example
 * ```ts
 * const { meters } = await map.analysis.run('distance', { from, to });
 * ```
 */
export interface AnalysisController {
  /** 执行一个分析工具。 */
  run<T extends AnalysisToolId>(
    tool: T,
    input: AnalysisInputMap[T],
    options?: AnalysisRunOptions,
  ): Promise<AnalysisResultMap[T]>;
  /** 列出当前可用工具（内置 + 插件注册）。 */
  list(): readonly AnalysisToolDescriptor[];
}
