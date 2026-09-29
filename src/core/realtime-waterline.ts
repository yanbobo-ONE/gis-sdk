import { GisError } from './errors.js';
import { RealtimeTimestampGuard } from './realtime-timestamp-guard.js';

/** 水位线的创建配置。 */
export interface RealtimeWaterlineOptions<T> {
  /** 取出对象标识；同键样本进入同一个有界队列。 */
  readonly keyBy: (value: T) => string;
  /** 取出仿真时间戳（毫秒）；返回 `undefined` 表示该样本不带时间戳，直接放行。 */
  readonly timeBy: (value: T) => number | undefined;
  /**
   * 判断样本是否来自"精确采样"对象。
   *
   * 这类对象（例如按时间采样的轨道点）要求共同覆盖时间，安全播放上限取它们最新时间的
   * 最小值；不提供时全部按普通对象处理。
   */
  readonly exactBy?: (value: T) => boolean;
  /** 水位线回退量，单位为毫秒，默认 1500。 */
  readonly bufferMs?: number;
  /** 超过该时长仍未发布的样本过期丢弃，单位为毫秒，默认 10000。 */
  readonly staleMs?: number;
  /** 单对象队列长度上限，默认 600。 */
  readonly maxSamplesPerKey?: number;
  /** 精确对象失活窗口，单位为毫秒，默认 10000。 */
  readonly inactiveSampleMs?: number;
  /** 断档判定窗口，单位为毫秒，默认 3000。 */
  readonly gapMs?: number;
  /** 允许领先的安全上限，单位为毫秒，默认 30000。 */
  readonly maxFutureLeadMs?: number;
  /** 单对象样本时间窗口，单位为毫秒，默认 60000。 */
  readonly sampleWindowMs?: number;
  /** 进入追赶的滞后阈值，单位为毫秒，默认 `bufferMs × 2`。 */
  readonly catchUpEnterLagMs?: number;
  /** 退出追赶的滞后阈值，单位为毫秒，默认 `bufferMs`。 */
  readonly catchUpExitLagMs?: number;
  /** 追赶倍率上限，默认 2.4。 */
  readonly maxCatchUpRate?: number;
  /** 本机时间来源，默认 `performance.now()`。 */
  readonly now?: () => number;
}

/** 水位线的运行状态。 */
export type RealtimeWaterlineState = 'buffering' | 'playing' | 'stalled' | 'disconnected';

/** 水位线状态变化的原因。 */
export type RealtimeWaterlineReason =
  | 'waiting-samples'
  | 'safe-window-ready'
  | 'sample-timeout'
  | 'transport-disconnected'
  | 'release-lag';

/** 水位线的只读统计快照。 */
export interface RealtimeWaterlineSnapshot {
  /** 当前安全播放上限（仿真时间，毫秒）；还没有样本时为 `undefined`。 */
  readonly watermark: number | undefined;
  /** 仍在队列中的样本数。 */
  readonly queuedSamples: number;
  /** 因超出过期窗口被丢弃的样本数。 */
  readonly droppedStaleSamples: number;
  /** 因超出单对象上限被丢弃的样本数。 */
  readonly droppedOverflowSamples: number;
  /** 因超出时间窗口被裁剪的样本数。 */
  readonly droppedWindowSamples: number;
  /** 被时间戳守卫隔离的异常样本数。 */
  readonly isolatedFutureSamples: number;
  /** 当前追赶倍率；未追赶时为 1。 */
  readonly catchUpRate: number;
  /** 当前运行状态。 */
  readonly state: RealtimeWaterlineState;
  /** 最后一个已发布样本的仿真时间；还没有发布过时为 `undefined`。 */
  readonly lastReleasedTimestamp: number | undefined;
  /** 已失活的精确对象数量。 */
  readonly staleExactKeys: number;
  /** 距上次收到带时间戳样本的时长，单位为毫秒。 */
  readonly gapDurationMs: number;
  /** 状态原因。 */
  readonly reason: RealtimeWaterlineReason;
}

function invalid(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_REALTIME_CONFIG',
    module: 'realtime',
    operation: 'create',
  });
}

