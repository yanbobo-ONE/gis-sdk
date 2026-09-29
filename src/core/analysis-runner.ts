import type {
  AnalysisAreaInput,
  AnalysisBBoxInput,
  AnalysisBearingInput,
  AnalysisCenterOfMassInput,
  AnalysisController,
  AnalysisDistanceInput,
  AnalysisInputMap,
  AnalysisLineOfSightInput,
  AnalysisPointInPolygonInput,
  AnalysisPointsInPolygonInput,
  AnalysisResultMap,
  AnalysisRunOptions,
  AnalysisSlopeAspectInput,
  AnalysisSurfaceDistanceInput,
  AnalysisSurfaceDistanceResult,
  AnalysisTerrainSampleInput,
  AnalysisToolDescriptor,
  AnalysisToolId,
  AnalysisTransformInput,
  AnalysisViewshedInput,
} from './analysis.js';
import type { GeoPoint } from '../spatial/types.js';
import type { TerrainSample, TerrainSampleOptions, TerrainSamplePoint } from './controls.js';
import { GisError } from './errors.js';
import { measureArea, measureBBox, measureBearing, measureCenterOfMass, measureDestination, measureDistance } from '../spatial/measure.js';
import { filterPointsInPolygon, isPointInPolygon } from '../spatial/predicate.js';
import { transformGeoPoint } from '../spatial/crs.js';
import { SPATIAL_ALGORITHM_VERSION } from '../spatial/types.js';
import {
  evaluateHorizon,
  evaluateLineOfSight,
  slopeAspectFromPlane,
  surfacePathLength,
  type PlanePoint,
  type TerrainProfilePoint,
} from '../spatial/terrain-profile.js';

/** 分析工具需要的地形采样端口；Cesium 适配器把它接到 `map.terrain.sample()`。 */
export interface AnalysisTerrainPort {
  /**
   * 批量采样地形高度。
   *
   * @param points - 待采样点。
   * @param options - 采样策略。
   * @returns 与输入顺序一致的采样结果。
   */
  sample(
    points: readonly TerrainSamplePoint[],
    options?: TerrainSampleOptions,
  ): Promise<readonly TerrainSample[]>;
}

/** 分析控制器的可调默认值。 */
export interface AnalysisControllerOptions {
  /** 地表距离的默认分段数，默认 32。 */
  readonly surfaceDistanceSamples?: number;
  /** 通视分析的默认分段数，默认 32（沿线取 31 个中间点）。 */
  readonly lineOfSightSamples?: number;
  /** 视域分析的默认方位数，默认 72（每 5 度一条射线）。 */
  readonly viewshedAzimuths?: number;
  /** 视域分析每条射线的默认分段数，默认 32。 */
  readonly viewshedSteps?: number;
  /** 坡度坡向的默认邻域采样数，默认 8（正北起顺时针一圈）。 */
  readonly slopeAspectSamples?: number;
}

