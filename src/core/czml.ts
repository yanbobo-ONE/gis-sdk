import type { GeoPosition } from './controls.js';
import { GisError } from './errors.js';
import type { Quaternion } from '../spatial/attitude.js';

/** CZML 文档：包数组（首个通常是 `document` 包）。 */
export type CzmlDocument = readonly Readonly<Record<string, unknown>>[];

/** 带显式时间的采样点。 */
export interface CzmlTimestampedPosition {
  /** 相对 epoch 的秒数。 */
  readonly timeSeconds: number;
  /** WGS84 经纬高。 */
  readonly position: GeoPosition;
}

/** {@link czmlFromPositions} 的配置。 */
export interface CzmlExportOptions {
  /** 实体显示名；省略时不写入 `name`。 */
  readonly name?: string;
  /** 文档 epoch（ISO 字符串），默认 `1970-01-01T00:00:00Z`。 */
  readonly epoch?: string;
  /** 采样间隔，单位为秒，默认 1；仅在点位多于一个时使用。 */
  readonly intervalSeconds?: number;
  /** 首个采样相对 epoch 的秒数，默认 0。 */
  readonly startSeconds?: number;
  /** 是否写入 `availability`（覆盖采样起止），默认 `true`。 */
  readonly availability?: boolean;
  /**
   * 写入 `model` 报文，让原生 Cesium 把实体渲染成 glTF / GLB 模型。
   *
   * 省略时只写位置，文档交给 SDK 图层消费；与参照实现一致，`minimumPixelSize` 默认 24，
   * 保证远距离下模型不会缩成不可见的点。
   */
  readonly model?: CzmlModelOptions;
}

/** CZML `model` 报文配置。 */
export interface CzmlModelOptions {
  /** glTF / GLB 资源地址。 */
  readonly url: string;
  /** 缩放下限（屏幕像素），默认 24。 */
  readonly minimumPixelSize?: number;
  /** 统一缩放倍数；省略时不写入。 */
  readonly scale?: number;
}

/** 可用区间，单位为相对 epoch 的秒数。 */
export interface CzmlAvailabilityInterval {
  /** 起始秒数。 */
  readonly startSeconds: number;
  /** 结束秒数。 */
  readonly endSeconds: number;
}

/** 从 CZML 文档解析出的一条轨迹：位置、可选姿态、模型地址与可用区间。 */
export interface CzmlTrack {
  /** 实体 id。 */
  readonly id: string;
  /** 实体显示名；没有时为 `undefined`。 */
  readonly name: string | undefined;
  /** 解析使用的 epoch（ISO 字符串）；所有 `timeSeconds` 都相对它。 */
  readonly epoch: string;
  /**
   * 模型资源地址（`model.gltf`）；文档没有 model 报文时为 `undefined`。
   *
   * 注意 CZML 里还可能有 `model.minimumPixelSize`、`scale` 等渲染参数，SDK 只取地址：
   * 具体怎么渲染由消费方（原生 Cesium 或 SDK 的模型图层）决定。
   */
  readonly modelUrl: string | undefined;
  /** 采样，按时间升序；每条的 `attitude` 为该时刻的姿态（文档没有姿态时为 `undefined`）。 */
  readonly samples: readonly CzmlTrackSample[];
  /** 可用区间；没有 `availability` 时为空数组。 */
  readonly availability: readonly CzmlAvailabilityInterval[];
}

/** 一条轨迹上的采样。 */
export interface CzmlTrackSample extends CzmlTimestampedPosition {
  /**
   * 姿态四元数（x, y, z, w，与 CZML `unitQuaternion` 顺序一致）。
   *
   * 文档没有 `orientation` 时为 `undefined`，不会伪造单位四元数。
   */
  readonly attitude: Quaternion | undefined;
}

/** 从 CZML 文档解析出的一条位置轨迹。 */
export interface CzmlPositionTrack {
  /** 实体 id。 */
  readonly id: string;
  /** 实体显示名；没有时为 `undefined`。 */
  readonly name: string | undefined;
  /** 解析使用的 epoch（ISO 字符串）；所有 `timeSeconds` 都相对它。 */
  readonly epoch: string;
  /** 位置采样，按时间升序。 */
  readonly samples: readonly CzmlTimestampedPosition[];
  /** 可用区间；没有 `availability` 时为空数组。 */
  readonly availability: readonly CzmlAvailabilityInterval[];
}

