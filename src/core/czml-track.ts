import type { CzmlTrack, CzmlTrackSample } from './czml.js';
import type { GeoPosition } from './controls.js';
import { GisError } from './errors.js';
import { ReplayTimeline } from './replay-timeline.js';
import type { ReplaySample, ReplayTimelineOptions } from './replay-timeline.js';
import type { Quaternion } from '../spatial/attitude.js';
import { slerp } from '../spatial/attitude.js';

/**
 * 轨迹时间轴里的样本。
 *
 * `time` 就是相对该轨迹 epoch 的秒数（与 CZML 的 `timeSeconds` 同一个值）；
 * 时间轴只认 `time`，因此这里把它作为唯一的时间字段。
 */
export interface TrackTimelineSample extends ReplaySample {
  /** WGS84 经纬高。 */
  readonly position: GeoPosition;
  /** 该时刻的姿态；原始采样没有姿态时为 `undefined`。 */
  readonly attitude: Quaternion | undefined;
}

/** 采样出的轨迹姿态。 */
export interface TrackPose {
  /** WGS84 经纬高。 */
  readonly position: GeoPosition;
  /**
   * 姿态四元数（x, y, z, w）；该时刻没有姿态数据时为 `undefined`。
   *
   * 采样点之间会做球面线性插值；只有一端有姿态时沿用那一端的姿态（不猜）。
   */
  readonly attitude: Quaternion | undefined;
}

/** 轨迹时间轴选项。 */
export interface TrackTimelineOptions {
  /** 单个对象的样本上限，默认 600；轨迹很长时按采样密度调整。 */
  readonly maxSamplesPerKey?: number;
  /** 序列两端之外允许外推的秒数，默认 0（不外推，断流时冻结在最后一个样本）。 */
  readonly maxExtrapolationSeconds?: number;
}

/** 运行期数组判断；单独写一层是为了不让 `Array.isArray` 把类型塌成 `any[]`。 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function trackError(message: string, operation: string): GisError {
  return new GisError(message, { code: 'INVALID_CZML', module: 'czml', operation });
}

/**
 * 把一条 CZML 轨迹装成回放时间轴。
 *
 * 时间轴里存的是**原始采样**，查询时按 `timeSeconds` 插值：
 * 位置按最短弧插值经度（跨 180° 不会绕地球一圈），姿态用四元数球面线性插值 `slerp()`，
 * 只有一端有姿态时沿用那一端的姿态而不是伪造单位四元数。
 *
 * 这就是 CZML → 回放 → 渲染之间的桥：`tracksFromCzml()` 读出的轨迹交给本函数，
 * 之后按 `SimulationClock` 的时刻调 `sampleTrackPose()` 即可。
 *
 * @param track - `tracksFromCzml()` 返回的一条轨迹。
 * @param options - 采样上限与外推设置。
 * @returns 可直接查询的时间轴。
 * @throws `INVALID_CZML` 轨迹为空或时间戳非有限数。
 */
export function createTrackTimeline(
  track: CzmlTrack,
  options: TrackTimelineOptions = {},
): ReplayTimeline<TrackTimelineSample> {
  const operation = 'createTrackTimeline';
  const candidate: unknown = track;
  const bag = (candidate ?? {}) as { readonly samples?: unknown };
  const rawSamples: unknown = bag.samples;
  if (!isUnknownArray(rawSamples) || rawSamples.length === 0) {
    throw trackError('CZML track must contain at least one sample.', operation);
  }
  const timelineOptions: ReplayTimelineOptions<TrackTimelineSample> = {
    maxSamplesPerKey: options.maxSamplesPerKey ?? 600,
    maxExtrapolationSeconds: options.maxExtrapolationSeconds ?? 0,
    interpolate: (previous, next, ratio) => ({
      time: previous.time + (next.time - previous.time) * ratio,
      position: interpolatePosition(previous.position, next.position, ratio),
      attitude: interpolateAttitude(previous.attitude, next.attitude, ratio),
    }),
    clone: (sample) => ({
      time: sample.time,
      position: { ...sample.position },
      attitude: sample.attitude ? { ...sample.attitude } : undefined,
    }),
  };
  const timeline = new ReplayTimeline<TrackTimelineSample>(timelineOptions);
  for (const entry of rawSamples) {
    const sample = (entry ?? {}) as Partial<CzmlTrackSample>;
    const timeSeconds = sample.timeSeconds;
    const { longitude, latitude, height = 0 } = (sample.position ?? {}) as Partial<GeoPosition>;
    if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds)) {
      throw trackError('CZML sample time must be a finite number.', operation);
    }
    if (
      typeof longitude !== 'number' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(height)
    ) {
      throw trackError('CZML sample position must be finite WGS84 coordinates.', operation);
    }
    timeline.addSample(track.id, {
      time: timeSeconds,
      position: {
        longitude,
        latitude,
        ...(height === 0 ? {} : { height }),
      },
      attitude: sample.attitude ? { ...sample.attitude } : undefined,
    });
  }
  return timeline;
}

/**
 * 取某一时刻的轨迹姿态。
 *
 * @param timeline - {@link createTrackTimeline} 返回的时间轴。
 * @param trackId - 轨迹 id（也就是 CZML 实体 id）。
 * @param timeSeconds - 相对轨迹 epoch 的秒数。
 * @returns 该时刻的姿态；时间轴里没有这条轨迹或超出外推范围时为 `undefined`。
 */
export function sampleTrackPose(
  timeline: ReplayTimeline<TrackTimelineSample>,
  trackId: string,
  timeSeconds: number,
): TrackPose | undefined {
  const sample = timeline.sampleAt(trackId, timeSeconds);
  if (!sample) {
    return undefined;
  }
  return {
    position: { ...sample.position },
    attitude: sample.attitude ? { ...sample.attitude } : undefined,
  };
}

/** 位置插值：经度走最短弧，纬度与高度线性。 */
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

/**
 * 姿态插值：两端都有姿态时 slerp；只有一端有姿态时取**更近那一端**的姿态。
 *
 * 不取"有姿态的那一端"：那样会在缺失姿态的采样点上凭空补出一个姿态。取更近的一端能保证
 * 采样时刻恰好返回该采样自身的姿态（`ratio` 为 0 或 1），中间则是最接近的真实姿态；
 * 正好等距（0.5）时取前一个样本。
 */
function interpolateAttitude(
  from: Quaternion | undefined,
  to: Quaternion | undefined,
  ratio: number,
): Quaternion | undefined {
  if (from && to) {
    return slerp(from, to, ratio);
  }
  const nearest = ratio <= 0.5 ? from : to;
  return nearest ? { ...nearest } : undefined;
}
