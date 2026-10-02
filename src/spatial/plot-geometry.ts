import { createLocalFrame } from './geodesy.js';
import { pointFeatureOf } from './geojson.js';
import { measureDestination, measureDistance } from './measure.js';
import { finite, spatialError } from './types.js';
import type { GeoPoint, GeoRing } from './types.js';

/** 圆弧弦高容差的默认值，单位为米。 */
const DEFAULT_TOLERANCE_METERS = 10;
/** 单个形状的顶点上限默认值。 */
const DEFAULT_MAX_SAMPLES = 512;
/** 圆与椭圆的最少采样点数：再小的圆也要看起来像圆。 */
const MIN_ARC_SAMPLES = 16;

/**
 * 程序化几何的采样口径。
 *
 * 圆弧类形状不按固定点数采样，而是按**弦高容差**：半径越大采样越密，但不会超过顶点上限。
 * 这样可以放心用一个大半径，不用担心顶点数随半径线性膨胀。
 */
export interface PlotSamplingOptions {
  /** 弦高容差，单位为米，默认 10；越小越接近真圆。 */
  readonly toleranceMeters?: number;
  /** 单个形状的顶点上限，默认 512。 */
  readonly maxSamples?: number;
}

/** 圆：圆心与半径。 */
export interface CircleGeometryOptions extends PlotSamplingOptions {
  /** 圆心。 */
  readonly center: GeoPoint;
  /** 半径，单位为米，必须为正数。 */
  readonly radiusMeters: number;
}

/** 椭圆：圆心、长短半轴与长轴方位角。 */
export interface EllipseGeometryOptions extends PlotSamplingOptions {
  /** 圆心。 */
  readonly center: GeoPoint;
  /** 长半轴，单位为米，必须为正数。 */
  readonly semiMajorMeters: number;
  /** 短半轴，单位为米，必须为正数且不大于长半轴。 */
  readonly semiMinorMeters: number;
  /** 长轴方位角，单位为度，正北为 0、顺时针为正；默认 0（长轴指向正北）。 */
  readonly rotationDegrees?: number;
}

/** 直线箭头：起点到终点。 */
export interface StraightArrowOptions {
  /** 箭尾（起点）。 */
  readonly from: GeoPoint;
  /** 箭尖（终点）。 */
  readonly to: GeoPoint;
  /** 箭杆宽度，单位为米；省略时取全长的 12%，上限为全长的 25%。 */
  readonly tailWidthMeters?: number;
  /** 箭头最宽处，单位为米；省略时取箭杆宽度的 2.2 倍，下限为箭杆宽度的 1.4 倍。 */
  readonly headWidthMeters?: number;
}

/**
 * 按弦高容差算圆上的采样点数。
 *
 * 弦高 `sagitta = r × (1 − cos(θ/2))`，给定容差反解步进角 `θ`，再取整圈需要多少步。
 * 半径非法时退回最少点数，由调用方在此之前完成校验。
 */
function arcSampleCount(radiusMeters: number, toleranceMeters: number, maxSamples: number): number {
  if (!(radiusMeters > 0)) {
    return 3;
  }
  const sagitta = Math.max(toleranceMeters, 0.5);
  const ratio = Math.min(1, (2 * sagitta) / Math.max(radiusMeters, 1e-6));
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ratio)));
  const count = Math.ceil((2 * Math.PI) / Math.max(step, 1e-4));
  return Math.max(MIN_ARC_SAMPLES, Math.min(maxSamples, count));
}

