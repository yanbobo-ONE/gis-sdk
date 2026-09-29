import type { GeoPosition } from './controls.js';
import { GisError } from './errors.js';

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
}

/** 可用区间，单位为相对 epoch 的秒数。 */
export interface CzmlAvailabilityInterval {
  /** 起始秒数。 */
  readonly startSeconds: number;
  /** 结束秒数。 */
  readonly endSeconds: number;
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
 * 从 CZML 文档解析位置轨迹。
 *
 * 只读取 `position.cartographicDegrees` 与 `availability`：`billboard`、`label`、`model`
 * 等属性原样忽略，便于用同一份文档驱动 SDK 自己的图层。没有位置信息的包会被跳过。
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
  const operation = 'positionsFromCzml';
  if (!isArray(document)) {
    throw czmlError('CZML document must be an array of packets.', operation);
  }
  const packets = document as readonly Record<string, unknown>[];
  const epoch = options.epoch ?? resolveEpoch(packets) ?? DEFAULT_EPOCH;
  if (!Number.isFinite(Date.parse(epoch))) {
    throw czmlError(`CZML epoch "${epoch}" is not a valid ISO date.`, operation);
  }

  const tracks: CzmlPositionTrack[] = [];
  for (const packet of packets) {
    if (!isRecord(packet) || packet.id === 'document') {
      continue;
    }
    const id = typeof packet.id === 'string' ? packet.id.trim() : '';
    if (!id) {
      throw czmlError('CZML entity packets must have a non-empty string id.', operation);
    }
    const samples = readPosition(packet.position, epoch, operation);
    if (samples.length === 0) {
      continue;
    }
    tracks.push({
      id,
      name: typeof packet.name === 'string' ? packet.name : undefined,
      epoch,
      samples,
      availability: readAvailability(packet.availability, epoch, operation),
    });
  }
  return tracks;
}