/** {@link positionsFromCzml} 的配置。 */
export interface CzmlImportOptions {
  /**
   * 覆盖文档 epoch。
   *
   * 省略时依次尝试：文档 `clock.interval` 的起点 → 各包 `position.epoch` → Unix epoch。
   */
  readonly epoch?: string;
}

/** 默认 epoch。 */
/** 模型缩放下限默认值（屏幕像素），与参照实现一致。 */
const DEFAULT_MINIMUM_PIXEL_SIZE = 24;

const DEFAULT_EPOCH = '1970-01-01T00:00:00Z';

function czmlError(message: string, operation: string): GisError {
  return new GisError(message, { code: 'INVALID_CZML', module: 'czml', operation });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 判断取值是否为数组。
 *
 * 不直接用 `Array.isArray`：它的类型谓词是 `any[]`，会把已经声明好的参数类型收窄成
 * `any[]`，破坏后续的类型检查。
 */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** epoch + 秒数 → ISO 字符串。 */
function toIsoString(epoch: string, seconds: number): string {
  const parsed = Date.parse(epoch);
  if (!Number.isFinite(parsed)) {
    throw czmlError(`CZML epoch "${epoch}" is not a valid ISO date.`, 'toIsoString');
  }
  return new Date(parsed + seconds * 1000).toISOString();
}

/** ISO 字符串或秒数 → 相对 epoch 的秒数。 */
function toSeconds(value: unknown, epoch: string): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    const base = Date.parse(epoch);
    if (Number.isFinite(parsed) && Number.isFinite(base)) {
      return (parsed - base) / 1000;
    }
  }
  return undefined;
}

/** CZML 文档自带的时钟区间；时间统一换算成毫秒时间戳。 */
export interface CzmlDocumentClock {
  /** 区间起点，毫秒时间戳。 */
  readonly startTime: number;
  /** 区间终点，毫秒时间戳。 */
  readonly endTime: number;
  /**
   * 文档建议的当前时间，毫秒时间戳；文档没写或不是合法 ISO 字符串时为 `undefined`。
   *
   * 这里原样给出文档里写的值，不替调用方钳制到区间内——`SimulationClock` 与
   * `map.clock.setTime()` 各自会在自己的范围内处理。
   */
  readonly currentTime: number | undefined;
}

/**
 * 读 CZML 文档自带的 `clock`。
 *
 * SDK **不会**把文档时钟自动应用到地图时钟：时间轴联动属于业务编排（同一张地图上可能有
 * 多个文档，谁是主时间轴只有业务知道）。但业务也不必自己去解析 ISO 区间——拿这个读数配
 * `map.clock.setRange()` / `setTime()` 即可，或直接交给 `SimulationClock`。
 *
 * 文档没有 `clock`、区间格式非法、或终点早于起点时返回 `undefined`：这是读数，不抛错。
 */
export function readCzmlClock(document: CzmlDocument): CzmlDocumentClock | undefined {
  if (!isArray(document)) {
    return undefined;
  }
  for (const packet of document as readonly unknown[]) {
    const record = isRecord(packet) ? packet : undefined;
    if (record?.id !== 'document') {
      continue;
    }
    const clock = record.clock;
    if (!isRecord(clock) || typeof clock.interval !== 'string') {
      return undefined;
    }
    const [startRaw, endRaw] = clock.interval.split('/');
    const startTime = startRaw === undefined ? Number.NaN : Date.parse(startRaw);
    const endTime = endRaw === undefined ? Number.NaN : Date.parse(endRaw);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) {
      return undefined;
    }
    const currentRaw = clock.currentTime;
    const parsedCurrent = typeof currentRaw === 'string' ? Date.parse(currentRaw) : Number.NaN;
    return {
      startTime,
      endTime,
      currentTime: Number.isFinite(parsedCurrent) ? parsedCurrent : undefined,
    };
  }
  return undefined;
}