/**
 * 实时水位线。
 *
 * 以"最新仿真时间减去缓冲量"形成可发布的播放上限，乱序到达的样本按时间排序后逐个释放，
 * 从而避免实体在乱序 Socket 消息下倒退。到达顺序、合并与丢弃都发生在纯数据层，
 * 不涉及任何 Cesium 对象。
 *
 * 关键策略（数值取自 Plugin-web 的生产初值）：
 *
 * - 水位线 = 最新时间 − `bufferMs`；存在精确对象时取它们最新时间的**最小值**再回退；
 * - 超过 `staleMs` 仍未发布的样本过期丢弃；
 * - 单对象队列同时受 `maxSamplesPerKey` 与 `sampleWindowMs` 约束；
 * - 滞后超过 `catchUpEnterLagMs` 进入追赶、低于 `catchUpExitLagMs` 退出（双阈值防抖），
 *   倍率上限 `maxCatchUpRate`；
 * - 领先超过 `maxFutureLeadMs` 的异常样本交给 {@link RealtimeTimestampGuard} 隔离。
 */
export class RealtimeWaterline<T> {
  private readonly options: RealtimeWaterlineOptions<T>;
  private readonly queues = new Map<string, T[]>();
  private readonly exactLatest = new Map<
    string,
    { readonly timestamp: number; readonly receivedAt: number }
  >();
  private readonly timestampGuard: RealtimeTimestampGuard;
  private readonly bufferMs: number;
  private readonly staleMs: number;
  private readonly maxSamplesPerKey: number;
  private readonly inactiveSampleMs: number;
  private readonly gapMs: number;
  private readonly maxFutureLeadMs: number;
  private readonly sampleWindowMs: number;
  private readonly catchUpEnterLagMs: number;
  private readonly catchUpExitLagMs: number;
  private readonly maxCatchUpRate: number;
  private readonly now: () => number;

  private latestTimestamp = Number.NEGATIVE_INFINITY;
  private lastReleasedTimestamp = Number.NEGATIVE_INFINITY;
  private lastTimestampReceivedAt: number | undefined;
  private catchUpRate = 1;
  private catchingUp = false;
  private disconnected = false;
  private droppedStaleSamples = 0;
  private droppedOverflowSamples = 0;
  private droppedWindowSamples = 0;

