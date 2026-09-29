import { GisError } from '../core/errors.js';

/** 三维向量；位置单位为米，速度单位为米/秒。 */
export interface Vector3 {
  /** X 分量。 */
  readonly x: number;
  /** Y 分量。 */
  readonly y: number;
  /** Z 分量。 */
  readonly z: number;
}

/** 惯性系下的位置与速度。 */
export interface OrbitState {
  /** 位置，单位为米。 */
  readonly position: Vector3;
  /** 速度，单位为米/秒。 */
  readonly velocity: Vector3;
}

/** 开普勒轨道六根数；角度单位为弧度，长度单位为米。 */
export interface OrbitalElements {
  /** 半长轴，单位为米。 */
  readonly semiMajorAxis: number;
  /** 偏心率。 */
  readonly eccentricity: number;
  /** 倾角，单位为弧度。 */
  readonly inclination: number;
  /** 升交点赤经，单位为弧度；赤道轨道为 0。 */
  readonly ascendingNode: number;
  /** 近地点幅角，单位为弧度；圆轨道为 0。 */
  readonly argumentOfPeriapsis: number;
  /** 真近点角，单位为弧度。 */
  readonly trueAnomaly: number;
  /** 轨道周期，单位为秒。 */
  readonly periodSeconds: number;
}

/** 地球引力常数（WGS84），单位为 m³/s²。 */
export const EARTH_MU = 3.986004418e14;

const EPSILON = 1e-12;

function invalidOrbit(message: string, operation: string, cause?: unknown): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'spatial',
    operation,
    ...(cause === undefined ? {} : { cause }),
  });
}

function finiteVector(value: unknown): value is Vector3 {
  const vector = value as Partial<Vector3> | undefined;
  return (
    !!vector && Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z)
  );
}