function resolveSampling(
  options: PlotSamplingOptions,
  operation: string,
): { readonly toleranceMeters: number; readonly maxSamples: number } {
  const toleranceMeters = options.toleranceMeters ?? DEFAULT_TOLERANCE_METERS;
  if (!finite(toleranceMeters) || toleranceMeters <= 0) {
    throw spatialError(
      'Plot toleranceMeters must be a positive finite number of meters.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  if (!Number.isInteger(maxSamples) || maxSamples < MIN_ARC_SAMPLES) {
    throw spatialError(
      `Plot maxSamples must be an integer of at least ${String(MIN_ARC_SAMPLES)}.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  return { toleranceMeters, maxSamples };
}

function requirePositive(value: number, name: string, operation: string): void {
  if (!finite(value) || value <= 0) {
    throw spatialError(
      `Plot ${name} must be a positive finite number of meters.`,
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
}

/**
 * 生成圆环：圆心、半径 → 顶点环。
 *
 * 顶点按大圆距离落在半径上（用 `measureDestination()`），因此跨纬度也保持等距，
 * 不会像"按经纬度画圆"那样在高纬度被压扁。
 *
 * @param options - 圆心、半径与采样口径。
 * @returns 顶点环（**首尾不重复**，需要闭合时用 `closeRing()` 或 `polygonFeatureOf()`）。
 * @throws `INVALID_COORDINATES` 圆心非法；`INVALID_SPATIAL_INPUT` 半径或采样口径非法。
 */
export function buildCircle(options: CircleGeometryOptions): GeoRing {
  const operation = 'buildCircle';
  pointFeatureOf(options.center, operation);
  const { radiusMeters } = options;
  requirePositive(radiusMeters, 'radiusMeters', operation);
  const sampling = resolveSampling(options, operation);
  const samples = arcSampleCount(radiusMeters, sampling.toleranceMeters, sampling.maxSamples);
  const ring: GeoPoint[] = [];
  for (let index = 0; index < samples; index += 1) {
    const bearing = (index / samples) * 360;
    ring.push(measureDestination(options.center, bearing, radiusMeters));
  }
  return Object.freeze(ring);
}

/**
 * 生成椭圆环：圆心、长短半轴与长轴方位角 → 顶点环。
 *
 * 在圆心的局部东-北平面上构造标准椭圆再换算回经纬高：`rotationDegrees` 是长轴的方位角，
 * 因此"长轴指向正北"就是 0 度，不需要调用方换算坐标轴。
 *
 * @param options - 圆心、半轴、方位角与采样口径。
 * @returns 顶点环（首尾不重复）。
 * @throws `INVALID_COORDINATES` 圆心非法；`INVALID_SPATIAL_INPUT` 半轴、方位角或采样口径非法。
 */
export function buildEllipse(options: EllipseGeometryOptions): GeoRing {
  const operation = 'buildEllipse';
  pointFeatureOf(options.center, operation);
  const { semiMajorMeters, semiMinorMeters } = options;
  requirePositive(semiMajorMeters, 'semiMajorMeters', operation);
  requirePositive(semiMinorMeters, 'semiMinorMeters', operation);
  if (semiMinorMeters > semiMajorMeters) {
    throw spatialError(
      'Plot semiMinorMeters must not be greater than semiMajorMeters.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  const rotation = options.rotationDegrees ?? 0;
  if (!finite(rotation)) {
    throw spatialError(
      'Plot rotationDegrees must be a finite number of degrees.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  const sampling = resolveSampling(options, operation);
  const samples = Math.max(
    24,
    Math.min(
      sampling.maxSamples,
      Math.ceil(
        (arcSampleCount(semiMajorMeters, sampling.toleranceMeters, sampling.maxSamples) * 3) / 4,
      ),
    ),
  );
  const frame = createLocalFrame(options.center);
  const azimuth = rotation * (Math.PI / 180);
  const cosAzimuth = Math.cos(azimuth);
  const sinAzimuth = Math.sin(azimuth);
  const ring: GeoPoint[] = [];
  for (let index = 0; index < samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2;
    // 先在主轴坐标系里取点（长轴为 x），再按方位角旋到东-北平面。
    const major = semiMajorMeters * Math.cos(angle);
    const minor = semiMinorMeters * Math.sin(angle);
    const east = major * sinAzimuth + minor * cosAzimuth;
    const north = major * cosAzimuth - minor * sinAzimuth;
    const geographic = frame.toGeographic({ x: east, y: north, z: 0 });
    ring.push({
      longitude: geographic.longitude,
      latitude: geographic.latitude,
      height: geographic.height,
    });
  }
  return Object.freeze(ring);
}

/**
 * 生成直线箭头：起点、终点 → 闭合多边形顶点环。
 *
 * 形状是"箭杆 + 双翼箭头"：箭杆沿起终点轴线两侧对称，箭头在接近终点处张开、以终点为唯一箭尖。
 * 宽度省略时按全长推导（箭杆 12%、箭头 2.2 倍箭杆宽），因此不需要调用方先知道地图比例尺。
 *
 * @param options - 起终点与可选的尾宽 / 头宽。
 * @returns 顶点环，共 7 个顶点（首尾不重复；最后一个顶点是最宽的箭翼之一，箭尖在环内第 4 个）。
 * @throws `INVALID_COORDINATES` 起终点非法；`INVALID_SPATIAL_INPUT` 起终点重合或宽度非法。
 */
export function buildStraightArrow(options: StraightArrowOptions): GeoRing {
  const operation = 'buildStraightArrow';
  pointFeatureOf(options.from, operation);
  pointFeatureOf(options.to, operation);
  const length = measureDistance(options.from, options.to).meters;
  if (!(length > 1)) {
    throw spatialError(
      'Straight arrow requires a distance of more than one meter between its ends.',
      'INVALID_SPATIAL_INPUT',
      operation,
    );
  }
  if (options.tailWidthMeters !== undefined) {
    requirePositive(options.tailWidthMeters, 'tailWidthMeters', operation);
  }
  if (options.headWidthMeters !== undefined) {
    requirePositive(options.headWidthMeters, 'headWidthMeters', operation);
  }
  const tailWidth = Math.min(
    Math.max(2, options.tailWidthMeters ?? Math.min(length * 0.12, 3_000)),
    length * 0.25,
  );
  const headWidth = Math.min(
    Math.max(tailWidth * 1.4, options.headWidthMeters ?? tailWidth * 2.2),
    length * 0.6,
  );
  const headLength = Math.min(length * 0.45, headWidth * 1.1);

  const frame = createLocalFrame(options.from);
  const tip = frame.toLocal(options.to);
  const localLength = Math.hypot(tip.x, tip.y);
  const axis = { x: tip.x / localLength, y: tip.y / localLength };
  const normal = { x: -axis.y, y: axis.x };
  const base = {
    x: tip.x - axis.x * headLength,
    y: tip.y - axis.y * headLength,
  };
  const tailHalf = tailWidth / 2;
  const headHalf = headWidth / 2;
  const planar = [
    { x: normal.x * tailHalf, y: normal.y * tailHalf },
    { x: base.x + normal.x * tailHalf, y: base.y + normal.y * tailHalf },
    { x: base.x + normal.x * headHalf, y: base.y + normal.y * headHalf },
    // 箭尖：直接取终点，避免局部平面往返引入偏差。
    { x: tip.x, y: tip.y },
    { x: base.x - normal.x * headHalf, y: base.y - normal.y * headHalf },
    { x: base.x - normal.x * tailHalf, y: base.y - normal.y * tailHalf },
    { x: -normal.x * tailHalf, y: -normal.y * tailHalf },
  ];
  const height = options.from.height ?? 0;
  const ring: GeoPoint[] = planar.map((point) => {
    const geographic = frame.toGeographic({ x: point.x, y: point.y, z: 0 });
    return {
      longitude: geographic.longitude,
      latitude: geographic.latitude,
      height,
    };
  });
  // 箭尖必须与传入的终点完全一致（局部平面往返会有毫米级偏差）。
  ring[3] = { longitude: options.to.longitude, latitude: options.to.latitude, height };
  return Object.freeze(ring);
}
