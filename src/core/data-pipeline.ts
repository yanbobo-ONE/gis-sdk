import { GisError } from './errors.js';

/** 同一键的输入在队列中如何处理。 */
export type DataPipelineCoalesce = 'none' | 'latest';

/** 输入快于消费时的有界队列策略。 */
export type DataPipelineOverflow = 'drop-oldest' | 'drop-newest' | 'keep-latest';

/** 数据管线创建配置。 */
export interface DataPipelineOptions<T> {
  /** 从输入值中取出非空、稳定的合并键。 */
  readonly keyBy: (value: T) => string;
  /** 队列容量，默认 1000。 */
  readonly maxQueueItems?: number;
  /** 同键更新策略，默认保留最新值。 */
  readonly coalesce?: DataPipelineCoalesce;
  /** 队列满时的处理策略，默认优先保留最新数据。 */
  readonly overflow?: DataPipelineOverflow;
}

/** 数据管线的只读运行统计。 */
export interface DataPipelineStats {
  /** 已接收并进入处理流程的输入数量。 */
  readonly accepted: number;
  /** 同键输入替换旧排队值的次数。 */
  readonly coalesced: number;
  /** 因容量限制被丢弃的输入数量。 */
  readonly dropped: number;
  /** 当前等待被消费者读取的条数。 */
  readonly queued: number;
  /** 已从管线交付给消费者的条数。 */
  readonly taken: number;
  /** 管线是否已经关闭。 */
  readonly closed: boolean;
}

interface QueuedValue<T> {
  readonly key: string;
  readonly value: T;
}

interface MutableStats {
  accepted: number;
  coalesced: number;
  dropped: number;
  taken: number;
}

function invalidConfig(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_DATA_PIPELINE_CONFIG',
    module: 'data-pipeline',
    operation: 'create',
  });
}

function invalidKey(cause?: unknown): GisError {
  return new GisError('Data pipeline keys must be non-empty strings.', {
    code: 'INVALID_DATA_PIPELINE_KEY',
    module: 'data-pipeline',
    operation: 'push',
    ...(cause === undefined ? {} : { cause }),
  });
}

function closed(operation: 'push' | 'take' | 'clear'): GisError {
  return new GisError('Data pipeline has been closed.', {
    code: 'DATA_PIPELINE_CLOSED',
    module: 'data-pipeline',
    operation,
  });
}

function isCoalesce(value: unknown): value is DataPipelineCoalesce {
  return value === 'none' || value === 'latest';
}

function isOverflow(value: unknown): value is DataPipelineOverflow {
  return value === 'drop-oldest' || value === 'drop-newest' || value === 'keep-latest';
}

/**
 * 有界、框架无关的动态数据缓冲区。
 *
 * 该模块只负责更新合并、容量限制与批量交付；协议解析、Worker 调度和 Cesium 渲染由上层适配器负责。
 */
export class DataPipeline<T> {
  private readonly maxQueueItems: number;
  private readonly coalesce: DataPipelineCoalesce;
  private readonly overflow: DataPipelineOverflow;
  private readonly queue: QueuedValue<T>[] = [];
  private readonly statsState: MutableStats = {
    accepted: 0,
    coalesced: 0,
    dropped: 0,
    taken: 0,
  };
  private isClosed = false;

  constructor(private readonly options: DataPipelineOptions<T>) {
    const externalOptions: unknown = options;
    if (
      typeof externalOptions !== 'object' ||
      externalOptions === null ||
      typeof (externalOptions as { readonly keyBy?: unknown }).keyBy !== 'function'
    ) {
      throw invalidConfig('Data pipeline keyBy must be a function.');
    }

    this.maxQueueItems = options.maxQueueItems ?? 1_000;
    const coalesce: unknown = options.coalesce ?? 'latest';
    if (!isCoalesce(coalesce)) {
      throw invalidConfig('Data pipeline coalesce must be none or latest.');
    }
    const overflow: unknown =
      options.overflow ?? (coalesce === 'latest' ? 'keep-latest' : 'drop-oldest');
    if (!isOverflow(overflow)) {
      throw invalidConfig('Data pipeline overflow must be a supported policy.');
    }
    this.coalesce = coalesce;
    this.overflow = overflow;
    if (!Number.isSafeInteger(this.maxQueueItems) || this.maxQueueItems < 1) {
      throw invalidConfig('Data pipeline maxQueueItems must be a positive safe integer.');
    }
    if (this.coalesce === 'none' && this.overflow === 'keep-latest') {
      throw invalidConfig('keep-latest overflow requires latest coalescing.');
    }
  }

  /** 将一条更新送入队列。返回 false 表示输入因满队列策略被丢弃。 */
  push(value: T): boolean {
    this.assertOpen('push');
    let rawKey: string;
    try {
      rawKey = this.options.keyBy(value);
    } catch (cause: unknown) {
      throw invalidKey(cause);
    }
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key) {
      throw invalidKey();
    }

    const existingIndex = this.coalesce === 'latest' ? this.findIndex(key) : -1;
    if (existingIndex >= 0) {
      this.queue[existingIndex] = { key, value };
      this.statsState.accepted += 1;
      this.statsState.coalesced += 1;
      return true;
    }

    if (this.queue.length < this.maxQueueItems) {
      this.queue.push({ key, value });
      this.statsState.accepted += 1;
      return true;
    }

    if (this.overflow === 'drop-newest') {
      this.statsState.dropped += 1;
      return false;
    }

    this.queue.shift();
    this.queue.push({ key, value });
    this.statsState.accepted += 1;
    this.statsState.dropped += 1;
    return true;
  }

  /** 以 FIFO 顺序取出至多 maxItems 条待处理更新。 */
  take(maxItems?: number): readonly T[] {
    this.assertOpen('take');
    const limit = maxItems ?? this.queue.length;
    if (maxItems !== undefined && (!Number.isSafeInteger(maxItems) || maxItems < 1)) {
      throw new GisError('Data pipeline take limit must be a positive safe integer.', {
        code: 'INVALID_DATA_PIPELINE_TAKE_LIMIT',
        module: 'data-pipeline',
        operation: 'take',
      });
    }

    const entries = this.queue.splice(0, limit);
    this.statsState.taken += entries.length;
    return entries.map((entry) => entry.value);
  }

  /** 清空尚未交付的更新，不将其计为溢出丢弃。 */
  clear(): void {
    this.assertOpen('clear');
    this.queue.length = 0;
  }

  /** 关闭管线并释放所有尚未交付的值。重复调用无副作用。 */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.queue.length = 0;
    this.isClosed = true;
  }

  /** 返回不可变的当前统计快照。 */
  get stats(): Readonly<DataPipelineStats> {
    return Object.freeze({
      accepted: this.statsState.accepted,
      closed: this.isClosed,
      coalesced: this.statsState.coalesced,
      dropped: this.statsState.dropped,
      queued: this.queue.length,
      taken: this.statsState.taken,
    });
  }

  private findIndex(key: string): number {
    return this.queue.findIndex((entry) => entry.key === key);
  }

  private assertOpen(operation: 'push' | 'take' | 'clear'): void {
    if (this.isClosed) {
      throw closed(operation);
    }
  }
}
