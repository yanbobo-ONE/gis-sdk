import { GisError } from './errors.js';
import { createSeededRandom } from './lightning.js';
import type { GeoBBox, GeoPoint } from '../spatial/types.js';

/** 与 `clusterPoints()` / 热力图一致的米/度换算基准：球面平均半径。 */
const METERS_PER_DEGREE_LATITUDE = (2 * Math.PI * 6_371_008.8) / 360;

/** 默认粒子数、生命时长与种子。 */
const DEFAULT_PARTICLE_COUNT = 2_000;
const DEFAULT_LIFETIME_SECONDS = 12;
const DEFAULT_SEED = 1;

/** 粒子数上限：每颗粒子每帧都要更新一条折线，留出余量避免误配。 */
export const MAX_WIND_PARTICLES = 20_000;

function invalidWind(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'wind',
    operation,
  });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function metersPerDegreeLongitude(latitude: number): number {
  return METERS_PER_DEGREE_LATITUDE * Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
}

/** 等间距网格的一个轴。 */
export interface WindFieldAxis {
  /** 起点（经度 / 纬度 / 高度，按轴的含义）。 */
  readonly start: number;
  /** 步长，必须为正。 */
  readonly step: number;
  /** 采样点数量，至少 2。 */
  readonly count: number;
}

/** 风场网格的三个轴；索引顺序与参照实现一致：`(z * lat.count + y) * lon.count + x`。 */
export interface WindFieldAxes {
  /** 经度轴，单位为度。 */
  readonly lon: WindFieldAxis;
  /** 纬度轴，单位为度。 */
  readonly lat: WindFieldAxis;
  /** 高度轴，单位为米。 */
  readonly height: WindFieldAxis;
}

/**
 * 业务提供的风场数据。
 *
 * 三个分量按同一套轴铺平：`u` 向东、`v` 向北、`w` 向上（米/秒），长度都必须等于
 * `lon.count × lat.count × height.count`；`w` 省略表示只做水平风。
 */
export interface WindFieldInput {
  /** 三个轴的起点 / 步长 / 采样点数。 */
  readonly axes: WindFieldAxes;
  /** 向东分量（米/秒），长度等于网格点数。 */
  readonly u: ArrayLike<number>;
  /** 向北分量（米/秒），长度等于网格点数。 */
  readonly v: ArrayLike<number>;
  /** 向上分量（米/秒），长度等于网格点数；省略表示只做水平风。 */
  readonly w?: ArrayLike<number>;
}

/** 校验通过的风场。 */
export interface WindField {
  /** 与入参相同的三个轴（已冻结）。 */
  readonly axes: WindFieldAxes;
  /** 向东分量（米/秒）。 */
  readonly u: ArrayLike<number>;
  /** 向北分量（米/秒）。 */
  readonly v: ArrayLike<number>;
  /** 向上分量（米/秒）；入参未提供时为 `undefined`。 */
  readonly w: ArrayLike<number> | undefined;
  /** 网格点总数。 */
  readonly count: number;
  /** 网格里的最大风速（米/秒），用于分档与读数。 */
  readonly maxSpeed: number;
}

/** 单点风矢量。 */
export interface WindSample {
  /** 向东分量，米/秒。 */
  readonly east: number;
  /** 向北分量，米/秒。 */
  readonly north: number;
  /** 向上分量，米/秒。 */
  readonly up: number;
  /** 风速，米/秒。 */
  readonly speed: number;
}

function validateAxis(axis: unknown, label: string, operation: string): WindFieldAxis {
  const candidate = axis as
    { readonly start?: unknown; readonly step?: unknown; readonly count?: unknown } | undefined;
  if (!candidate || !finiteNumber(candidate.start)) {
    throw invalidWind(`Wind field ${label} axis needs a finite start.`, operation);
  }
  if (!finiteNumber(candidate.step) || candidate.step <= 0) {
    throw invalidWind(`Wind field ${label} axis needs a positive step.`, operation);
  }
  const count = candidate.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 2) {
    throw invalidWind(`Wind field ${label} axis needs at least two samples.`, operation);
  }
  return { start: candidate.start, step: candidate.step, count };
}

/**
 * 校验并冻结业务提供的风场数据。
 *
 * 只做"能不能用"的检查（轴合法、三个分量长度与网格一致、数值有限），不做插值或重采样；
 * 时序多切片、坐标系换算与缺测填补都留在业务侧。
 *
 * @throws `INVALID_SPATIAL_INPUT` 轴非法、分量长度不符或含非有限数。
 */