function readPosition(
  position: unknown,
  epoch: string,
  operation: string,
): CzmlTimestampedPosition[] {
  if (!isRecord(position) || !isArray(position.cartographicDegrees)) {
    return [];
  }
  const values = position.cartographicDegrees;
  const read = (offset: number): GeoPosition | undefined => {
    const longitude = values[offset];
    const latitude = values[offset + 1];
    const height = values[offset + 2] ?? 0;
    if (!finiteNumber(longitude) || !finiteNumber(latitude) || !finiteNumber(height)) {
      return undefined;
    }
    return { longitude, latitude, height };
  };

  // 静态位置：只有一组经纬高。
  if (values.length === 3) {
    const single = read(0);
    if (!single) {
      throw czmlError('CZML cartographicDegrees contains a non-finite position.', operation);
    }
    return [{ timeSeconds: 0, position: single }];
  }
  if (values.length % 4 !== 0 || values.length === 0) {
    throw czmlError(
      'CZML cartographicDegrees must be either [lon, lat, height] or sampled [t, lon, lat, height, ...].',
      operation,
    );
  }

  // 采样位置：包的 epoch 可以覆盖文档 epoch，时间戳既可以是 ISO 字符串也可以是秒数。
  const packetEpoch = typeof position.epoch === 'string' ? position.epoch : epoch;
  const epochOffset = (Date.parse(packetEpoch) - Date.parse(epoch)) / 1000;
  if (!Number.isFinite(epochOffset)) {
    throw czmlError(`CZML position epoch "${packetEpoch}" is not a valid ISO date.`, operation);
  }

  const samples: CzmlTimestampedPosition[] = [];
  for (let index = 0; index < values.length; index += 4) {
    const rawTime = toSeconds(values[index], packetEpoch);
    const timeSeconds =
      typeof values[index] === 'number' && rawTime !== undefined ? rawTime + epochOffset : rawTime;
    const point = read(index + 1);
    if (timeSeconds === undefined || !point) {
      throw czmlError('CZML position sample has an invalid time or position.', operation);
    }
    samples.push({ timeSeconds, position: point });
  }
  return samples.sort((left, right) => left.timeSeconds - right.timeSeconds);
}

function readAvailability(
  availability: unknown,
  epoch: string,
  operation: string,
): CzmlAvailabilityInterval[] {
  if (availability === undefined) {
    return [];
  }
  const intervals = typeof availability === 'string' ? [availability] : availability;
  if (!isArray(intervals) || !intervals.every((item) => typeof item === 'string')) {
    throw czmlError('CZML availability must be an interval string or an array of them.', operation);
  }
  return intervals.map((interval) => {
    const [start = '', end = '', extra] = interval.split('/');
    const startSeconds = toSeconds(start, epoch);
    const endSeconds = toSeconds(end, epoch);
    if (
      extra !== undefined ||
      startSeconds === undefined ||
      endSeconds === undefined ||
      endSeconds < startSeconds
    ) {
      throw czmlError(`CZML availability interval "${interval}" is invalid.`, operation);
    }
    return { startSeconds, endSeconds };
  });
}

/** 解析文档 epoch：`clock.interval` 起点优先，其次任意包的 `position.epoch`。 */
function resolveEpoch(packets: readonly Record<string, unknown>[]): string | undefined {
  for (const packet of packets) {
    if (packet.id !== 'document') {
      continue;
    }
    const clock = packet.clock;
    if (isRecord(clock) && typeof clock.interval === 'string') {
      const start = clock.interval.split('/')[0];
      if (start) {
        return start;
      }
    }
  }
  for (const packet of packets) {
    const position = packet.position;
    if (isRecord(position) && typeof position.epoch === 'string') {
      return position.epoch;
    }
  }
  return undefined;
}

/**
 * 由带时间的采样点生成 CZML 文档。
 *
 * 输出是最小可用集合：`document` 包（版本与时钟区间）+ 一个实体包（`position.cartographicDegrees`
 * 采样、可选 `availability`）。业务属性（载荷、告警、模型地址等）不在范围内——它们是业务语义，
 * 需要时由业务在文档上追加字段。
 *
 * @param id - 实体 id，必须非空。
 * @param samples - 带时间的采样点，至少 1 个；时间必须为非负有限秒数。
 * @param options - epoch、名称与是否写入 availability。
 * @returns CZML 文档（包数组），可直接交给 Cesium 原生 `CzmlDataSource.load()`。
 * @throws `INVALID_CZML` id 为空、采样为空、时间非法或 epoch 不是合法 ISO 日期。
 */
