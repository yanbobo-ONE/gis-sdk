import { GisError } from '../core/errors.js';
import { EARTH_RADIUS } from './orbit-geometry.js';

/**
 * 地形剖面点。
 *
 * 一条线（通视的视线、视域的射线、坡度的邻域）上某点到起点/观察点的距离与地面椭球高。
 */
export interface TerrainProfilePoint {
  /** 与起点或观察点的球面距离，单位为米。 */
  readonly distanceMeters: number;
  /** 地面椭球高，单位为米。 */
  readonly heightMeters: number;
}

/** 通视判定输入。 */
export interface LineOfSightInput {
  /** 观察点高度（椭球高，米）。 */
  readonly fromHeightMeters: number;
  /** 目标点高度（椭球高，米）。 */
  readonly toHeightMeters: number;
  /** 两点之间的球面距离，单位为米。 */
  readonly distanceMeters: number;
  /** 沿线地形剖面；不含两端点，按距离升序，距离介于 0 与 `distanceMeters` 之间。 */
  readonly profile: readonly TerrainProfilePoint[];
  /** 是否计入地球曲率下沉，默认 `false`（近视距、快速判断的口径）。 */
  readonly applyEarthCurvature?: boolean;
  /** 余隙容差（米），默认 0：余隙不小于负容差即视为可见，用于吸收采样误差。 */
  readonly clearanceToleranceMeters?: number;
}

/** 通视判定结果。 */
export interface LineOfSightEvaluation {
  /** 两点之间是否可见。 */
  readonly visible: boolean;
  /** 视线到地形的最小余隙，单位为米；为负表示被地形遮挡。 */
  readonly minClearanceMeters: number;
  /** 首个遮挡点的剖面向量下标；可见时为 `undefined`。 */
  readonly blockedAtIndex: number | undefined;
  /** 参与判定的剖面点数。
   *
   * 缺地形数据的采样点**不参与**判定，因此这个数字可能小于请求的采样数。
   */
  readonly sampleCount: number;
}

/** 地平线（沿一条剖面能看多远）判定输入。 */
export interface HorizonInput {
  /** 观察点高度（椭球高，米）。 */
  readonly observerHeightMeters: number;
  /** 从近到远排列的地形剖面；距离必须为正且严格递增。 */
  readonly profile: readonly TerrainProfilePoint[];
  /** 是否计入地球曲率下沉，默认 `false`。 */
  readonly applyEarthCurvature?: boolean;
}

/** 地平线判定结果。 */
export interface HorizonEvaluation {
  /** 最后一个可见点的距离，单位为米；没有可见点时与 `blockedDistanceMeters` 相同或为 0。 */
  readonly visibleDistanceMeters: number;
  /** 第一个被地形遮挡的距离，单位为米；整条剖面都可见时为 `undefined`。 */
  readonly blockedDistanceMeters: number | undefined;
}

/** 平面拟合点：以中心点为原点的东向/北向偏移与高度。 */
export interface PlanePoint {
  /** 相对中心点的东向偏移，单位为米（东为正）。 */
  readonly eastMeters: number;
  /** 相对中心点的北向偏移，单位为米（北为正）。 */
  readonly northMeters: number;
  /** 该点的椭球高，单位为米。 */
  readonly heightMeters: number;
}

/** 坡度坡向结果。 */
export interface SlopeAspect {
  /** 坡度，单位为度；`0` 表示平地，`90` 表示垂直。 */
  readonly slopeDegrees: number;
  /** 坡向，单位为度；正北为 0，顺时针为正，指向**下坡**方向。 */
  readonly aspectDegrees: number;
}

/** 平面拟合所需的最少点数（三点确定一个平面）。 */
export const MIN_PLANE_POINTS = 3;

function profileError(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'spatial',
    operation,
  });
}

function assertFinite(value: number, name: string, operation: string): void {
  if (!Number.isFinite(value)) {
    throw profileError(`${name} must be a finite number.`, operation);
  }
}

/**
 * 计算地球曲率造成的地面下沉量。
 *
 * 平地近似 `d² / 2R`，用平均地球半径；几公里范围内误差远小于地形本身的起伏。
 *
 * @param distanceMeters - 水平距离，单位为米。
 * @returns 下沉量，单位为米；观察者与目标之间的地面相对直线会低这么多。
 */
export function curvatureDropMeters(distanceMeters: number): number {
  const distance = Math.max(0, distanceMeters);
  return (distance * distance) / (2 * EARTH_RADIUS);
}