function magnitude(value: Vector3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function dot(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scale(value: Vector3, factor: number): Vector3 {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function trueToEccentric(value: number, eccentricity: number): number {
  return (
    2 *
    Math.atan2(
      Math.sqrt(1 - eccentricity) * Math.sin(value / 2),
      Math.sqrt(1 + eccentricity) * Math.cos(value / 2),
    )
  );
}

function eccentricToTrue(value: number, eccentricity: number): number {
  return (
    2 *
    Math.atan2(
      Math.sqrt(1 + eccentricity) * Math.sin(value / 2),
      Math.sqrt(1 - eccentricity) * Math.cos(value / 2),
    )
  );
}

/**
 * 解椭圆开普勒方程 `M = E − e·sinE`。
 *
 * 用二分而不是牛顿迭代：椭圆轨道上该函数单调，二分在高偏心率下不会发散。
 */
function solveKepler(meanAnomaly: number, eccentricity: number): number {
  const target = Math.atan2(Math.sin(meanAnomaly), Math.cos(meanAnomaly));
  let low = -Math.PI;
  let high = Math.PI;
  for (let index = 0; index < 60; index += 1) {
    const middle = (low + high) / 2;
    if (middle - eccentricity * Math.sin(middle) < target) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

/** 近焦点坐标 → 惯性系坐标（绕三个欧拉角旋转）。 */
function rotatePerifocal(value: Vector3, elements: OrbitalElements): Vector3 {
  const cosNode = Math.cos(elements.ascendingNode);
  const sinNode = Math.sin(elements.ascendingNode);
  const cosInclination = Math.cos(elements.inclination);
  const sinInclination = Math.sin(elements.inclination);
  const cosArgument = Math.cos(elements.argumentOfPeriapsis);
  const sinArgument = Math.sin(elements.argumentOfPeriapsis);
  return {
    x:
      (cosNode * cosArgument - sinNode * sinArgument * cosInclination) * value.x +
      (-cosNode * sinArgument - sinNode * cosArgument * cosInclination) * value.y,
    y:
      (sinNode * cosArgument + cosNode * sinArgument * cosInclination) * value.x +
      (-sinNode * sinArgument + cosNode * cosArgument * cosInclination) * value.y,
    z: sinArgument * sinInclination * value.x + cosArgument * sinInclination * value.y,
  };
}

/**
 * 从惯性系位置与速度求解开普勒轨道六根数。
 *
 * 角度单位为弧度、长度单位为米。圆轨道与赤道轨道这类退化情形不会产生 `NaN`：
 * 无定义的角（近地点幅角、升交点赤经）按 0 返回，与轨道力学教材的约定一致。
 *
 * @param state - 惯性系下的位置与速度。
 * @param mu - 引力常数，默认地球（`EARTH_MU`）。
 * @returns 六根数与轨道周期。
 * @throws `INVALID_SPATIAL_INPUT` 位置或速度无效、角动量退化，或为逃逸轨道（`e ≥ 1`）。
 */
export function calculateOrbitalElements(
  state: OrbitState | undefined,
  mu = EARTH_MU,
): OrbitalElements {
  const operation = 'calculateOrbitalElements';
  if (!Number.isFinite(mu) || mu <= 0) {
    throw invalidOrbit('Orbit mu must be a positive finite number.', operation);
  }
  const position = state?.position;
  const velocity = state?.velocity;
  if (!finiteVector(position) || !finiteVector(velocity)) {
    throw invalidOrbit('Orbit state must contain finite position and velocity vectors.', operation);
  }

  const r = magnitude(position);
  const v = magnitude(velocity);
  if (r <= 0) {
    throw invalidOrbit('Orbit position must not be the origin.', operation);
  }

  const angularMomentum = cross(position, velocity);
  const angularMomentumMagnitude = magnitude(angularMomentum);
  if (angularMomentumMagnitude <= EPSILON) {
    throw invalidOrbit('Orbit angular momentum is degenerate.', operation);
  }

  const node = cross({ x: 0, y: 0, z: 1 }, angularMomentum);
  const nodeMagnitude = magnitude(node);
  const eccentricityVector = subtract(
    scale(cross(velocity, angularMomentum), 1 / mu),
    scale(position, 1 / r),
  );
  const eccentricity = magnitude(eccentricityVector);

  const specificEnergy = (v * v) / 2 - mu / r;
  if (specificEnergy >= 0) {
    throw invalidOrbit(
      'Only elliptical orbits are supported (specific energy must be negative).',
      operation,
    );
  }

  const semiMajorAxis = -mu / (2 * specificEnergy);
  const inclination = Math.acos(clamp(angularMomentum.z / angularMomentumMagnitude, -1, 1));
  const equatorial = nodeMagnitude <= angularMomentumMagnitude * EPSILON;
  const circular = eccentricity <= EPSILON;
  const ascendingNode = equatorial ? 0 : Math.atan2(node.y, node.x);
  const angleBetween = (from: Vector3, to: Vector3): number =>
    Math.atan2(dot(cross(from, to), angularMomentum) / angularMomentumMagnitude, dot(from, to));
  const reference = equatorial ? { x: 1, y: 0, z: 0 } : node;
  const argumentOfPeriapsis = circular ? 0 : angleBetween(reference, eccentricityVector);
  const trueAnomaly = angleBetween(circular ? reference : eccentricityVector, position);

  return {
    semiMajorAxis,
    eccentricity,
    inclination,
    ascendingNode,
    argumentOfPeriapsis,
    trueAnomaly,
    periodSeconds: 2 * Math.PI * Math.sqrt(semiMajorAxis ** 3 / mu),
  };
}

/**
 * 用二体模型把椭圆轨道传播 `deltaSeconds` 秒。
 *
 * 适合回放补帧与短时间推演，**不替代高精度轨道力学库**：模型里没有 J2 摄动、
 * 大气阻力与三体效应，长时间传播会累积误差。
 *
 * @param state - 当前惯性系状态。
 * @param deltaSeconds - 传播时长，单位为秒；必须为有限数，可为负（向过去推算）。
 * @param mu - 引力常数，默认地球。
 * @returns 传播后的位置与速度。
 * @throws `INVALID_SPATIAL_INPUT` 时间增量无效，或当前状态不是椭圆轨道。
 */
export function propagateTwoBody(
  state: OrbitState,
  deltaSeconds: number,
  mu = EARTH_MU,
): OrbitState {
  const operation = 'propagateTwoBody';
  if (!Number.isFinite(deltaSeconds)) {
    throw invalidOrbit('Orbit propagation time must be a finite number of seconds.', operation);
  }
  const elements = calculateOrbitalElements(state, mu);
  const { eccentricity } = elements;
  const semiMajorAxis = elements.semiMajorAxis;
  const meanMotion = Math.sqrt(mu / semiMajorAxis ** 3);
  const eccentricAnomaly = trueToEccentric(elements.trueAnomaly, eccentricity);
  const meanAnomaly =
    eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) + meanMotion * deltaSeconds;
  const nextEccentric = solveKepler(meanAnomaly, eccentricity);
  const nextTrue = eccentricToTrue(nextEccentric, eccentricity);

  const radius = semiMajorAxis * (1 - eccentricity * Math.cos(nextEccentric));
  const parameter = semiMajorAxis * (1 - eccentricity * eccentricity);
  const positionPerifocal: Vector3 = {
    x: radius * Math.cos(nextTrue),
    y: radius * Math.sin(nextTrue),
    z: 0,
  };
  const velocityPerifocal: Vector3 = {
    x: -Math.sqrt(mu / parameter) * Math.sin(nextTrue),
    y: Math.sqrt(mu / parameter) * (eccentricity + Math.cos(nextTrue)),
    z: 0,
  };
  return {
    position: rotatePerifocal(positionPerifocal, elements),
    velocity: rotatePerifocal(velocityPerifocal, elements),
  };
}