export function czmlFromSamples(
  id: string,
  samples: readonly CzmlTimestampedPosition[],
  options: CzmlExportOptions = {},
): CzmlDocument {
  const operation = 'czmlFromSamples';
  const entityId = typeof id === 'string' ? id.trim() : '';
  if (!entityId) {
    throw czmlError('CZML entity id must be a non-empty string.', operation);
  }
  if (!isArray(samples) || samples.length === 0) {
    throw czmlError('CZML export requires at least one sample.', operation);
  }
  const epoch = options.epoch ?? DEFAULT_EPOCH;
  // 提前校验 epoch，避免生成出无法解析的文档。
  toIsoString(epoch, 0);

  const ordered = [...samples].sort((left, right) => left.timeSeconds - right.timeSeconds);
  const cartographicDegrees: number[] = [];
  // 逐条按运行时未知输入校验：JS 调用方可能传入缺字段的采样。
  for (const entry of ordered as readonly unknown[]) {
    const sample = (entry ?? {}) as Partial<CzmlTimestampedPosition>;
    const timeSeconds = sample.timeSeconds;
    const { longitude, latitude, height = 0 } = (sample.position ?? {}) as Partial<GeoPosition>;
    if (
      !finiteNumber(timeSeconds) ||
      !finiteNumber(longitude) ||
      !finiteNumber(latitude) ||
      !finiteNumber(height)
    ) {
      throw czmlError(
        'CZML samples must contain finite time and WGS84 position values.',
        operation,
      );
    }
    cartographicDegrees.push(timeSeconds, longitude, latitude, height);
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) {
    throw czmlError('CZML export requires at least one sample.', operation);
  }
  const staticPosition = ordered.length === 1;
  const entity: Record<string, unknown> = {
    id: entityId,
    position: {
      epoch,
      cartographicDegrees: staticPosition ? cartographicDegrees.slice(1) : cartographicDegrees,
    },
  };
  if (options.name !== undefined) {
    entity.name = options.name;
  }
  if (options.model) {
    entity.model = buildModelPacket(options.model, operation);
  }
  if (!staticPosition && options.availability !== false) {
    entity.availability = `${toIsoString(epoch, first.timeSeconds)}/${toIsoString(epoch, last.timeSeconds)}`;
  }

  const document: Record<string, unknown> = { id: 'document', version: '1.0' };
  if (!staticPosition) {
    const interval = `${toIsoString(epoch, first.timeSeconds)}/${toIsoString(epoch, last.timeSeconds)}`;
    document.clock = { interval, currentTime: toIsoString(epoch, first.timeSeconds) };
  }
  return [document, entity];
}

/** 校验并构造 `model` 报文。 */
function buildModelPacket(model: CzmlModelOptions, operation: string): Record<string, unknown> {
  const url = typeof model.url === 'string' ? model.url.trim() : '';
  if (!url) {
    throw czmlError('CZML model url must be a non-empty string.', operation);
  }
  const minimumPixelSize = model.minimumPixelSize ?? DEFAULT_MINIMUM_PIXEL_SIZE;
  if (!finiteNumber(minimumPixelSize) || minimumPixelSize <= 0) {
    throw czmlError('CZML model minimumPixelSize must be a positive finite number.', operation);
  }
  const packet: Record<string, unknown> = { gltf: url, minimumPixelSize };
  if (model.scale !== undefined) {
    if (!finiteNumber(model.scale) || model.scale <= 0) {
      throw czmlError('CZML model scale must be a positive finite number.', operation);
    }
    packet.scale = model.scale;
  }
  return packet;
}

/**
 * 读取 `orientation.unitQuaternion`：4 个值为静态姿态，5 的整数倍为 `[时间, x, y, z, w]` 采样。
 *
 * 模长过小的四元数视为非法；其余按单位四元数归一化后返回，避免下游姿态积分被非单位四元数污染。
 */
