import type { GeoPosition } from '../core/controls.js';
import { GisError } from '../core/errors.js';
import type { OrbitalElements, Vector3 } from './orbit.js';
import { EARTH_MU } from './orbit.js';

/** 地球赤道半径（WGS84），单位为米。 */
export const EARTH_RADIUS = 6_378_137;

/** 默认采样点数；首尾重合，直接形成闭合轨道。 */
const DEFAULT_SAMPLES = 361;

/** 最少采样点数。 */
const MIN_SAMPLES = 36;

/** 可视化允许的最大偏心率；再大时近地点会落到地面以下。 */
const MAX_ECCENTRICITY = 0.99;

/** 生成轨道采样点所需的最小根数集合。 */
export interface OrbitElementsInput {
  /** 半长轴，单位为米。 */
  readonly semiMajorAxis: number;
  /** 偏心率。 */
  readonly eccentricity: number;
  /** 倾角，单位为弧度。 */
  readonly inclination: number;
  /** 升交点赤经，单位为弧度。 */
  readonly ascendingNode: number;
  /** 近地点幅角，单位为弧度。 */
  readonly argumentOfPeriapsis: number;
  /** 真近点角，单位为弧度。 */
  readonly trueAnomaly: number;
}

/** 轨道采样配置。 */
export interface OrbitSamplingOptions {
  /** 采样点数，默认 361，最少 36。 */
  readonly samples?: number;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function invalidOrbit(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'spatial',
    operation,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 归一化到 [0, 2π)，避免升交点赤经出现负值。 */
function normalizeRadians(radians: number): number {
  const full = 2 * Math.PI;
  return ((radians % full) + full) % full;
}

/** 归一化到 [-180, 180) 度。 */
function normalizeLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

/**
 * 校验轨道根数。
 *
 * 与 Plugin-web 的滑块场景不同，这里**不做静默收敛**：越界取值直接抛错，避免调用方
 * 拿到与输入不符的几何却毫无察觉。唯一的例外是圆轨道（`eccentricity === 0`）的
 * 近地点幅角被固定为 0——那是数学约定，不是收敛。
 */
function normalizeElements(
  elements: OrbitElementsInput | undefined,
  operation: string,
): Required<OrbitElementsInput> {
  if (!elements) {
    throw invalidOrbit('Orbit elements are required.', operation);
  }
  const raw = { ...elements };
  if (
    !finiteNumber(raw.semiMajorAxis) ||
    !finiteNumber(raw.eccentricity) ||
    !finiteNumber(raw.inclination) ||
    !finiteNumber(raw.ascendingNode) ||
    !finiteNumber(raw.argumentOfPeriapsis) ||
    !finiteNumber(raw.trueAnomaly)
  ) {
    throw invalidOrbit('Orbit elements must contain finite numbers.', operation);
  }
  if (raw.semiMajorAxis < EARTH_RADIUS) {
    throw invalidOrbit('Orbit semiMajorAxis must not be smaller than the Earth radius.', operation);
  }
  if (raw.eccentricity < 0 || raw.eccentricity > MAX_ECCENTRICITY) {
    throw invalidOrbit(
      `Orbit eccentricity must be between 0 and ${String(MAX_ECCENTRICITY)}.`,
      operation,
    );
  }
  return {
    semiMajorAxis: raw.semiMajorAxis,
    eccentricity: raw.eccentricity,
    inclination: raw.inclination,
    ascendingNode: raw.ascendingNode,
    // 圆轨道没有近地点，幅角固定为 0，避免出现无意义的朝向。
    argumentOfPeriapsis: raw.eccentricity === 0 ? 0 : raw.argumentOfPeriapsis,
    trueAnomaly: raw.trueAnomaly,
  };
}

/** 近焦点坐标 → 惯性系坐标。 */
function eciFromElements(
  radius: number,
  trueAnomaly: number,
  elements: Required<OrbitElementsInput>,
): Vector3 {
  const argument = elements.argumentOfPeriapsis + trueAnomaly;
  const cosNode = Math.cos(elements.ascendingNode);
  const sinNode = Math.sin(elements.ascendingNode);
  const cosInclination = Math.cos(elements.inclination);
  const sinInclination = Math.sin(elements.inclination);
  const cosArgument = Math.cos(argument);
  const sinArgument = Math.sin(argument);
  return {
    x: radius * (cosNode * cosArgument - sinNode * sinArgument * cosInclination),
    y: radius * (sinNode * cosArgument + cosNode * sinArgument * cosInclination),
    z: radius * sinArgument * sinInclination,
  };
}

/**
 * 由地表锚点推导一条**过该点的标准圆轨道**的根数。
 *
 * 用途是交互：用户在地图上点一个位置，就得到一条穿过该点、倾角与该点纬度相适应的
 * 圆轨道。返回的角度单位为**弧度**，与 `calculateOrbitalElements` 一致。
 *
 * @param longitude - 锚点经度，单位为度。
 * @param latitude - 锚点纬度，单位为度。
 * @param altitude - 轨道高度，单位为米；必须为非负有限数。
 * @returns 圆轨道根数，含周期。
 * @throws `INVALID_SPATIAL_INPUT` 参数非有限数、锚点超出经纬范围，或高度为负。
 */
export function orbitalElementsFromAnchor(
  longitude: number,
  latitude: number,
  altitude: number,
): OrbitalElements {
  const operation = 'orbitalElementsFromAnchor';
  if (!finiteNumber(longitude) || !finiteNumber(latitude) || !finiteNumber(altitude)) {
    throw invalidOrbit('Anchor longitude, latitude, and altitude must be finite.', operation);
  }

  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw invalidOrbit('Anchor must be inside the WGS84 degree range.', operation);
  }
  if (altitude < 0) {
    throw invalidOrbit('Anchor altitude must be non-negative.', operation);
  }

  const lon = (longitude * Math.PI) / 180;
  const lat = (latitude * Math.PI) / 180;
  const cosLatitude = Math.cos(lat);
  const radial: Vector3 = {
    x: cosLatitude * Math.cos(lon),
    y: cosLatitude * Math.sin(lon),
    z: Math.sin(lat),
  };
  const east: Vector3 = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
  // 轨道面法向：锚点径向与当地东向的叉积，保证轨道面同时包含锚点与当地东向。
  const normal: Vector3 = {
    x: radial.y * east.z - radial.z * east.y,
    y: radial.z * east.x - radial.x * east.z,
    z: radial.x * east.y - radial.y * east.x,
  };
  const inclination = Math.acos(clamp(normal.z, -1, 1));
  const nodeX = -normal.y;
  const nodeY = normal.x;
  const nodeMagnitude = Math.hypot(nodeX, nodeY);
  const ascendingNode = nodeMagnitude > 1e-10 ? Math.atan2(nodeY, nodeX) : 0;
  const node: Vector3 =
    nodeMagnitude > 1e-10 ? { x: nodeX / nodeMagnitude, y: nodeY / nodeMagnitude, z: 0 } : radial;
  // 圆轨道的真近点角 = 从升节点到锚点的夹角。
  const trueAnomaly = Math.atan2(
    normal.x * (node.y * radial.z - node.z * radial.y) +
      normal.y * (node.z * radial.x - node.x * radial.z) +
      normal.z * (node.x * radial.y - node.y * radial.x),
    node.x * radial.x + node.y * radial.y + node.z * radial.z,
  );

  const semiMajorAxis = EARTH_RADIUS + altitude;
  return {
    semiMajorAxis,
    eccentricity: 0,
    inclination,
    ascendingNode: nodeMagnitude > 1e-10 ? normalizeRadians(ascendingNode) : 0,
    argumentOfPeriapsis: 0,
    trueAnomaly,
    periodSeconds: 2 * Math.PI * Math.sqrt(semiMajorAxis ** 3 / EARTH_MU),
  };
}

/**
 * 由轨道根数生成可渲染的采样点。
 *
 * 采样点直接使用椭球高与 WGS84 经纬度，可以直接交给折线图层渲染。
 *
 * **坐标简化**：这里把惯性系方向直接当作地固系方向，没有做 ECI→ECEF 的岁差与自转
 * 转换。对"看轨道形状与倾角"的可视化足够，但**不能**用来判断某时刻卫星在哪个城市上方；
 * 需要真实星下点时请用服务端星历或专业库转换，再交给 `map.coordinates`。
 *
 * @param elements - 轨道根数；半长轴不得小于地球半径、偏心率在 0 到 0.99 之间。
 * @param options - 采样点数，默认 361（首尾重合），最少 36。
 * @returns 采样点序列；最后一个点与第一个点重合，形成闭合轨道。
 * @throws `INVALID_SPATIAL_INPUT` 根数缺失、含非有限值或超出渲染范围。
 */
export function sampleOrbitPositions(
  elements: OrbitElementsInput,
  options: OrbitSamplingOptions = {},
): readonly GeoPosition[] {
  const operation = 'sampleOrbitPositions';
  const normalized = normalizeElements(elements, operation);
  const samples = options.samples ?? DEFAULT_SAMPLES;
  if (!Number.isSafeInteger(samples) || samples < MIN_SAMPLES) {
    throw invalidOrbit(
      `Orbit samples must be an integer of at least ${String(MIN_SAMPLES)}.`,
      operation,
    );
  }

  const parameter = normalized.semiMajorAxis * (1 - normalized.eccentricity ** 2);
  const positions: GeoPosition[] = [];
  for (let index = 0; index < samples; index += 1) {
    const anomaly = normalized.trueAnomaly + (index / (samples - 1)) * Math.PI * 2;
    const radius = parameter / (1 + normalized.eccentricity * Math.cos(anomaly));
    const point = eciFromElements(radius, anomaly, normalized);
    positions.push({
      longitude: normalizeLongitude((Math.atan2(point.y, point.x) * 180) / Math.PI),
      latitude: (Math.asin(clamp(point.z / radius, -1, 1)) * 180) / Math.PI,
      height: radius - EARTH_RADIUS,
    });
  }
  return positions;
}
