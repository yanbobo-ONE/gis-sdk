import { GisError } from './errors.js';

/** 时间戳守卫配置。 */
export interface RealtimeTimestampGuardOptions {
  /** 允许领先的安全上限，单位为毫秒，默认 30000。 */
  readonly maxLeadMs?: number;
  /** 判定"连续递增确认"的时间窗口，单位为毫秒，默认 3000。 */
  readonly gapMs?: number;
  /** 候选对象数量上限，默认 600。 */
  readonly maxCandidates?: number;
}

function invalid(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_REALTIME_CONFIG',
    module: 'realtime',
    operation: 'create',
  });
}

/**
 * 时间跳变守卫：隔离"远超安全窗口的未来样本"，等它连续出现后才认定为新时间窗口。
 *
 * 实时链路上偶发的异常时间戳（单位错误、回放数据混入）一旦被接受，会把所有对象瞬时
 * 拖到未来再倒回来；因此领先超过 `maxLeadMs` 的样本要连续递增出现若干次才放行。
 * 该类只保留有界计数，不缓存对象或消息正文。
 */
export class RealtimeTimestampGuard {
  private readonly maxLeadMs: number;
  private readonly gapMs: number;
  private readonly maxCandidates: number;
  private readonly candidates = new Map<
    string,
    { readonly timestamp: number; readonly count: number; readonly receivedAt: number }
  >();
  private latest = Number.NEGATIVE_INFINITY;
  private receivedAt: number | undefined;
  private isolated = 0;

  constructor(options: RealtimeTimestampGuardOptions = {}) {
    this.maxLeadMs = options.maxLeadMs ?? 30_000;
    this.gapMs = options.gapMs ?? 3_000;
    this.maxCandidates = options.maxCandidates ?? 600;
    if (!Number.isFinite(this.maxLeadMs) || this.maxLeadMs < 0) {
      throw invalid('Realtime maxLeadMs must be a non-negative finite number.');
    }
    if (!Number.isFinite(this.gapMs) || this.gapMs < 0) {
      throw invalid('Realtime gapMs must be a non-negative finite number.');
    }
    if (!Number.isInteger(this.maxCandidates) || this.maxCandidates < 1) {
      throw invalid('Realtime maxCandidates must be a positive integer.');
    }
  }

  /** 被隔离的异常样本累计数量。 */
  get isolatedSamples(): number {
    return this.isolated;
  }

  /** 当前候选（尚未确认）的对象数量。 */
  get candidateCount(): number {
    return this.candidates.size;
  }

  /**
   * 判断一个样本的时间戳是否可以接受。
   *
   * @param key - 对象标识，用于确认"同一个对象的连续递增样本"。
   * @param timestamp - 仿真时间戳（毫秒）；`undefined` 表示该协议不带时间戳，一律放行。
   * @param now - 本机接收时间（毫秒）。
   * @returns 可以接受时为 `true`；被隔离时为 `false`。
   */
  accept(key: string, timestamp: number | undefined, now: number): boolean {
    if (timestamp === undefined) {
      return true;
    }
    if (!Number.isFinite(timestamp)) {
      this.isolated += 1;
      return false;
    }

    const elapsed = Math.max(0, now - (this.receivedAt ?? now));
    if (Number.isFinite(this.latest) && timestamp > this.latest + elapsed + this.maxLeadMs) {
      const previous = this.candidates.get(key);
      let count = 1;
      if (previous) {
        const withinGap = now - previous.receivedAt <= this.gapMs;
        const consecutive =
          withinGap &&
          timestamp > previous.timestamp &&
          timestamp - previous.timestamp <= this.gapMs;
        if (consecutive) {
          count = previous.count + 1;
        } else if (withinGap && previous.timestamp === timestamp) {
          count = previous.count;
        }
      }
      if (count < 3) {
        this.candidates.set(key, { timestamp, count, receivedAt: now });
        if (this.candidates.size > this.maxCandidates) {
          const oldest = this.candidates.keys().next();
          if (!oldest.done) {
            this.candidates.delete(oldest.value);
          }
        }
        this.isolated += 1;
        return false;
      }
    }

    this.candidates.delete(key);
    if (timestamp > this.latest) {
      this.latest = timestamp;
      this.receivedAt = now;
    }
    return true;
  }

  /** 丢弃某个对象的候选状态；对象被删除时调用。 */
  remove(key: string): void {
    this.candidates.delete(key);
  }

  /** 清空全部状态；重连或会话重建时调用。 */
  reset(): void {
    this.latest = Number.NEGATIVE_INFINITY;
    this.receivedAt = undefined;
    this.isolated = 0;
    this.candidates.clear();
  }
}