function readOrientations(
  orientation: unknown,
  epoch: string,
  operation: string,
): { timeSeconds: number; quaternion: Quaternion }[] {
  if (orientation === undefined || !isRecord(orientation)) {
    return [];
  }
  if (orientation.unitQuaternion === undefined) {
    // velocityReference、unitQuaternion 之外的姿态形式不在最小集内：忽略而不是拒收整份文档。
    return [];
  }
  if (!isArray(orientation.unitQuaternion)) {
    throw czmlError('CZML orientation.unitQuaternion must be an array.', operation);
  }
  const values = orientation.unitQuaternion;
  const packetEpoch = typeof orientation.epoch === 'string' ? orientation.epoch : epoch;
  const offsetSeconds = epochOffsetSeconds(packetEpoch, epoch, operation);
  if (values.length === 4) {
    return [{ timeSeconds: 0, quaternion: toQuaternion(values, operation) }];
  }
  if (values.length === 0 || values.length % 5 !== 0) {
    throw czmlError('CZML orientation samples must be [time, x, y, z, w] entries.', operation);
  }
  const result: { timeSeconds: number; quaternion: Quaternion }[] = [];
  for (let index = 0; index < values.length; index += 5) {
    const stamp = values[index];
    const timeSeconds =
      typeof stamp === 'string'
        ? (Date.parse(stamp) - Date.parse(epoch)) / 1000
        : finiteNumber(stamp)
          ? stamp + offsetSeconds
          : Number.NaN;
    if (!finiteNumber(timeSeconds)) {
      throw czmlError('CZML orientation sample time is not a finite second value.', operation);
    }
    result.push({
      timeSeconds,
      quaternion: toQuaternion(values.slice(index + 1, index + 5), operation),
    });
  }
  return result;
}

/** 归一化一个单位四元数；模长过小时抛错。 */
function toQuaternion(values: readonly unknown[], operation: string): Quaternion {
  const [x, y, z, w] = values;
  if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(z) || !finiteNumber(w)) {
    throw czmlError('CZML quaternion components must be finite numbers.', operation);
  }
  const norm = Math.hypot(x, y, z, w);
  if (!(norm > 1e-6)) {
    throw czmlError('CZML quaternion has a near-zero norm.', operation);
  }
  return { x: x / norm, y: y / norm, z: z / norm, w: w / norm };
}

/** 计算包级 epoch 与文档 epoch 的秒差。 */
function epochOffsetSeconds(packetEpoch: string, epoch: string, operation: string): number {
  if (packetEpoch === epoch) {
    return 0;
  }
  const offset = (Date.parse(packetEpoch) - Date.parse(epoch)) / 1000;
  if (!finiteNumber(offset)) {
    throw czmlError(`CZML epoch "${packetEpoch}" is not a valid ISO date.`, operation);
  }
  return offset;
}

/**
 * 由等间隔点位生成 CZML 文档。
 *
 * 这是 {@link czmlFromSamples} 的便捷形式：按 `intervalSeconds` 为每个点位推算时间。
 *
 * @param id - 实体 id。
 * @param positions - WGS84 经纬高点位；1 个点时生成静态位置。
 * @param options - epoch、采样间隔、起始秒数、名称与 availability 开关。
 * @returns CZML 文档（包数组）。
 * @throws `INVALID_CZML` 参数非法。
 */
export function czmlFromPositions(
  id: string,
  positions: readonly GeoPosition[],
  options: CzmlExportOptions = {},
): CzmlDocument {
  const intervalSeconds = options.intervalSeconds ?? 1;
  const startSeconds = options.startSeconds ?? 0;
  if (!finiteNumber(intervalSeconds) || intervalSeconds <= 0) {
    throw czmlError('CZML intervalSeconds must be a positive finite number.', 'czmlFromPositions');
  }
  if (!finiteNumber(startSeconds) || startSeconds < 0) {
    throw czmlError('CZML startSeconds must be a non-negative finite number.', 'czmlFromPositions');
  }
  if (!isArray(positions) || positions.length === 0) {
    throw czmlError('CZML export requires at least one position.', 'czmlFromPositions');
  }

  const samples = positions.map((position, index) => ({
    timeSeconds: startSeconds + index * intervalSeconds,
    position,
  }));
  return czmlFromSamples(id, samples, options);
}

