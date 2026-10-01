import type { GeoPosition, WorldCoordinates } from '../core/controls.js';
import { finite, spatialError } from './types.js';

/** WGS84 长半轴，单位为米。 */
export const WGS84_SEMI_MAJOR_AXIS = 6_378_137;

/** WGS84 扁率。 */
export const WGS84_FLATTENING = 1 / 298.257223563;

/** WGS84 短半轴，单位为米（`b = a (1 - f)`）。 */
export const WGS84_SEMI_MINOR_AXIS = WGS84_SEMI_MAJOR_AXIS * (1 - WGS84_FLATTENING);

const E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const DEGREE = Math.PI / 180;

/** 迭代求纬度时的收敛阈值（弧度）；参照实现用 1e-12，实测三轮内收敛。 */
const LATITUDE_EPSILON = 1e-12;

function invalidGeodetic(message: string, operation: string): never {
  throw spatialError(message, 'INVALID_SPATIAL_INPUT', operation);
}

function assertGeodetic(position: GeoPosition, operation: string): void {
  const candidate = position as
    | { readonly longitude?: unknown; readonly latitude?: unknown; readonly height?: unknown }
    | undefined;
  if (!candidate || !finite(candidate.longitude) || !finite(candidate.latitude)) {
    invalidGeodetic('Geodetic position needs finite longitude and latitude in degrees.', operation);
  }
  if (candidate.height !== undefined && !finite(candidate.height)) {
    invalidGeodetic('Geodetic height must be a finite number of meters.', operation);
  }
}

function assertEcef(ecef: WorldCoordinates, operation: string): void {
  const candidate = ecef as
    { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown } | undefined;
  if (!candidate || !finite(candidate.x) || !finite(candidate.y) || !finite(candidate.z)) {
    invalidGeodetic('ECEF coordinates must be finite numbers of meters.', operation);
  }
}

/**
 * 经纬高（度、米）转地心直角坐标（ECEF，米）。
 *
 * 与 `coordinates.toWorld()` 的区别：这里不依赖渲染引擎，只做椭球数学，因此在 `/core` 可用；
 * 需要与 Cesium 场景完全一致时仍应使用 `map.coordinates.toWorld()`。
 *
 * @throws `INVALID_SPATIAL_INPUT` 经纬度或高程不是有限数。
 */
export function geodeticToEcef(position: GeoPosition): WorldCoordinates {
  assertGeodetic(position, 'geodeticToEcef');
  const longitude = position.longitude * DEGREE;
  const latitude = position.latitude * DEGREE;
  const height = position.height ?? 0;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const primeVertical = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(1 - E2 * sinLatitude * sinLatitude);
  return {
    x: (primeVertical + height) * cosLatitude * Math.cos(longitude),
    y: (primeVertical + height) * cosLatitude * Math.sin(longitude),
    z: (primeVertical * (1 - E2) + height) * sinLatitude,
  };
}

/**
 * 地心直角坐标转经纬高。
 *
 * 用迭代法解纬度，收敛后经度误差由 `atan2` 决定、纬度误差小于 1e-9 度；极点附近
 * （`hypot(x, y) < 1e-9`）单独处理，避免除以零。
 *
 * @throws `INVALID_SPATIAL_INPUT` 坐标不是有限数。
 */
export function ecefToGeodetic(ecef: WorldCoordinates): Required<GeoPosition> {
  assertEcef(ecef, 'ecefToGeodetic');
  const longitude = Math.atan2(ecef.y, ecef.x);
  const p = Math.hypot(ecef.x, ecef.y);
  if (p < 1e-9) {
    const latitude = ecef.z >= 0 ? 90 : -90;
    return {
      longitude: longitude / DEGREE,
      latitude,
      height: Math.abs(ecef.z) - WGS84_SEMI_MINOR_AXIS,
    };
  }

  let latitude = Math.atan2(ecef.z, p * (1 - E2));
  let height = 0;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const sinLatitude = Math.sin(latitude);
    const primeVertical = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(1 - E2 * sinLatitude * sinLatitude);
    height = p / Math.cos(latitude) - primeVertical;
    const nextLatitude = Math.atan2(
      ecef.z,
      p * (1 - (E2 * primeVertical) / (primeVertical + height)),
    );
    if (Math.abs(nextLatitude - latitude) < LATITUDE_EPSILON) {
      latitude = nextLatitude;
      break;
    }
    latitude = nextLatitude;
  }
  return { longitude: longitude / DEGREE, latitude: latitude / DEGREE, height };
}