/** 内置工具的只读描述；名称与说明面向使用者，不在代码里做分支判断。 */
const BUILTIN_TOOLS: readonly AnalysisToolDescriptor[] = Object.freeze([
  {
    id: 'distance',
    source: 'builtin',
    title: '两点距离',
    description: '按大圆距离量算两点直线距离，可选单位；不做地形修正。',
  },
  {
    id: 'surface-distance',
    source: 'builtin',
    title: '地表距离',
    description: '沿线分段采样地形，累加三维弦长，得到贴近地表的距离。',
  },
  {
    id: 'area',
    source: 'builtin',
    title: '面积',
    description: '量算顶点环或带洞多边形的球面面积。',
  },
  {
    id: 'bearing',
    source: 'builtin',
    title: '方位角',
    description: '起点到终点的方位角，正北为 0、顺时针为正。',
  },
  {
    id: 'terrain-sample',
    source: 'builtin',
    title: '地形采样',
    description: '批量读取地形高度；没有数据的点标记为 no-data，不伪造成 0。',
  },
  {
    id: 'line-of-sight',
    source: 'builtin',
    title: '通视分析',
    description: '判断两点之间是否被地形遮挡，给出最小余隙与首个遮挡点。',
  },
  {
    id: 'viewshed',
    source: 'builtin',
    title: '视域分析',
    description: '按方位扇形扫描地形，给出可见范围边界与最近遮挡距离。',
  },
  {
    id: 'slope-aspect',
    source: 'builtin',
    title: '坡度坡向',
    description: '拟合邻域平面得到坡度与下坡方向。',
  },
  {
    id: 'transform',
    source: 'builtin',
    title: '坐标转换',
    description: '按已注册 CRS 转换单点坐标。',
  },
  {
    id: 'point-in-polygon',
    source: 'builtin',
    title: '点在面内',
    description: '判断单点是否落在多边形（含洞）内。',
  },
  {
    id: 'points-in-polygon',
    source: 'builtin',
    title: '批量点在面内',
    description: '批量判断点集，返回命中下标、命中点与数量。',
  },
  {
    id: 'bbox',
    source: 'builtin',
    title: '包围盒',
    description: '给出点、顶点序列或多边形的经纬包围盒。',
  },
  {
    id: 'center-of-mass',
    source: 'builtin',
    title: '质心',
    description: '给出顶点序列或多边形的质心。',
  },
]);

const DEFAULT_SURFACE_DISTANCE_SAMPLES = 32;
const DEFAULT_LINE_OF_SIGHT_SAMPLES = 32;
const DEFAULT_VIEWSHED_AZIMUTHS = 72;
const DEFAULT_VIEWSHED_STEPS = 32;
const DEFAULT_SLOPE_ASPECT_SAMPLES = 8;

function analysisError(
  message: string,
  code: 'UNKNOWN_ANALYSIS_TOOL' | 'ANALYSIS_TERRAIN_UNAVAILABLE' | 'INVALID_ANALYSIS_INPUT',
  operation: string,
  retryable = false,
): GisError {
  return new GisError(message, { code, module: 'analysis', operation, retryable });
}

function aborted(operation: string): GisError {
  return new GisError('Analysis run was aborted.', {
    code: 'ANALYSIS_ABORTED',
    module: 'analysis',
    operation,
    retryable: true,
  });
}

/** 按分段数生成路径上的采样点（含两端），返回点与相邻水平距离。 */
function samplePath(
  from: GeoPoint,
  to: GeoPoint,
  segments: number,
): { readonly points: GeoPoint[]; readonly horizontalDistanceMeters: number } {
  const bearing = measureBearing(from, to).degrees;
  const total = measureDistance(from, to, { units: 'meters' }).meters;
  const points: GeoPoint[] = [];
  for (let index = 0; index <= segments; index += 1) {
    const ratio = index / segments;
    if (index === 0) {
      points.push({ ...from });
      continue;
    }
    if (index === segments) {
      points.push({ ...to });
      continue;
    }
    const position = measureDestination(from, bearing, total * ratio);
    const point: GeoPoint = { longitude: position.longitude, latitude: position.latitude };
    // 两端都给了高度就按比例插值；否则把高度留给地形采样。
    points.push(
      from.height === undefined && to.height === undefined
        ? point
        : { ...point, height: interpolateHeight(from, to, ratio) },
    );
  }
  return { points, horizontalDistanceMeters: total / segments };
}

function interpolateHeight(from: GeoPoint, to: GeoPoint, ratio: number): number {
  const start = from.height ?? 0;
  const end = to.height ?? 0;
  return start + (end - start) * ratio;
}

/** 把采样结果转成 { 经度, 纬度, 高度 } 三元组；缺数据时为 `undefined`。 */
function heightAt(samples: readonly TerrainSample[], index: number): number | undefined {
  const sample = samples[index];
  if (sample?.status !== 'ok' || sample.height === undefined) {
    return undefined;
  }
  return sample.height;
}

