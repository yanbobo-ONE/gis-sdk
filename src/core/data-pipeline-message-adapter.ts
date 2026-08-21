import { GisError } from './errors.js';
import { EventHub } from './event-hub.js';
import type { DataPipeline } from './data-pipeline.js';

/** 可由 Worker、MessagePort 或同类对象实现的最小消息源接口。 */
export interface DataPipelineMessageSource {
  /** 注册消息监听器。 */
  addEventListener(type: 'message', listener: EventListener): void;
  /** 移除此前注册的消息监听器。 */
  removeEventListener(type: 'message', listener: EventListener): void;
  /** MessagePort 可选的显式启动方法。Worker 不需要实现。 */
  start?(): void;
}

/** 消息输入适配器的生命周期状态。 */
export type DataPipelineMessageAdapterState = 'idle' | 'running' | 'disposed';

/** 消息输入接入统计快照。 */
export interface DataPipelineMessageAdapterStats {
  /** 适配器接收到的消息数量。 */
  readonly received: number;
  /** 已成功进入数据管线的消息数量。 */
  readonly accepted: number;
  /** 被数据管线满队列策略丢弃的消息数量。 */
  readonly dropped: number;
  /** 解码或写入数据管线失败的消息数量。 */
  readonly rejected: number;
  /** 当前适配器状态。 */
  readonly state: DataPipelineMessageAdapterState;
}

/** 适配器事件映射。 */
export interface DataPipelineMessageAdapterEventMap {
  /** 适配器状态变化。 */
  'state:changed': {
    /** 变化前的生命周期状态。 */
    readonly previous: DataPipelineMessageAdapterState;
    /** 变化后的生命周期状态。 */
    readonly state: DataPipelineMessageAdapterState;
  };
  /** 解码成功且已进入数据管线。 */
  'message:accepted': {
    /** 已成功进入数据管线的原始消息载荷。 */
    readonly data: unknown;
  };
  /** 解码或写入数据管线失败；后续消息会继续处理。 */
  'message:rejected': {
    /** 被拒绝消息的原始载荷。 */
    readonly data: unknown;
    /** 解码函数或数据管线抛出的原始异常。 */
    readonly cause: unknown;
  };
  /** 解码成功但被数据管线满队列策略丢弃。 */
  'message:dropped': {
    /** 被满队列策略拒绝的原始消息载荷。 */
    readonly data: unknown;
  };
}

/** 创建消息输入适配器的配置。 */
export interface DataPipelineMessageAdapterOptions<T> {
  /** 调用方拥有的 Worker、MessagePort 或同类消息源。 */
  readonly source: DataPipelineMessageSource;
  /** 用于合并、限流和批量读取的调用方数据管线。 */
  readonly pipeline: DataPipeline<T>;
  /** 将原始消息载荷转换为数据管线输入。 */
  readonly decode: (data: unknown) => T;
}

interface MutableStats {
  received: number;
  accepted: number;
  dropped: number;
  rejected: number;
}

function invalidConfig(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_DATA_PIPELINE_MESSAGE_ADAPTER_CONFIG',
    module: 'data-pipeline-message-adapter',
    operation: 'create',
  });
}

function disposed(): GisError {
  return new GisError('Data pipeline message adapter has been disposed.', {
    code: 'DATA_PIPELINE_MESSAGE_ADAPTER_DISPOSED',
    module: 'data-pipeline-message-adapter',
    operation: 'start',
  });
}

/**
 * 将外部消息源接入有界 `DataPipeline` 的框架无关适配器。
 *
 * 调用方负责消息源、协议、Worker 终止和渲染资源；本适配器只拥有其注册的监听器。
 */
export class DataPipelineMessageAdapter<T> {
  /** 订阅状态变化、消息接入、拒绝和满队列丢弃事件。 */
  readonly events = new EventHub<DataPipelineMessageAdapterEventMap>();

  private readonly source: DataPipelineMessageSource;
  private readonly pipeline: DataPipeline<T>;
  private readonly decode: (data: unknown) => T;
  private readonly statsState: MutableStats = {
    received: 0,
    accepted: 0,
    dropped: 0,
    rejected: 0,
  };
  private currentState: DataPipelineMessageAdapterState = 'idle';
  private readonly handleMessage: EventListener = (event) => {
    this.receive((event as MessageEvent<unknown>).data);
  };