/**
 * 判定两点之间是否通视。
 *
 * 判定口径是"直线视线与沿线地形的最小余隙"：在剖面每个采样点上比较直线高度与地面高度，
 * 最小余隙为负即被遮挡。曲线地球的近似由 `applyEarthCurvature` 控制，默认关闭——近视距下
 * 曲率下沉远小于地形起伏，关闭能让结果更容易与人工核对。
 *
 * @param input - 端点高度、距离与沿线剖面。
 * @returns 可见性与最小余隙。
 * @throws `INVALID_SPATIAL_INPUT` 距离或高度非法。
 */
export function evaluateLineOfSight(input: LineOfSightInput): LineOfSightEvaluation {
  const operation = 'evaluateLineOfSight';
  assertFinite(input.distanceMeters, 'distanceMeters', operation);
  assertFinite(input.fromHeightMeters, 'fromHeightMeters', operation);
  assertFinite(input.toHeightMeters, 'toHeightMeters', operation);
  if (input.distanceMeters <= 0) {
    // 同一点：视线长度为零，只看端点本身。
    const clearance = input.toHeightMeters - input.fromHeightMeters;
    return {
      visible: clearance >= 0,
      minClearanceMeters: clearance,
      blockedAtIndex: clearance >= 0 ? undefined : 0,
      sampleCount: 0,
    };
  }
  const curvature = input.applyEarthCurvature === true;
  const tolerance = input.clearanceToleranceMeters ?? 0;
  assertFinite(tolerance, 'clearanceToleranceMeters', operation);

  let minClearance = Number.POSITIVE_INFINITY;
  let blockedAtIndex: number | undefined;
  let used = 0;
  input.profile.forEach((point, index) => {
    if (!Number.isFinite(point.distanceMeters) || !Number.isFinite(point.heightMeters)) {
      // 没有地形数据的采样点不参与判定，也不冒充 0 高。
      return;
    }
    used += 1;
    const ratio = point.distanceMeters / input.distanceMeters;
    const lineHeight =
      input.fromHeightMeters + (input.toHeightMeters - input.fromHeightMeters) * ratio;
    const ground = point.heightMeters - (curvature ? curvatureDropMeters(point.distanceMeters) : 0);
    const clearance = lineHeight - ground;
    if (clearance < minClearance) {
      minClearance = clearance;
    }
    if (clearance < -tolerance && blockedAtIndex === undefined) {
      blockedAtIndex = index;
    }
  });

  if (used === 0) {
    // 剖面为空（例如只判断端点高度）时只比较两端高度，不做任何地形假设。
    const clearance = input.toHeightMeters - input.fromHeightMeters;
    return {
      visible: clearance >= -tolerance,
      minClearanceMeters: clearance,
      blockedAtIndex: clearance >= -tolerance ? undefined : 0,
      sampleCount: 0,
    };
  }

  return {
    visible: blockedAtIndex === undefined,
    minClearanceMeters: minClearance,
    blockedAtIndex,
    sampleCount: used,
  };
}

/**
 * 沿一条剖面计算"能看多远"。
 *
 * 用视线仰角的滑动最大值做包络：某点的仰角高于此前所有点，说明它在地平线之上、可见；
 * 否则它落在已形成的地平线之后、被遮挡。这是地形通视的通用判据，比"比上一点高"稳健——
 * 它不会被中间的小起伏骗过。
 *
 * @param input - 观察点高度与从近到远的剖面。
 * @returns 可见距离与首个遮挡距离。
 * @throws `INVALID_SPATIAL_INPUT` 距离非正或非递增。
 */
export function evaluateHorizon(input: HorizonInput): HorizonEvaluation {
  const operation = 'evaluateHorizon';
  assertFinite(input.observerHeightMeters, 'observerHeightMeters', operation);
  const curvature = input.applyEarthCurvature === true;

  let horizonAngle = Number.NEGATIVE_INFINITY;
  let visibleDistance = 0;
  let blockedDistance: number | undefined;
  let previousDistance = 0;
  for (const point of input.profile) {
    if (!Number.isFinite(point.distanceMeters) || !Number.isFinite(point.heightMeters)) {
      continue;
    }
    if (point.distanceMeters <= previousDistance) {
      throw profileError('Horizon profile distances must be positive and increasing.', operation);
    }
    previousDistance = point.distanceMeters;
    const ground = point.heightMeters - (curvature ? curvatureDropMeters(point.distanceMeters) : 0);
    const angle = (ground - input.observerHeightMeters) / point.distanceMeters;
    if (angle >= horizonAngle) {
      horizonAngle = angle;
      visibleDistance = point.distanceMeters;
      continue;
    }
    blockedDistance ??= point.distanceMeters;
  }
  return { visibleDistanceMeters: visibleDistance, blockedDistanceMeters: blockedDistance };
}