export function buildWindField(input: WindFieldInput): WindField {
  const requested = (input as WindFieldInput | undefined) ?? ({} as WindFieldInput);
  const axes = requested.axes as WindFieldAxes | undefined;
  if (!axes) {
    throw invalidWind('Wind field needs axes for lon, lat, and height.', 'buildWindField');
  }
  const lon = validateAxis(axes.lon, 'lon', 'buildWindField');
  const lat = validateAxis(axes.lat, 'lat', 'buildWindField');
  const height = validateAxis(axes.height, 'height', 'buildWindField');
  const count = lon.count * lat.count * height.count;

  const validateComponent = (component: unknown, label: string): ArrayLike<number> => {
    if (!component || typeof (component as { length?: unknown }).length !== 'number') {
      throw invalidWind(`Wind field ${label} must be an array-like of numbers.`, 'buildWindField');
    }
    const values = component as ArrayLike<number>;
    if (values.length !== count) {
      throw invalidWind(
        `Wind field ${label} length ${String(values.length)} does not match the grid (${String(count)}).`,
        'buildWindField',
      );
    }
    return values;
  };
  const u = validateComponent(requested.u, 'u');
  const v = validateComponent(requested.v, 'v');
  const w = requested.w === undefined ? undefined : validateComponent(requested.w, 'w');

  let maxSpeed = 0;
  for (let index = 0; index < count; index += 1) {
    const east = u[index] ?? 0;
    const north = v[index] ?? 0;
    const up = w?.[index] ?? 0;
    if (!finiteNumber(east) || !finiteNumber(north) || !finiteNumber(up)) {
      throw invalidWind(
        `Wind field has a non-finite value at index ${String(index)}.`,
        'buildWindField',
      );
    }
    maxSpeed = Math.max(maxSpeed, Math.hypot(east, north, up));
  }

  return Object.freeze({
    axes: Object.freeze({ lon, lat, height }),
    u,
    v,
    w,
    count,
    maxSpeed,
  });
}

/** 风场覆盖的经纬范围（不考虑高度轴）。 */
export function windFieldBounds(field: WindField): GeoBBox {
  const { lon, lat } = field.axes;
  return Object.freeze({
    west: lon.start,
    east: lon.start + lon.step * (lon.count - 1),
    south: lat.start,
    north: lat.start + lat.step * (lat.count - 1),
  });
}

interface AxisPosition {
  readonly index: number;
  readonly ratio: number;
}

/** 把轴上的取值换算成"下标 + 比例"；超出范围返回 `undefined`。 */
function locate(axis: WindFieldAxis, value: number): AxisPosition | undefined {
  const raw = (value - axis.start) / axis.step;
  if (raw < 0 || raw > axis.count - 1) {
    return undefined;
  }
  const index = Math.min(Math.floor(raw), axis.count - 2);
  return { index, ratio: raw - index };
}

/**
 * 按三线性插值采样风矢量。
 *
 * 超出网格范围（经度、纬度或高度任一维）返回 `undefined`，不做外推——调用方据此重掷粒子，
 * 而不是拿边缘值硬撑出一个"看起来还在吹"的假象。
 *
 * @throws `INVALID_SPATIAL_INPUT` 位置不是有限经纬度。
 */
export function sampleWind(field: WindField, position: GeoPoint): WindSample | undefined {
  const candidate = position as
    | { readonly longitude?: unknown; readonly latitude?: unknown; readonly height?: unknown }
    | undefined;
  if (!candidate || !finiteNumber(candidate.longitude) || !finiteNumber(candidate.latitude)) {
    throw invalidWind('Wind sample needs finite longitude and latitude.', 'sampleWind');
  }
  const height = finiteNumber(candidate.height) ? candidate.height : 0;

  const x = locate(field.axes.lon, candidate.longitude);
  const y = locate(field.axes.lat, candidate.latitude);
  const z = locate(field.axes.height, height);
  if (!x || !y || !z) {
    return undefined;
  }

  const { lon, lat } = field.axes;
  const strideLat = lon.count;
  const strideZ = lon.count * lat.count;
  const components: [number, number, number] = [0, 0, 0];
  const sources = [field.u, field.v, field.w] as const;

  for (let component = 0; component < 3; component += 1) {
    const source = sources[component];
    if (!source) {
      continue;
    }
    const x0 = x.index;
    const y0 = y.index;
    const z0 = z.index;
    const at = (xi: number, yi: number, zi: number): number =>
      source[zi * strideZ + yi * strideLat + xi] ?? 0;
    const c00 = at(x0, y0, z0) * (1 - x.ratio) + at(x0 + 1, y0, z0) * x.ratio;
    const c10 = at(x0, y0 + 1, z0) * (1 - x.ratio) + at(x0 + 1, y0 + 1, z0) * x.ratio;
    const c01 = at(x0, y0, z0 + 1) * (1 - x.ratio) + at(x0 + 1, y0, z0 + 1) * x.ratio;
    const c11 = at(x0, y0 + 1, z0 + 1) * (1 - x.ratio) + at(x0 + 1, y0 + 1, z0 + 1) * x.ratio;
    const c0 = c00 * (1 - y.ratio) + c10 * y.ratio;
    const c1 = c01 * (1 - y.ratio) + c11 * y.ratio;
    components[component] = c0 * (1 - z.ratio) + c1 * z.ratio;
  }
  const [east, north, up] = components;
  return { east, north, up, speed: Math.hypot(east, north, up) };
}

