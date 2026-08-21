import type { DataPipeline } from './data-pipeline.js';
import { GisError } from './errors.js';
import { EventHub } from './event-hub.js';

/** 提供可取消动画帧回调的最小运行时接口。 */
export interface DataPipelineFrameClock {
  /** 请求下一帧并返回可用于取消的句柄。 */
  request(callback: FrameRequestCallback): number;
  /** 取消尚未执行的帧回调。 */
  cancel(handle: number): void;
}

/** 帧预算调度器的生命周期状态。 */
export type DataPipelineFrameSchedulerState = 'idle' | 'scheduled' | 'disposed';

/** 帧预算调度器的冻结统计快照。 */
export interface DataPipelineFrameSchedulerStats {
  /** 调用 `request()` 的次数，包括被合并的请求。 */
  readonly requests: number;
  /** 因已有挂起帧而被合并的请求次数。 */
  readonly coalesced: number;
  /** 实际注册的帧回调数量。 */
  readonly scheduled: number;
  /** 成功完成的有数据帧数量。 */
  readonly completed: number;
  /** 已交给业务回调的输入总数。 */
  readonly consumed: number;
  /** 管线读取或业务回调失败的帧数量。 */
  readonly failed: number;
  /** 当前调度器状态。 */
  readonly state: DataPipelineFrameSchedulerState;
}

/** 帧预算调度器事件映射。 */
export interface DataPipelineFrameSchedulerEventMap {
  /** 调度器生命周期状态变化。 */
  'state:changed': {
    /** 变化前状态。 */
    readonly previous: DataPipelineFrameSchedulerState;
    /** 变化后状态。 */
    readonly state: DataPipelineFrameSchedulerState;
  };
  /** 一帧成功交付了一个非空批次。 */
  'frame:completed': {
    /** 本帧交付的输入数量。 */
    readonly count: number;
    /** 浏览器或宿主提供的帧时间戳。 */
    readonly timestamp: number;
  };
  /** 数据管线读取或业务批次回调失败。 */
  'frame:failed': {
    /** 原始失败原因。 */
    readonly cause: unknown;
    /** 浏览器或宿主提供的帧时间戳。 */
    readonly timestamp: number;
  };
}

/** 创建帧预算调度器的配置。 */
export interface DataPipelineFrameSchedulerOptions<T> {
  /** 调度器从中批量读取的调用方数据管线。 */
  readonly pipeline: DataPipeline<T>;
  /** 每帧最多交付的输入条数，默认 200。 */
  readonly maxItemsPerFrame?: number;
  /** 每帧在主线程执行的业务回调。 */
  readonly onBatch: (values: readonly T[]) => void;
  /** 可选时钟；省略时使用浏览器的 animation frame API。 */
  readonly clock?: DataPipelineFrameClock;
}

interface MutableStats {
  requests: number;
  coalesced: number;
  scheduled: number;
  completed: number;
  consumed: number;
  failed: number;
}

function invalidConfig(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_DATA_PIPELINE_FRAME_SCHEDULER_CONFIG',
    module: 'data-pipeline-frame-scheduler',
    operation: 'create',
  });
}

function disposed(): GisError {
  return new GisError('Data pipeline frame scheduler has been disposed.', {
    code: 'DATA_PIPELINE_FRAME_SCHEDULER_DISPOSED',
    module: 'data-pipeline-frame-scheduler',
    operation: 'request',
  });
}

function unavailable(): GisError {
  return new GisError('Animation frame scheduling is not available in this runtime.', {
    code: 'DATA_PIPELINE_FRAME_SCHEDULER_UNAVAILABLE',
    module: 'data-pipeline-frame-scheduler',
    operation: 'request',
    retryable: true,
  });
}

function browserClock(): DataPipelineFrameClock | undefined {
  if (
    typeof globalThis.requestAnimationFrame !== 'function' ||
    typeof globalThis.cancelAnimationFrame !== 'function'
  ) {
    return undefined;
  }
  return {
    request: (callback) => globalThis.requestAnimationFrame(callback),
    cancel: (handle) => {
      globalThis.cancelAnimationFrame(handle);
    },
  };
}

/**
 * 将 `DataPipeline` 消费限制在每帧固定预算内的框架无关调度器。
 *
 * 调用方负责在新数据入队时请求调度，并拥有管线、输入源和渲染资源。
 */
export class DataPipelineFrameScheduler<T> {
  /** 订阅状态变化、成功批次和帧失败。 */
  readonly events = new EventHub<DataPipelineFrameSchedulerEventMap>();

  private readonly pipeline: DataPipeline<T>;
  private readonly maxItemsPerFrame: number;
  private readonly onBatch: (values: readonly T[]) => void;
  private readonly clock: DataPipelineFrameClock | undefined;
  private readonly statsState: MutableStats = {
    requests: 0,
    coalesced: 0,
    scheduled: 0,
    completed: 0,
    consumed: 0,
    failed: 0,
  };
  private pendingHandle: number | undefined;
  private currentState: DataPipelineFrameSchedulerState = 'idle';