/**
 * 从 CZML 文档解析轨迹。
 *
 * 读取 `position.cartographicDegrees`、`orientation.unitQuaternion`、`model.gltf` 与
 * `availability`；`billboard`、`label`、`path` 等属性原样忽略，便于用同一份文档驱动 SDK
 * 自己的图层。没有位置信息的包会被跳过，只有姿态的包同样跳过（姿态要挂在位置上才有意义）。
 *
 * @param document - CZML 包数组。
 * @param options - 覆盖 epoch。
 * @returns 轨迹，顺序与文档中的实体顺序一致。
 * @throws `INVALID_CZML` 文档结构、时间戳、位置、姿态或 availability 非法。
 */
export function tracksFromCzml(
  document: unknown,
  options: CzmlImportOptions = {},
): readonly CzmlTrack[] {
  const operation = 'tracksFromCzml';
  if (!isArray(document)) {
    throw czmlError('CZML document must be an array of packets.', operation);
  }
  const packets = document as readonly Record<string, unknown>[];
  const epoch = options.epoch ?? resolveEpoch(packets) ?? DEFAULT_EPOCH;
  if (!Number.isFinite(Date.parse(epoch))) {
    throw czmlError(`CZML epoch "${epoch}" is not a valid ISO date.`, operation);
  }

  const tracks: CzmlTrack[] = [];
  for (const packet of packets) {
    if (!isRecord(packet) || packet.id === 'document') {
      continue;
    }
    const id = typeof packet.id === 'string' ? packet.id.trim() : '';
    if (!id) {
      throw czmlError('CZML entity packets must have a non-empty string id.', operation);
    }
    const positions = readPosition(packet.position, epoch, operation);
    if (positions.length === 0) {
      continue;
    }
    const orientations = readOrientations(packet.orientation, epoch, operation);
    tracks.push({
      id,
      name: typeof packet.name === 'string' ? packet.name : undefined,
      epoch,
      modelUrl: readModelUrl(packet.model),
      samples: positions.map((sample) => ({
        timeSeconds: sample.timeSeconds,
        position: sample.position,
        attitude: attitudeAt(orientations, sample.timeSeconds),
      })),
      availability: readAvailability(packet.availability, epoch, operation),
    });
  }
  return tracks;
}

/**
 * 取时刻上最接近的姿态采样；没有完全匹配时返回 `undefined`。
 *
 * 只做精确匹配：位置与姿态两组采样通常同频写入，做插值会给"姿态来自哪一帧"留下歧义，
 * 需要插值的调用方可以用 `@yanbobo/gis-sdk/core` 的 `AttitudeDynamics` 自行推进。
 */
function attitudeAt(
  orientations: readonly { timeSeconds: number; quaternion: Quaternion }[],
  timeSeconds: number,
): Quaternion | undefined {
  const match = orientations.find((entry) => Math.abs(entry.timeSeconds - timeSeconds) < 1e-6);
  return match ? { ...match.quaternion } : undefined;
}

/** 读取 `model.gltf`；没有 model 报文或地址非字符串时返回 `undefined`。 */
function readModelUrl(model: unknown): string | undefined {
  if (!isRecord(model)) {
    return undefined;
  }
  const url = model.gltf;
  return typeof url === 'string' && url.trim().length > 0 ? url : undefined;
}

/**
 * 从 CZML 文档解析位置轨迹。
 *
 * 只保留位置与可用区间；需要姿态或模型地址时用 {@link tracksFromCzml}。
 * `billboard`、`label`、`model` 的渲染参数等属性原样忽略，便于用同一份文档驱动 SDK 自己的图层。
 *
 * @param document - CZML 包数组。
 * @param options - 覆盖 epoch。
 * @returns 位置轨迹，顺序与文档中的实体顺序一致。
 * @throws `INVALID_CZML` 文档结构、时间戳、位置或 availability 非法。
 */
export function positionsFromCzml(
  document: unknown,
  options: CzmlImportOptions = {},
): readonly CzmlPositionTrack[] {
  return tracksFromCzml(document, options).map((track) => ({
    id: track.id,
    name: track.name,
    epoch: track.epoch,
    samples: track.samples.map((sample) => ({
      timeSeconds: sample.timeSeconds,
      position: sample.position,
    })),
    availability: track.availability,
  }));
}