/**
 * 由邻域点拟合平面并给出坡度与坡向。
 *
 * 用最小二乘拟合 `h = a·e + b·n + c`：坡度是梯度模长的反正切，坡向指向下坡方向
 * （正北为 0、顺时针为正）。平地（梯度趋近 0）的坡向没有意义，约定返回 0。
 *
 * @param points - 至少三个不共线的点，坐标是相对中心点的东向/北向偏移（米）。
 * @returns 坡度与坡向，单位为度。
 * @throws `INVALID_SPATIAL_INPUT` 点数不足或点共线。
 */
export function slopeAspectFromPlane(points: readonly PlanePoint[]): SlopeAspect {
  const operation = 'slopeAspectFromPlane';
  if (points.length < MIN_PLANE_POINTS) {
    throw profileError(
      `At least ${String(MIN_PLANE_POINTS)} points are required to fit a plane.`,
      operation,
    );
  }
  let see = 0;
  let snn = 0;
  let sen = 0;
  let se = 0;
  let sn = 0;
  let sh = 0;
  let seh = 0;
  let snh = 0;
  for (const point of points) {
    assertFinite(point.eastMeters, 'eastMeters', operation);
    assertFinite(point.northMeters, 'northMeters', operation);
    assertFinite(point.heightMeters, 'heightMeters', operation);
    const { eastMeters: east, northMeters: north, heightMeters: h } = point;
    see += east * east;
    snn += north * north;
    sen += east * north;
    se += east;
    sn += north;
    sh += h;
    seh += east * h;
    snh += north * h;
  }
  const count = points.length;
  // 3×3 正规方程：[[see, sen, se], [sen, snn, sn], [se, sn, count]] · [a, b, c]ᵀ = [seh, snh, sh]ᵀ
  const determinant =
    see * (snn * count - sn * sn) -
    sen * (sen * count - sn * se) +
    se * (sen * sn - snn * se);
  if (Math.abs(determinant) < 1e-9) {
    throw profileError('Plane fit points are collinear or coincident.', operation);
  }
  const a =
    (seh * (snn * count - sn * sn) -
      sen * (snh * count - sn * sh) +
      se * (snh * sn - snn * sh)) /
    determinant;
  const b =
    (see * (snh * count - sn * sh) -
      seh * (sen * count - sn * se) +
      se * (sen * sh - snh * se)) /
    determinant;
  const gradient = Math.hypot(a, b);
  // 平面拟合的截断误差会给出 1e-16 量级的"坡度"，这在物理上没有意义，按平地返回。
  if (gradient < 1e-9) {
    return { slopeDegrees: 0, aspectDegrees: 0 };
  }
  return {
    slopeDegrees: (Math.atan(gradient) * 180) / Math.PI,
    aspectDegrees: normalizeBearing((Math.atan2(-a, -b) * 180) / Math.PI),
  };
}

/** 把方位角归一化到 [0, 360)。 */
export function normalizeBearing(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * 按地表折线累加三维长度。
 *
 * 每个采样点用椭球高（缺数据时按 0 参与，调用方负责决定是否采用结果），相邻两点的水平距离由
 * 输入给出，竖直差取自两个采样点的高度；结果是分段弦长之和，采样越密越接近真实地表距离。
 *
 * @param segments - 相邻两点的水平距离与两端高度。
 * @returns 三维长度，单位为米。
 * @throws `INVALID_SPATIAL_INPUT` 出现负数或非有限值。
 */
export function surfacePathLength(
  segments: readonly {
    readonly horizontalDistanceMeters: number;
    readonly fromHeightMeters: number;
    readonly toHeightMeters: number;
  }[],
): number {
  const operation = 'surfacePathLength';
  let total = 0;
  for (const segment of segments) {
    assertFinite(segment.horizontalDistanceMeters, 'horizontalDistanceMeters', operation);
    assertFinite(segment.fromHeightMeters, 'fromHeightMeters', operation);
    assertFinite(segment.toHeightMeters, 'toHeightMeters', operation);
    if (segment.horizontalDistanceMeters < 0) {
      throw profileError('horizontalDistanceMeters must not be negative.', operation);
    }
    const rise = segment.toHeightMeters - segment.fromHeightMeters;
    total += Math.hypot(segment.horizontalDistanceMeters, rise);
  }
  return total;
}