  constructor(options: DataPipelineFrameSchedulerOptions<T>) {
    const externalOptions: unknown = options;
    if (typeof externalOptions !== 'object' || externalOptions === null) {
      throw invalidConfig('Data pipeline frame scheduler options must be an object.');
    }

    const candidate = externalOptions as {
      readonly pipeline?: unknown;
      readonly maxItemsPerFrame?: unknown;
      readonly onBatch?: unknown;
      readonly clock?: unknown;
    };
    if (
      typeof candidate.pipeline !== 'object' ||
      candidate.pipeline === null ||
      typeof (candidate.pipeline as { readonly take?: unknown }).take !== 'function' ||
      typeof (candidate.pipeline as { readonly stats?: unknown }).stats !== 'object'
    ) {
      throw invalidConfig('Data pipeline frame scheduler pipeline must support take() and stats.');
    }
    if (typeof candidate.onBatch !== 'function') {
      throw invalidConfig('Data pipeline frame scheduler onBatch must be a function.');
    }
    const maxItemsPerFrame = options.maxItemsPerFrame ?? 200;
    if (!Number.isSafeInteger(maxItemsPerFrame) || maxItemsPerFrame < 1) {
      throw invalidConfig(
        'Data pipeline frame scheduler maxItemsPerFrame must be a positive safe integer.',
      );
    }
    if (
      candidate.clock !== undefined &&
      (typeof candidate.clock !== 'object' ||
        candidate.clock === null ||
        typeof (candidate.clock as { readonly request?: unknown }).request !== 'function' ||
        typeof (candidate.clock as { readonly cancel?: unknown }).cancel !== 'function')
    ) {
      throw invalidConfig(
        'Data pipeline frame scheduler clock must support request() and cancel().',
      );
    }

    this.pipeline = options.pipeline;
    this.maxItemsPerFrame = maxItemsPerFrame;
    this.onBatch = options.onBatch;
    this.clock = options.clock ?? browserClock();
  }

  /** 当前调度器状态。 */
  get state(): DataPipelineFrameSchedulerState {
    return this.currentState;
  }

  /** 返回冻结的调度统计快照。 */
  get stats(): Readonly<DataPipelineFrameSchedulerStats> {
    return Object.freeze({
      coalesced: this.statsState.coalesced,
      completed: this.statsState.completed,
      consumed: this.statsState.consumed,
      failed: this.statsState.failed,
      requests: this.statsState.requests,
      scheduled: this.statsState.scheduled,
      state: this.currentState,
    });
  }

  /** 请求一次帧消费。已有挂起帧时返回 false 且不额外注册回调。 */
  request(): boolean {
    this.assertActive();
    this.statsState.requests += 1;
    if (this.pendingHandle !== undefined) {
      this.statsState.coalesced += 1;
      return false;
    }
    if (!this.clock) {
      throw unavailable();
    }

    const handle = this.clock.request((timestamp) => {
      if (this.pendingHandle !== handle) {
        return;
      }
      this.pendingHandle = undefined;
      this.transition('idle');
      this.runFrame(timestamp);
    });
    this.pendingHandle = handle;
    this.statsState.scheduled += 1;
    this.transition('scheduled');
    return true;
  }

  /** 取消尚未执行的帧；不会读取或关闭调用方数据管线。 */
  cancel(): boolean {
    if (this.pendingHandle === undefined) {
      return false;
    }
    this.clock?.cancel(this.pendingHandle);
    this.pendingHandle = undefined;
    if (this.currentState !== 'disposed') {
      this.transition('idle');
    }
    return true;
  }

  /** 取消挂起帧并永久关闭调度器；不会关闭调用方数据管线。 */
  dispose(): void {
    if (this.currentState === 'disposed') {
      return;
    }
    this.cancel();
    this.transition('disposed');
    this.events.clear();
  }

  private runFrame(timestamp: number): void {
    if (this.currentState === 'disposed') {
      return;
    }
    try {
      const values = this.pipeline.take(this.maxItemsPerFrame);
      if (values.length === 0) {
        return;
      }
      this.statsState.consumed += values.length;
      this.onBatch(values);
      this.statsState.completed += 1;
      this.emit('frame:completed', { count: values.length, timestamp });
      if (this.pipeline.stats.queued > 0) {
        this.request();
      }
    } catch (cause: unknown) {
      this.statsState.failed += 1;
      this.emit('frame:failed', { cause, timestamp });
    }
  }

  private assertActive(): void {
    if (this.currentState === 'disposed') {
      throw disposed();
    }
  }

  private transition(state: DataPipelineFrameSchedulerState): void {
    if (state === this.currentState) {
      return;
    }
    const previous = this.currentState;
    this.currentState = state;
    this.emit('state:changed', { previous, state });
  }

  private emit<TKey extends keyof DataPipelineFrameSchedulerEventMap>(
    type: TKey,
    event: DataPipelineFrameSchedulerEventMap[TKey],
  ): void {
    try {
      this.events.emit(type, event);
    } catch {
      // Consumer listeners must not change scheduling or lifecycle outcomes.
    }
  }
}