/** 一颗粒子：经纬高加已经存活的时间。 */
export interface WindParticle {
  /** 经度，单位为度。 */
  readonly longitude: number;
  /** 纬度，单位为度。 */
  readonly latitude: number;
  /** 相对椭球的高度，单位为米。 */
  readonly height: number;
  /** 已存活秒数；超过生命时长会被重掷。 */
  readonly ageSeconds: number;
}

/** 粒子初始化参数。 */
export interface WindParticleOptions {
  /** 粒子数量，默认 2000，上限 20000。 */
  readonly count?: number;
  /** 随机种子，默认 1；同种子得到同一批初始位置。 */
  readonly seed?: number;
  /** 粒子所在高度，单位为米；省略时取高度轴中点。 */
  readonly heightMeters?: number;
  /** 生命时长，单位为秒，默认 12。 */
  readonly lifetimeSeconds?: number;
  /** 初始播撒范围；省略时用整个网格范围。 */
  readonly bounds?: GeoBBox;
}

/** 平流参数。 */
export interface WindAdvectOptions {
  /** 经过的秒数，必须为正有限数。 */
  readonly deltaSeconds: number;
  /** 速度缩放，默认 1；大于 1 让粒子跑得更快，便于观察。 */
  readonly speedScale?: number;
  /** 生命时长，默认 12；超过则重掷。 */
  readonly lifetimeSeconds?: number;
  /** 重掷用的随机种子，默认 1；同一状态与种子得到同一批重掷位置。 */
  readonly seed?: number;
  /** 粒子高度，单位为米；省略时沿用粒子自身高度。 */
  readonly heightMeters?: number;
}

function normalizeCount(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_PARTICLE_COUNT;
  }
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_WIND_PARTICLES
  ) {
    throw invalidWind(
      `Wind particles must be an integer between 1 and ${String(MAX_WIND_PARTICLES)}.`,
      'createWindParticles',
    );
  }
  return value as number;
}

function normalizeLifetime(value: unknown, operation: string): number {
  if (value === undefined) {
    return DEFAULT_LIFETIME_SECONDS;
  }
  if (!finiteNumber(value) || value <= 0) {
    throw invalidWind('Wind lifetimeSeconds must be a positive finite number.', operation);
  }
  return value;
}

function resolveBounds(field: WindField, bounds: GeoBBox | undefined): GeoBBox {
  if (bounds === undefined) {
    return windFieldBounds(field);
  }
  const { west, south, east, north } = bounds;
  if (
    !finiteNumber(west) ||
    !finiteNumber(east) ||
    !finiteNumber(south) ||
    !finiteNumber(north) ||
    west >= east ||
    south >= north
  ) {
    throw invalidWind('Wind bounds must be valid WGS84 degree bounds.', 'createWindParticles');
  }
  return bounds;
}

function resolveHeight(field: WindField, heightMeters: number | undefined): number {
  if (heightMeters === undefined) {
    const { start, step, count } = field.axes.height;
    return start + (step * (count - 1)) / 2;
  }
  if (!finiteNumber(heightMeters)) {
    throw invalidWind('Wind heightMeters must be a finite number.', 'createWindParticles');
  }
  return heightMeters;
}

/**
 * 播撒粒子：在范围内均匀取经纬度，高度默认取高度轴中点。
 *
 * 同一种子得到同一批位置，便于复现与单测；`advectWindParticles()` 的重掷也走同一条随机序列。
 */