/**
 * 局部东-北-天（ENU）坐标系。
 *
 * 以椭球面（或给定高程）上的一点为原点，把附近的经纬高与局部米制坐标互换。程序化几何
 * （闪电、标绘、水面这类要按"向东 300 米、向北 200 米"构造的图形）在这一坐标系里计算，
 * 再换算回经纬高交给图层渲染。
 */
export interface LocalFrame {
  /** 原点经纬高，高程缺省为 0。 */
  readonly origin: Required<GeoPosition>;
  /** 东向单位向量（ECEF）。 */
  readonly east: WorldCoordinates;
  /** 北向单位向量（ECEF）。 */
  readonly north: WorldCoordinates;
  /** 天向单位向量（ECEF）。 */
  readonly up: WorldCoordinates;
  /**
   * 经纬高转局部米制坐标：`x` 向东、`y` 向北、`z` 向上。
   *
   * {@link toGeographic} 的逆运算；在原点附近与真实距离的差异随距离增大，100 km 量级
   * 误差小于 0.1%，适合程序化几何，不适合精确量算（量算用 `measureDistance()`）。
   */
  toLocal(position: GeoPosition): WorldCoordinates;
  /** 局部米制坐标（东、北、天，单位米）转经纬高。 */
  toGeographic(local: WorldCoordinates): Required<GeoPosition>;
}

/**
 * 在给定原点建立局部 ENU 坐标系。
 *
 * @throws `INVALID_SPATIAL_INPUT` 原点经纬度或高程不是有限数。
 */
export function createLocalFrame(origin: GeoPosition): LocalFrame {
  assertGeodetic(origin, 'createLocalFrame');
  const resolved: Required<GeoPosition> = {
    longitude: origin.longitude,
    latitude: origin.latitude,
    height: origin.height ?? 0,
  };
  const longitude = resolved.longitude * DEGREE;
  const latitude = resolved.latitude * DEGREE;
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const east: WorldCoordinates = { x: -sinLongitude, y: cosLongitude, z: 0 };
  const north: WorldCoordinates = {
    x: -sinLatitude * cosLongitude,
    y: -sinLatitude * sinLongitude,
    z: cosLatitude,
  };
  const up: WorldCoordinates = {
    x: cosLatitude * cosLongitude,
    y: cosLatitude * sinLongitude,
    z: sinLatitude,
  };
  const originEcef = geodeticToEcef(resolved);

  const project = (vector: WorldCoordinates): WorldCoordinates => ({
    x: vector.x * east.x + vector.y * east.y + vector.z * east.z,
    y: vector.x * north.x + vector.y * north.y + vector.z * north.z,
    z: vector.x * up.x + vector.y * up.y + vector.z * up.z,
  });

  return Object.freeze({
    origin: Object.freeze(resolved),
    east: Object.freeze(east),
    north: Object.freeze(north),
    up: Object.freeze(up),
    toLocal(position: GeoPosition): WorldCoordinates {
      assertGeodetic(position, 'LocalFrame.toLocal');
      const ecef = geodeticToEcef(position);
      return project({
        x: ecef.x - originEcef.x,
        y: ecef.y - originEcef.y,
        z: ecef.z - originEcef.z,
      });
    },
    toGeographic(local: WorldCoordinates): Required<GeoPosition> {
      const offset = local as
        { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown } | undefined;
      if (!offset || !finite(offset.x) || !finite(offset.y) || !finite(offset.z)) {
        invalidGeodetic(
          'Local ENU coordinates must be finite numbers of meters.',
          'LocalFrame.toGeographic',
        );
      }
      return ecefToGeodetic({
        x: originEcef.x + east.x * local.x + north.x * local.y + up.x * local.z,
        y: originEcef.y + east.y * local.x + north.y * local.y + up.y * local.z,
        z: originEcef.z + east.z * local.x + north.z * local.y + up.z * local.z,
      });
    },
  });
}
