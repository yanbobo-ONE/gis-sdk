import { GisError } from './errors.js';

/** 单条位置样本；`timestamp` 使用仿真时间，单位为毫秒。 */
export interface PositionSample {
  /** 对象标识；同一个 id 的样本在 `latest` 模式下合并。 */
  readonly id: string;
  /** 经度，范围 -180 到 180。 */
  readonly longitude: number;
  /** 纬度，范围 -90 到 90。 */
  readonly latitude: number;
  /** 椭球高，单位为米，默认 0。 */
  readonly height?: number;
  /** 仿真时间戳，单位为毫秒。 */
  readonly timestamp: number;
}

/** 合并策略。 */
export type PositionBatchMode = 'latest' | 'history';

/** `normalizePositions` 的配置。 */
export interface PositionBatchOptions {
  /**
   * 合并策略，默认 `'latest'`。
   *
   * `'latest'` 按 id 只保留时间戳最新的一条（高频状态下位置会被覆盖）；
   * `'history'` 保留全部有效样本，用于轨迹与回放。
   */
  readonly mode?: PositionBatchMode;
  /** 单次输入样本数上限，默认 50000。 */
  readonly maxSamples?: number;
}

/** 归一化后的位置批量；两个 `Float64Array` 可以直接跨线程转移。 */
export interface PositionBatch {
  /** 与 `positions` / `timestamps` 下标一一对应的对象标识。 */
  readonly ids: readonly string[];
  /** 交错存放的经纬高：每 3 个值为一组，可直接 transfer 给 Worker 或渲染层。 */
  readonly positions: Float64Array;
  /** 每个样本的仿真时间戳。 */
  readonly timestamps: Float64Array;
  /** 收到的样本数。 */
  readonly received: number;
  /** 被丢弃的样本数：id 非法、坐标非有限值、超出经纬范围，或被更新的同 id 样本覆盖。 */
  readonly invalid: number;
}

const DEFAULT_MAX_SAMPLES = 50_000;

function invalidInput(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_REALTIME_INPUT',
    module: 'realtime',
    operation: 'normalizePositions',
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 把原始位置样本归一化成可直接渲染或跨线程传递的批量。
 *
 * 这一步解决两件事：**无效坐标不带进渲染层**（非有限值、越界），以及
 * **高频"最新位置"不重复堆积**（同一 id 只留最新一条）。输出的两个
 * `Float64Array` 是转移友好的：在 Worker 中 `postMessage(batch, [batch.positions.buffer, batch.timestamps.buffer])`
 * 即可零拷贝传回主线程，避免把业务对象或渲染对象跨线程结构化克隆。
 *
 * @param samples - 原始样本。
 * @param options - 合并策略与上限。
 * @returns 归一化后的批量；`ids`、`positions`、`timestamps` 下标一致。
 * @throws `INVALID_REALTIME_INPUT` 输入不是数组、超过上限，或策略取值不受支持。
 */
export function normalizePositions(
  samples: readonly PositionSample[],
  options: PositionBatchOptions = {},
): PositionBatch {
  if (!Array.isArray(samples)) {
    throw invalidInput('Position samples must be an array.');
  }
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 1) {
    throw invalidInput('Position maxSamples must be a positive safe integer.');
  }
  if (samples.length > maxSamples) {
    throw invalidInput(`Position batch accepts at most ${String(maxSamples)} samples per call.`);
  }
  // 类型上只有两个取值，运行时（JS 调用方）仍可能传入别的字符串。
  const requestedMode: unknown = options.mode ?? 'latest';
  if (requestedMode !== 'latest' && requestedMode !== 'history') {
    throw invalidInput('Position batch mode must be latest or history.');
  }
  const mode: PositionBatchMode = requestedMode;

  let invalid = 0;
  const history: PositionSample[] = [];
  const latest = new Map<string, PositionSample>();

  for (const entry of samples as readonly unknown[]) {
    const sample = (entry ?? {}) as Partial<PositionSample>;
    const { id } = sample;
    const height = sample.height ?? 0;
    if (
      typeof id !== 'string' ||
      id.trim() === '' ||
      !finite(sample.longitude) ||
      !finite(sample.latitude) ||
      !finite(height) ||
      !finite(sample.timestamp) ||
      Math.abs(sample.longitude) > 180 ||
      Math.abs(sample.latitude) > 90
    ) {
      invalid += 1;
      continue;
    }
    const normalized: PositionSample = {
      id,
      longitude: sample.longitude,
      latitude: sample.latitude,
      height,
      timestamp: sample.timestamp,
    };
    if (mode === 'history') {
      history.push(normalized);
      continue;
    }
    const previous = latest.get(id);
    if (!previous || previous.timestamp <= normalized.timestamp) {
      if (previous) {
        invalid += 1;
      }
      latest.set(id, normalized);
    } else {
      invalid += 1;
    }
  }

  const values = mode === 'history' ? history : [...latest.values()];
  const positions = new Float64Array(values.length * 3);
  const timestamps = new Float64Array(values.length);
  const ids = new Array<string>(values.length);
  values.forEach((sample, index) => {
    positions.set([sample.longitude, sample.latitude, sample.height ?? 0], index * 3);
    timestamps[index] = sample.timestamp;
    ids[index] = sample.id;
  });

  return { ids, positions, timestamps, received: samples.length, invalid };
}