export function createWindParticles(
  field: WindField,
  options: WindParticleOptions = {},
): readonly WindParticle[] {
  const requested = (options as WindParticleOptions | undefined) ?? {};
  const count = normalizeCount(requested.count);
  const lifetimeSeconds = normalizeLifetime(requested.lifetimeSeconds, 'createWindParticles');
  const seed = requested.seed ?? DEFAULT_SEED;
  if (!finiteNumber(seed)) {
    throw invalidWind('Wind seed must be a finite number.', 'createWindParticles');
  }
  const bounds = resolveBounds(field, requested.bounds);
  const height = resolveHeight(field, requested.heightMeters);
  const random = createSeededRandom(seed);

  const particles: WindParticle[] = [];
  for (let index = 0; index < count; index += 1) {
    particles.push({
      longitude: bounds.west + random() * (bounds.east - bounds.west),
      latitude: bounds.south + random() * (bounds.north - bounds.south),
      height,
      // 初始化时年龄在生命时长内均匀分布：粒子不会同时消失又同时出现。
      ageSeconds: random() * lifetimeSeconds,
    });
  }
  return Object.freeze(particles);
}

/**
 * 推进一步平流：按当前位置采样风场，用一阶欧拉法移动，年龄超限或跑出网格的粒子重掷。
 *
 * 返回新的粒子数组（不修改入参）。同一状态 + 同一 `seed` 得到同一结果，因此测试与实际
 * 使用一致；想要每帧重掷位置不同，业务传入变化的 `seed`（例如帧序号）。
 *
 * @throws `INVALID_SPATIAL_INPUT` `deltaSeconds` 非正、`speedScale` 非法或粒子数组非法。
 */
export function advectWindParticles(
  field: WindField,
  particles: readonly WindParticle[],
  options: WindAdvectOptions,
): readonly WindParticle[] {
  const requested = (options as WindAdvectOptions | undefined) ?? ({} as WindAdvectOptions);
  const deltaSeconds = requested.deltaSeconds;
  if (!finiteNumber(deltaSeconds) || deltaSeconds <= 0) {
    throw invalidWind('Wind deltaSeconds must be a positive finite number.', 'advectWindParticles');
  }
  const speedScale = requested.speedScale ?? 1;
  if (!finiteNumber(speedScale) || speedScale <= 0) {
    throw invalidWind('Wind speedScale must be a positive finite number.', 'advectWindParticles');
  }
  const lifetimeSeconds = normalizeLifetime(requested.lifetimeSeconds, 'advectWindParticles');
  // Array.isArray 会把 readonly 数组收窄成 any[]，因此先按 unknown 校验再断言。
  const rawParticles: unknown = particles;
  if (!Array.isArray(rawParticles)) {
    throw invalidWind('Wind particles must be an array.', 'advectWindParticles');
  }
  const list = rawParticles as readonly WindParticle[];
  const seed = requested.seed ?? DEFAULT_SEED;
  if (!finiteNumber(seed)) {
    throw invalidWind('Wind seed must be a finite number.', 'advectWindParticles');
  }
  const bounds = resolveBounds(field, undefined);
  const fallbackHeight = resolveHeight(field, requested.heightMeters);
  const random = createSeededRandom(seed);

  const respawn = (): WindParticle => ({
    longitude: bounds.west + random() * (bounds.east - bounds.west),
    latitude: bounds.south + random() * (bounds.north - bounds.south),
    height: fallbackHeight,
    ageSeconds: 0,
  });

  const next: WindParticle[] = [];
  for (const candidate of list) {
    const particle = candidate as
      | {
          readonly longitude?: unknown;
          readonly latitude?: unknown;
          readonly height?: unknown;
          readonly ageSeconds?: unknown;
        }
      | undefined;
    if (
      !particle ||
      !finiteNumber(particle.longitude) ||
      !finiteNumber(particle.latitude) ||
      !finiteNumber(particle.height) ||
      !finiteNumber(particle.ageSeconds)
    ) {
      next.push(respawn());
      continue;
    }
    const age = particle.ageSeconds + deltaSeconds;
    if (age >= lifetimeSeconds) {
      next.push(respawn());
      continue;
    }
    const sample = sampleWind(field, {
      longitude: particle.longitude,
      latitude: particle.latitude,
      height: particle.height,
    });
    if (!sample) {
      next.push(respawn());
      continue;
    }
    const stepEast = sample.east * speedScale * deltaSeconds;
    const stepNorth = sample.north * speedScale * deltaSeconds;
    const stepUp = sample.up * speedScale * deltaSeconds;
    const longitude = particle.longitude + stepEast / metersPerDegreeLongitude(particle.latitude);
    const latitude = particle.latitude + stepNorth / METERS_PER_DEGREE_LATITUDE;
    const height = particle.height + stepUp;
    if (
      longitude < bounds.west ||
      longitude > bounds.east ||
      latitude < bounds.south ||
      latitude > bounds.north
    ) {
      next.push(respawn());
      continue;
    }
    next.push({ longitude, latitude, height, ageSeconds: age });
  }
  return Object.freeze(next);
}
