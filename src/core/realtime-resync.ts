import { GisError } from './errors.js';

/** 重同步状态。 */
export type RealtimeResyncState = 'synchronized' | 'waiting-snapshot' | 'catching-up';

/** 重同步诊断快照。 */
export interface RealtimeResyncSnapshot {
  /** 当前状态。 */
  readonly state: RealtimeResyncState;
  /** 期望收到的下一个序列号；未建立基线时为 `undefined`。 */
  readonly expectedSequence: number | undefined;
  /** 最近一次接受的序列号。 */
  readonly acceptedSequence: number | undefined;
  /** 已发出的快照请求数。 */
  readonly requests: number;
  /** 因等待窗口或请求上限被抑制的请求数。 */
  readonly suppressedRequests: number;
}

/** 快照请求结果。 */
export interface RealtimeResyncRequestResult extends RealtimeResyncSnapshot {
  /** 服务端可识别的恢复游标，原样回传。 */
  readonly cursor: string | undefined;
}

/** 重同步控制器配置。 */
export interface RealtimeResyncOptions {
  /** 一次重同步最多发出的快照请求数，默认 3。 */
  readonly maxRequests?: number;
}

function invalidConfig(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_REALTIME_CONFIG',
    module: 'realtime',
    operation: 'create',
  });
}

function invalidInput(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_REALTIME_INPUT',
    module: 'realtime',
    operation: 'resync',
  });
}

/**
 * 增量序列断档后的重同步控制器。
 *
 * 序列断档要请求一次全量快照，但网络抖动会让同一次断档被反复上报：控制器把
 * "同一等待窗口内的重复请求"合并掉，并用请求上限防止无限重试。状态机只有三态：
 * `synchronized`（增量连续）、`waiting-snapshot`（已请求、等待快照）、
 * `catching-up`（快照已到、正在补齐增量）。
 */
export class RealtimeResyncController {
  private readonly maxRequests: number;
  private currentState: RealtimeResyncState = 'synchronized';
  private expected: number | undefined;
  private accepted: number | undefined;
  private requests = 0;
  private suppressedRequests = 0;
  private lastRequestedSequence: number | undefined;

  constructor(options: RealtimeResyncOptions = {}) {
    this.maxRequests = options.maxRequests ?? 3;
    if (!Number.isInteger(this.maxRequests) || this.maxRequests < 1) {
      throw invalidConfig('Realtime resync maxRequests must be a positive integer.');
    }
  }

  /** 只读诊断快照。 */
  get snapshot(): RealtimeResyncSnapshot {
    return {
      state: this.currentState,
      expectedSequence: this.expected,
      acceptedSequence: this.accepted,
      requests: this.requests,
      suppressedRequests: this.suppressedRequests,
    };
  }

  /**
   * 记录一次序列断档，并决定是否发起快照请求。
   *
   * 同一等待窗口内、同一断档序列号的重复上报会被合并，只计入 `suppressedRequests`。
   *
   * @param sequence - 收到的不连续序列号。
   * @returns 当前诊断快照。
   */
  onGap(sequence: number): RealtimeResyncSnapshot {
    if (!Number.isFinite(sequence)) {
      throw invalidInput('Realtime resync sequence must be a finite number.');
    }
    if (this.currentState === 'waiting-snapshot' && this.lastRequestedSequence === sequence) {
      this.suppressedRequests += 1;
      return this.snapshot;
    }
    this.expected = sequence;
    this.currentState = 'waiting-snapshot';
    this.lastRequestedSequence = sequence;
    this.countRequest();
    return this.snapshot;
  }

  /**
   * 显式请求一次快照；已在等待窗口内时只记一次抑制。
   *
   * @param cursor - 服务端可识别的恢复游标。
   * @returns 请求结果，含游标与当前诊断快照。
   */
  requestSnapshot(cursor?: string): RealtimeResyncRequestResult {
    if (this.currentState === 'waiting-snapshot') {
      this.suppressedRequests += 1;
      return { cursor, ...this.snapshot };
    }
    this.countRequest();
    this.currentState = 'waiting-snapshot';
    return { cursor, ...this.snapshot };
  }

  /**
   * 接受快照的末尾序列号，进入增量追赶。
   *
   * @param sequence - 快照包含的最后一个序列号。
   * @returns 当前诊断快照。
   */
  acceptSnapshot(sequence: number): RealtimeResyncSnapshot {
    if (!Number.isFinite(sequence)) {
      throw invalidInput('Realtime resync snapshot sequence must be a finite number.');
    }
    this.accepted = sequence;
    this.expected = sequence + 1;
    this.currentState = 'catching-up';
    this.lastRequestedSequence = undefined;
    return this.snapshot;
  }

  /**
   * 接受一条增量；顺序不连续时自动转入快照等待。
   *
   * @param sequence - 增量序列号。
   * @returns 当前诊断快照。
   */
  acceptDelta(sequence: number): RealtimeResyncSnapshot {
    if (!Number.isFinite(sequence)) {
      throw invalidInput('Realtime resync delta sequence must be a finite number.');
    }
    if (this.currentState === 'waiting-snapshot') {
      this.suppressedRequests += 1;
      return this.snapshot;
    }
    if (this.expected !== undefined && sequence < this.expected) {
      // 迟到的增量直接丢弃：基线已经越过它。
      return this.snapshot;
    }
    if (this.expected !== undefined && sequence > this.expected) {
      return this.onGap(sequence);
    }
    this.accepted = sequence;
    this.expected = sequence + 1;
    this.currentState = 'synchronized';
    return this.snapshot;
  }

  /** 清空全部状态与计数；重连时调用。 */
  reset(): void {
    this.currentState = 'synchronized';
    this.expected = undefined;
    this.accepted = undefined;
    this.requests = 0;
    this.suppressedRequests = 0;
    this.lastRequestedSequence = undefined;
  }

  private countRequest(): void {
    if (this.requests < this.maxRequests) {
      this.requests += 1;
    } else {
      this.suppressedRequests += 1;
    }
  }
}