  constructor(options: RealtimeWaterlineOptions<T> | undefined) {
    const keyBy = options?.keyBy;
    const timeBy = options?.timeBy;
    if (typeof keyBy !== 'function' || typeof timeBy !== 'function') {
      throw invalid('Realtime waterline requires keyBy and timeBy functions.');
    }
    const resolved = { ...options, keyBy, timeBy };
    this.options = resolved;
    this.bufferMs = resolved.bufferMs ?? 1_500;
    this.staleMs = resolved.staleMs ?? 10_000;
    this.maxSamplesPerKey = resolved.maxSamplesPerKey ?? 600;
    this.inactiveSampleMs = resolved.inactiveSampleMs ?? 10_000;
    this.gapMs = resolved.gapMs ?? 3_000;
    this.maxFutureLeadMs = resolved.maxFutureLeadMs ?? 30_000;
    this.sampleWindowMs = resolved.sampleWindowMs ?? 60_000;
    this.catchUpEnterLagMs = resolved.catchUpEnterLagMs ?? this.bufferMs * 2;
    this.catchUpExitLagMs = resolved.catchUpExitLagMs ?? this.bufferMs;
    this.maxCatchUpRate = resolved.maxCatchUpRate ?? 2.4;
    this.now = resolved.now ?? (() => performance.now());

    for (const [name, value] of [
      ['bufferMs', this.bufferMs],
      ['staleMs', this.staleMs],
      ['inactiveSampleMs', this.inactiveSampleMs],
      ['gapMs', this.gapMs],
      ['maxFutureLeadMs', this.maxFutureLeadMs],
      ['sampleWindowMs', this.sampleWindowMs],
      ['catchUpEnterLagMs', this.catchUpEnterLagMs],
      ['catchUpExitLagMs', this.catchUpExitLagMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw invalid(`Realtime waterline ${name} must be a non-negative finite number.`);
      }
    }
    if (!Number.isInteger(this.maxSamplesPerKey) || this.maxSamplesPerKey < 1) {
      throw invalid('Realtime waterline maxSamplesPerKey must be a positive integer.');
    }
    if (!Number.isFinite(this.maxCatchUpRate) || this.maxCatchUpRate < 1) {
      throw invalid('Realtime waterline maxCatchUpRate must be a finite number of at least 1.');
    }
    if (this.catchUpExitLagMs > this.catchUpEnterLagMs) {
      throw invalid('Realtime waterline catchUpExitLagMs must not exceed catchUpEnterLagMs.');
    }

    this.timestampGuard = new RealtimeTimestampGuard({
      maxLeadMs: this.maxFutureLeadMs,
      gapMs: this.gapMs,
      maxCandidates: this.maxSamplesPerKey,
    });
  }

  /** 当前安全播放上限（仿真时间，毫秒）。 */
  get watermark(): number | undefined {
    return this.computeWatermark();
  }

  /** 当前追赶倍率；未追赶时为 1。 */
  get currentCatchUpRate(): number {
    return this.catchUpRate;
  }

  /** 只读统计快照。 */
  get snapshot(): RealtimeWaterlineSnapshot {
    const now = this.now();
    const gapDurationMs = Math.max(0, now - (this.lastTimestampReceivedAt ?? now));
    const watermark = this.computeWatermark();
    let queuedSamples = 0;
    for (const queue of this.queues.values()) {
      queuedSamples += queue.length;
    }
    let staleExactKeys = 0;
    for (const value of this.exactLatest.values()) {
      if (now - value.receivedAt > this.inactiveSampleMs) {
        staleExactKeys += 1;
      }
    }
    return {
      watermark,
      queuedSamples,
      droppedStaleSamples: this.droppedStaleSamples,
      droppedOverflowSamples: this.droppedOverflowSamples,
      droppedWindowSamples: this.droppedWindowSamples,
      isolatedFutureSamples: this.timestampGuard.isolatedSamples,
      catchUpRate: this.catchUpRate,
      state: this.computeState(gapDurationMs),
      lastReleasedTimestamp: Number.isFinite(this.lastReleasedTimestamp)
        ? this.lastReleasedTimestamp
        : undefined,
      staleExactKeys,
      gapDurationMs,
      reason: this.computeReason(gapDurationMs),
    };
  }

  /**
   * 送入一批样本，返回本次可以立即发布的样本。
   *
   * @param values - 原始样本；不带时间戳的样本会原样立即返回（兼容旧协议）。
   * @param onAccepted - 可选回调；对该样本返回 `false` 表示业务侧拒绝，样本不进入队列。
   * @returns 可以立即发布的样本，顺序与输入中的可发布样本一致。
   */
  push(values: readonly T[], onAccepted?: (value: T) => boolean | undefined): readonly T[] {
    const immediate: T[] = [];
    const receivedAt = this.now();
    for (const value of values) {
      const key = this.options.keyBy(value);
      const timestamp = this.options.timeBy(value);
      if (timestamp === undefined) {
        if (onAccepted?.(value) === false) {
          continue;
        }
        immediate.push(value);
        continue;
      }
      if (!this.timestampGuard.accept(key, timestamp, receivedAt)) {
        continue;
      }
      if (onAccepted?.(value) === false) {
        continue;
      }

      this.disconnected = false;
      this.latestTimestamp = Math.max(this.latestTimestamp, timestamp);
      this.lastTimestampReceivedAt = receivedAt;
      if (this.options.exactBy?.(value) === true) {
        this.exactLatest.set(key, { timestamp, receivedAt });
      } else {
        this.exactLatest.delete(key);
      }

      const queue = this.queues.get(key) ?? [];
      queue.push(value);
      queue.sort(
        (left, right) => (this.options.timeBy(left) ?? 0) - (this.options.timeBy(right) ?? 0),
      );
      while (queue.length > this.maxSamplesPerKey) {
        queue.shift();
        this.droppedOverflowSamples += 1;
      }
      const newest = queue[queue.length - 1];
      const newestTime = newest === undefined ? 0 : (this.options.timeBy(newest) ?? 0);
      const oldestAllowed = newestTime - this.sampleWindowMs;
      while (queue.length > 0) {
        const oldest = queue[0];
        const oldestTime = oldest === undefined ? 0 : (this.options.timeBy(oldest) ?? 0);
        if (oldestTime >= oldestAllowed) {
          break;
        }
        queue.shift();
        this.droppedWindowSamples += 1;
      }
      this.queues.set(key, queue);
    }

    return [...immediate, ...this.drain()];
  }

  /** 丢弃指定对象的全部状态；对象被删除时调用，避免旧样本把它重新创建出来。 */
  remove(keys: readonly string[]): void {
    for (const key of keys) {
      this.queues.delete(key);
      this.exactLatest.delete(key);
      this.timestampGuard.remove(key);
    }
  }

  /** 标记链路断流：保持已发布位置不变，直到新的带时间戳样本重建安全窗口。 */
  markDisconnected(): void {
    this.disconnected = true;
  }

  /** 清空全部样本与统计；重连或会话重建时调用。 */
  reset(): void {
    this.queues.clear();
    this.exactLatest.clear();
    this.timestampGuard.reset();
    this.latestTimestamp = Number.NEGATIVE_INFINITY;
    this.lastReleasedTimestamp = Number.NEGATIVE_INFINITY;
    this.lastTimestampReceivedAt = undefined;
    this.catchUpRate = 1;
    this.catchingUp = false;
    this.disconnected = false;
    this.droppedStaleSamples = 0;
    this.droppedOverflowSamples = 0;
    this.droppedWindowSamples = 0;
  }

  /**
   * 把基线时长按当前追赶倍率换算，用于放宽或收紧渲染插值时长来追上水位线。
   *
   * @param baseDurationMs - 未追赶时的插值时长，默认 500ms。
   * @returns 不会低于 80ms 的插值时长。
   */
  smoothDurationMs(baseDurationMs = 500): number {
    return Math.max(80, Math.round(baseDurationMs / this.catchUpRate));
  }

  private drain(): T[] {
    if (!Number.isFinite(this.latestTimestamp)) {
      return [];
    }
    const watermark = this.computeWatermark();
    if (watermark === undefined) {
      return [];
    }

    const lag = Number.isFinite(this.lastReleasedTimestamp)
      ? Math.max(0, watermark - this.lastReleasedTimestamp)
      : 0;
    if (!this.catchingUp && lag >= this.catchUpEnterLagMs) {
      this.catchingUp = true;
    }
    if (this.catchingUp && lag <= this.catchUpExitLagMs) {
      this.catchingUp = false;
    }
    this.catchUpRate = this.catchingUp
      ? Math.min(this.maxCatchUpRate, Math.max(1, lag / Math.max(this.bufferMs, 1)))
      : 1;

    const ready: T[] = [];
    for (const [key, queue] of [...this.queues]) {
      const staleBefore = watermark - this.staleMs;
      while (queue.length > 0) {
        const oldest = queue[0];
        const oldestTime = oldest === undefined ? 0 : (this.options.timeBy(oldest) ?? 0);
        if (oldestTime >= staleBefore) {
          break;
        }
        queue.shift();
        this.droppedStaleSamples += 1;
      }

      // 队列有序：取最后一条不晚于水位线的样本，其余留待下一批。
      let next: T | undefined;
      while (queue.length > 0) {
        const candidate = queue[0];
        const candidateTime = candidate === undefined ? 0 : (this.options.timeBy(candidate) ?? 0);
        if (candidateTime > watermark) {
          break;
        }
        next = queue.shift();
      }
      if (next !== undefined) {
        ready.push(next);
        const releasedTime = this.options.timeBy(next) ?? 0;
        this.lastReleasedTimestamp = Math.max(this.lastReleasedTimestamp, releasedTime);
      }
      if (queue.length === 0) {
        this.queues.delete(key);
      }
    }
    return ready;
  }

  private computeWatermark(): number | undefined {
    const now = this.now();
    const activeExact: number[] = [];
    for (const value of this.exactLatest.values()) {
      if (now - value.receivedAt <= this.inactiveSampleMs) {
        activeExact.push(value.timestamp);
      }
    }
    if (activeExact.length > 0) {
      return Math.min(...activeExact) - this.bufferMs;
    }
    return Number.isFinite(this.latestTimestamp) ? this.latestTimestamp - this.bufferMs : undefined;
  }

  private computeState(gapDurationMs: number): RealtimeWaterlineState {
    if (this.disconnected) {
      return 'disconnected';
    }
    if (gapDurationMs >= this.gapMs) {
      return 'stalled';
    }
    return Number.isFinite(this.lastReleasedTimestamp) ? 'playing' : 'buffering';
  }

  private computeReason(gapDurationMs: number): RealtimeWaterlineReason {
    if (this.disconnected) {
      return 'transport-disconnected';
    }
    if (gapDurationMs >= this.gapMs) {
      return 'sample-timeout';
    }
    if (this.catchingUp) {
      return 'release-lag';
    }
    return Number.isFinite(this.lastReleasedTimestamp) ? 'safe-window-ready' : 'waiting-samples';
  }
}