/**
 * 创建类型化分析控制器。
 *
 * 控制器本身不依赖 Cesium：需要地形高度的工具通过 {@link AnalysisTerrainPort} 取数，
 * 其余工具全部是 `/core` 里的纯函数，因此同一份实现在其它终端（Worker、原生宿主）也能用。
 *
 * @param terrain - 地形采样端口。
 * @param options - 采样默认值覆盖。
 * @returns 分析控制器。
 */
export function createAnalysisController(
  terrain: AnalysisTerrainPort,
  options: AnalysisControllerOptions = {},
): AnalysisController {
  const surfaceDistanceSamples = options.surfaceDistanceSamples ?? DEFAULT_SURFACE_DISTANCE_SAMPLES;
  const lineOfSightSamples = options.lineOfSightSamples ?? DEFAULT_LINE_OF_SIGHT_SAMPLES;
  const viewshedAzimuths = options.viewshedAzimuths ?? DEFAULT_VIEWSHED_AZIMUTHS;
  const viewshedSteps = options.viewshedSteps ?? DEFAULT_VIEWSHED_STEPS;
  const slopeAspectSamples = options.slopeAspectSamples ?? DEFAULT_SLOPE_ASPECT_SAMPLES;

  const assertNotAborted = (signal: AbortSignal | undefined, operation: string): void => {
    if (signal?.aborted === true) {
      throw aborted(operation);
    }
  };

  const runDistance = (input: AnalysisDistanceInput): AnalysisResultMap['distance'] => ({
    ...measureDistance(input.from, input.to, input.units === undefined ? {} : { units: input.units }),
    algorithmVersion: SPATIAL_ALGORITHM_VERSION,
  });

  const runSurfaceDistance = async (
    input: AnalysisSurfaceDistanceInput,
    signal: AbortSignal | undefined,
  ): Promise<AnalysisSurfaceDistanceResult & { algorithmVersion: number }> => {
    const segments = Math.max(1, Math.floor(input.samples ?? surfaceDistanceSamples));
    const { points, horizontalDistanceMeters } = samplePath(input.from, input.to, segments);
    const needsTerrain = points.some((point) => point.height === undefined);
    const heights = needsTerrain ? await sampleHeights(terrain, points, signal) : undefined;
    let total = 0;
    let used = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
      const fromHeight = points[index]?.height ?? heightAt(heights ?? [], index);
      const toHeight = points[index + 1]?.height ?? heightAt(heights ?? [], index + 1);
      if (fromHeight === undefined || toHeight === undefined) {
        continue;
      }
      total += surfacePathLength([
        {
          horizontalDistanceMeters,
          fromHeightMeters: fromHeight,
          toHeightMeters: toHeight,
        },
      ]);
      used += 1;
    }
    if (used === 0) {
      throw analysisError(
        'Terrain height is unavailable along the whole path.',
        'ANALYSIS_TERRAIN_UNAVAILABLE',
        'surface-distance',
        true,
      );
    }
    return {
      meters: total,
      value: total,
      unit: 'meters',
      sampleCount: used + 1,
      algorithmVersion: SPATIAL_ALGORITHM_VERSION,
    };
  };

  const runLineOfSight = async (
    input: AnalysisLineOfSightInput,
    signal: AbortSignal | undefined,
  ): Promise<AnalysisResultMap['line-of-sight']> => {
    const includeTerrain = input.includeTerrain !== false;
    const segments = Math.max(1, Math.floor(input.samples ?? lineOfSightSamples));
    const distance = measureDistance(input.from, input.to, { units: 'meters' }).meters;
    const bearing = measureBearing(input.from, input.to).degrees;
    // 每个待求高度的点占一个槽位：端点只在缺少显式高度时占位，中间点全部占位。
    const requests: TerrainSamplePoint[] = [];
    const fromSlot = input.from.height === undefined ? requests.length : -1;
    if (fromSlot >= 0) {
      requests.push(input.from);
    }
    const interiorSlots: number[] = [];
    if (includeTerrain) {
      for (let index = 1; index < segments; index += 1) {
        const position = measureDestination(input.from, bearing, (distance * index) / segments);
        interiorSlots.push(requests.length);
        requests.push({ longitude: position.longitude, latitude: position.latitude });
      }
    }
    const toSlot = input.to.height === undefined ? requests.length : -1;
    if (toSlot >= 0) {
      requests.push(input.to);
    }
    const samples = requests.length > 0 ? await sampleHeights(terrain, requests, signal) : [];
    const fromHeightMeters = input.from.height ?? heightAt(samples, fromSlot);
    const toHeightMeters = input.to.height ?? heightAt(samples, toSlot);
    const profile: TerrainProfilePoint[] = [];
    interiorSlots.forEach((slot, index) => {
      const height = heightAt(samples, slot);
      if (height === undefined) {
        return;
      }
      profile.push({
        distanceMeters: (distance * (index + 1)) / segments,
        heightMeters: height,
      });
    });
    if (fromHeightMeters === undefined && toHeightMeters === undefined && profile.length === 0) {
      throw analysisError(
        'Terrain height is unavailable along the line of sight.',
        'ANALYSIS_TERRAIN_UNAVAILABLE',
        'line-of-sight',
        true,
      );
    }
    const evaluation = evaluateLineOfSight({
      fromHeightMeters: fromHeightMeters ?? 0,
      toHeightMeters: toHeightMeters ?? 0,
      distanceMeters: distance,
      profile,
    });
    return { ...evaluation, algorithmVersion: SPATIAL_ALGORITHM_VERSION };
  };

  const runViewshed = async (
    input: AnalysisViewshedInput,
    signal: AbortSignal | undefined,
  ): Promise<AnalysisResultMap['viewshed']> => {
    const azimuths = Math.max(3, Math.floor(input.samples ?? viewshedAzimuths));
    const steps = viewshedSteps;
    const radius = input.radiusMeters;
    if (!Number.isFinite(radius) || radius <= 0) {
      throw analysisError('viewshed.radiusMeters must be positive.', 'INVALID_ANALYSIS_INPUT', 'viewshed');
    }
    const rays: GeoPoint[][] = [];
    const samplePoints: TerrainSamplePoint[] = [];
    for (let ray = 0; ray < azimuths; ray += 1) {
      const bearing = (360 * ray) / azimuths;
      const points: GeoPoint[] = [];
      for (let step = 1; step <= steps; step += 1) {
        const position = measureDestination(input.center, bearing, (radius * step) / steps);
        points.push({ longitude: position.longitude, latitude: position.latitude });
        samplePoints.push({ longitude: position.longitude, latitude: position.latitude });
      }
      rays.push(points);
    }
    const centerNeedsTerrain = input.center.height === undefined;
    const samples = await sampleHeights(
      terrain,
      centerNeedsTerrain ? [input.center, ...samplePoints] : samplePoints,
      signal,
    );
    const observerHeight = input.center.height ?? heightAt(samples, centerNeedsTerrain ? 0 : -1);
    if (observerHeight === undefined) {
      throw analysisError(
        'Terrain height is unavailable at the viewshed center.',
        'ANALYSIS_TERRAIN_UNAVAILABLE',
        'viewshed',
        true,
      );
    }
    const offset = centerNeedsTerrain ? 1 : 0;
    const horizon: GeoPoint[] = [];
    let shortestBlocked = Number.POSITIVE_INFINITY;
    let usedAzimuths = 0;
    let usedSamples = 0;
    for (let ray = 0; ray < rays.length; ray += 1) {
      const points = rays[ray] ?? [];
      const profile: TerrainProfilePoint[] = [];
      for (let step = 0; step < points.length; step += 1) {
        const height = heightAt(samples, offset + ray * steps + step);
        if (height === undefined) {
          continue;
        }
        profile.push({ distanceMeters: (radius * (step + 1)) / steps, heightMeters: height });
      }
      if (profile.length === 0) {
        continue;
      }
      usedAzimuths += 1;
      usedSamples += profile.length;
      const evaluation = evaluateHorizon({ observerHeightMeters: observerHeight, profile });
      const distance = evaluation.visibleDistanceMeters > 0 ? evaluation.visibleDistanceMeters : radius;
      const edge = measureDestination(input.center, (360 * ray) / azimuths, distance);
      horizon.push({ longitude: edge.longitude, latitude: edge.latitude });
      if (evaluation.blockedDistanceMeters !== undefined) {
        shortestBlocked = Math.min(shortestBlocked, evaluation.blockedDistanceMeters);
      }
    }
    if (usedAzimuths === 0) {
      throw analysisError(
        'Terrain height is unavailable on every viewshed ray.',
        'ANALYSIS_TERRAIN_UNAVAILABLE',
        'viewshed',
        true,
      );
    }
    return {
      horizon,
      sampleCount: usedSamples,
      blockedDistanceMeters: Number.isFinite(shortestBlocked) ? shortestBlocked : radius,
      algorithmVersion: SPATIAL_ALGORITHM_VERSION,
    };
  };

  const runSlopeAspect = async (
    input: AnalysisSlopeAspectInput,
    signal: AbortSignal | undefined,
  ): Promise<AnalysisResultMap['slope-aspect']> => {
    const ringCount = Math.max(3, Math.floor(input.samples ?? slopeAspectSamples));
    const radius = input.radiusMeters;
    if (!Number.isFinite(radius) || radius <= 0) {
      throw analysisError(
        'slope-aspect.radiusMeters must be positive.',
        'INVALID_ANALYSIS_INPUT',
        'slope-aspect',
      );
    }
    const ring: GeoPoint[] = [];
    for (let index = 0; index < ringCount; index += 1) {
      const position = measureDestination(input.center, (360 * index) / ringCount, radius);
      ring.push({ longitude: position.longitude, latitude: position.latitude });
    }
    const centerNeedsTerrain = input.center.height === undefined;
    const samples = await sampleHeights(
      terrain,
      centerNeedsTerrain ? [input.center, ...ring] : ring,
      signal,
    );
    const offset = centerNeedsTerrain ? 1 : 0;
    const centerHeight = input.center.height ?? heightAt(samples, centerNeedsTerrain ? 0 : -1);
    if (centerHeight === undefined) {
      throw analysisError(
        'Terrain height is unavailable at the slope-aspect center.',
        'ANALYSIS_TERRAIN_UNAVAILABLE',
        'slope-aspect',
        true,
      );
    }
    const planePoints: PlanePoint[] = [];
    for (let index = 0; index < ring.length; index += 1) {
      const height = heightAt(samples, offset + index);
      const point = ring[index];
      if (height === undefined || !point) {
        continue;
      }
      const bearing = (360 * index) / ringCount;
      const radians = (bearing * Math.PI) / 180;
      planePoints.push({
        eastMeters: radius * Math.sin(radians),
        northMeters: radius * Math.cos(radians),
        heightMeters: height,
      });
    }
    if (planePoints.length < 3) {
      throw analysisError(
        'Terrain height is unavailable on too many slope-aspect samples.',
        'ANALYSIS_TERRAIN_UNAVAILABLE',
        'slope-aspect',
        true,
      );
    }
    const slopeAspect = slopeAspectFromPlane(planePoints);
    return {
      ...slopeAspect,
      sampleCount: planePoints.length + 1,
      centerHeightMeters: centerHeight,
      algorithmVersion: SPATIAL_ALGORITHM_VERSION,
    };
  };

  const runTerrainSample = async (
    input: AnalysisTerrainSampleInput,
    signal: AbortSignal | undefined,
  ): Promise<readonly TerrainSample[]> => {
    const options: TerrainSampleOptions =
      input.strategy === undefined
        ? {}
        : { strategy: input.strategy, ...(input.level === undefined ? {} : { level: input.level }) };
    return sampleHeights(terrain, input.points, signal, options);
  };

  const runTransform = (input: AnalysisTransformInput): AnalysisResultMap['transform'] => ({
    ...transformGeoPoint(input.point, input.from, input.to),
    algorithmVersion: SPATIAL_ALGORITHM_VERSION,
  });

  const runPointInPolygon = (input: AnalysisPointInPolygonInput): AnalysisResultMap['point-in-polygon'] => ({
    inside: isPointInPolygon(input.point, input.polygon, {
      ignoreBoundary: input.ignoreBoundary === true,
    }),
    algorithmVersion: SPATIAL_ALGORITHM_VERSION,
  });

  const runPointsInPolygon = (input: AnalysisPointsInPolygonInput): AnalysisResultMap['points-in-polygon'] => ({
    ...filterPointsInPolygon(input.points, input.polygon, {
      ignoreBoundary: input.ignoreBoundary === true,
    }),
    algorithmVersion: SPATIAL_ALGORITHM_VERSION,
  });

  const runBBox = (input: AnalysisBBoxInput): AnalysisResultMap['bbox'] => ({
    ...measureBBox(input.input),
    algorithmVersion: SPATIAL_ALGORITHM_VERSION,
  });

  const runArea = (input: AnalysisAreaInput): AnalysisResultMap['area'] => ({
    ...measureArea(input.polygon),
    algorithmVersion: SPATIAL_ALGORITHM_VERSION,
  });

  const runBearing = (input: AnalysisBearingInput): AnalysisResultMap['bearing'] => ({
    ...measureBearing(input.from, input.to),
    algorithmVersion: SPATIAL_ALGORITHM_VERSION,
  });

  const runCenterOfMass = (input: AnalysisCenterOfMassInput): AnalysisResultMap['center-of-mass'] => ({
    ...measureCenterOfMass(input.input),
    algorithmVersion: SPATIAL_ALGORITHM_VERSION,
  });

  return {
    list() {
      return BUILTIN_TOOLS;
    },
    async run<T extends AnalysisToolId>(tool: T, input: AnalysisInputMap[T], runOptions: AnalysisRunOptions = {}) {
      const signal = runOptions.signal;
      assertNotAborted(signal, tool);
      const result = await (async (): Promise<unknown> => {
        switch (tool) {
          case 'distance':
            return runDistance(input as AnalysisDistanceInput);
          case 'surface-distance':
            return runSurfaceDistance(input as AnalysisSurfaceDistanceInput, signal);
          case 'area':
            return runArea(input as AnalysisAreaInput);
          case 'bearing':
            return runBearing(input as AnalysisBearingInput);
          case 'terrain-sample':
            return runTerrainSample(input as AnalysisTerrainSampleInput, signal);
          case 'line-of-sight':
            return runLineOfSight(input as AnalysisLineOfSightInput, signal);
          case 'viewshed':
            return runViewshed(input as AnalysisViewshedInput, signal);
          case 'slope-aspect':
            return runSlopeAspect(input as AnalysisSlopeAspectInput, signal);
          case 'transform':
            return runTransform(input as AnalysisTransformInput);
          case 'point-in-polygon':
            return runPointInPolygon(input as AnalysisPointInPolygonInput);
          case 'points-in-polygon':
            return runPointsInPolygon(input as AnalysisPointsInPolygonInput);
          case 'bbox':
            return runBBox(input as AnalysisBBoxInput);
          case 'center-of-mass':
            return runCenterOfMass(input as AnalysisCenterOfMassInput);
          default:
            throw analysisError(
              `Unknown analysis tool: ${String(tool)}.`,
              'UNKNOWN_ANALYSIS_TOOL',
              'run',
            );
        }
      })();
      assertNotAborted(signal, tool);
      return result as AnalysisResultMap[T];
    },
  };

  /** 采样一批点；端口返回数量与请求不一致时按缺数据处理。 */
  async function sampleHeights(
    port: AnalysisTerrainPort,
    points: readonly TerrainSamplePoint[],
    signal: AbortSignal | undefined,
    sampleOptions: TerrainSampleOptions = {},
  ): Promise<readonly TerrainSample[]> {
    assertNotAborted(signal, 'terrain-sample');
    const samples = await (signal === undefined
      ? port.sample(points, sampleOptions)
      : port.sample(points, { ...sampleOptions, signal }));
    assertNotAborted(signal, 'terrain-sample');
    return samples;
  }
}