  constructor(options: DataPipelineMessageAdapterOptions<T>) {
    const externalOptions: unknown = options;
    if (typeof externalOptions !== 'object' || externalOptions === null) {
      throw invalidConfig('Data pipeline message adapter options must be an object.');
    }

    const candidate = externalOptions as {
      readonly source?: unknown;
      readonly pipeline?: unknown;
      readonly decode?: unknown;
    };
    if (
      typeof candidate.source !== 'object' ||
      candidate.source === null ||
      typeof (candidate.source as { readonly addEventListener?: unknown }).addEventListener !==
        'function' ||
      typeof (candidate.source as { readonly removeEventListener?: unknown })
        .removeEventListener !== 'function'
    ) {
      throw invalidConfig('Data pipeline message adapter source must support message listeners.');
    }
    if (
      typeof candidate.pipeline !== 'object' ||
      candidate.pipeline === null ||
      typeof (candidate.pipeline as { readonly push?: unknown }).push !== 'function'
    ) {
      throw invalidConfig('Data pipeline message adapter pipeline must support push().');
    }
    if (typeof candidate.decode !== 'function') {
      throw invalidConfig('Data pipeline message adapter decode must be a function.');
    }

    this.source = options.source;
    this.pipeline = options.pipeline;
    this.decode = options.decode;
  }

  /** 当前是否在接收消息。 */
  get state(): DataPipelineMessageAdapterState {
    return this.currentState;
  }

  /** 返回冻结的输入统计快照。 */
  get stats(): Readonly<DataPipelineMessageAdapterStats> {
    return Object.freeze({
      accepted: this.statsState.accepted,
      dropped: this.statsState.dropped,
      received: this.statsState.received,
      rejected: this.statsState.rejected,
      state: this.currentState,
    });
  }

  /** 注册消息监听器并启动 MessagePort；重复调用无副作用。 */
  start(): void {
    if (this.currentState === 'disposed') {
      throw disposed();
    }
    if (this.currentState === 'running') {
      return;
    }

    this.source.addEventListener('message', this.handleMessage);
    this.transition('running');
    try {
      this.source.start?.();
    } catch (cause: unknown) {
      this.source.removeEventListener('message', this.handleMessage);
      this.transition('idle');
      throw new GisError('Failed to start the data pipeline message source.', {
        code: 'INVALID_DATA_PIPELINE_MESSAGE_ADAPTER_CONFIG',
        module: 'data-pipeline-message-adapter',
        operation: 'start',
        retryable: true,
        cause,
      });
    }
  }

  /** 停止接收消息并解绑监听器；不会终止调用方拥有的消息源。 */
  stop(): void {
    if (this.currentState !== 'running') {
      return;
    }
    this.source.removeEventListener('message', this.handleMessage);
    this.transition('idle');
  }

  /** 解绑监听器并永久关闭适配器；不会关闭调用方的数据管线或消息源。 */
  dispose(): void {
    if (this.currentState === 'disposed') {
      return;
    }
    this.stop();
    this.transition('disposed');
    this.events.clear();
  }

  private receive(data: unknown): void {
    if (this.currentState !== 'running') {
      return;
    }
    this.statsState.received += 1;
    try {
      const value = this.decode(data);
      if (this.pipeline.push(value)) {
        this.statsState.accepted += 1;
        this.emit('message:accepted', { data });
      } else {
        this.statsState.dropped += 1;
        this.emit('message:dropped', { data });
      }
    } catch (cause: unknown) {
      this.statsState.rejected += 1;
      this.emit('message:rejected', { data, cause });
    }
  }

  private transition(state: DataPipelineMessageAdapterState): void {
    if (state === this.currentState) {
      return;
    }
    const previous = this.currentState;
    this.currentState = state;
    this.emit('state:changed', { previous, state });
  }

  private emit<TKey extends keyof DataPipelineMessageAdapterEventMap>(
    type: TKey,
    event: DataPipelineMessageAdapterEventMap[TKey],
  ): void {
    try {
      this.events.emit(type, event);
    } catch {
      // Consumer listeners must not change ingestion or cleanup behavior.
    }
  }
}
