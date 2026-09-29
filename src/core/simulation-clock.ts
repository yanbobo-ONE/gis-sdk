import { GisError } from './errors.js';
import type { Unsubscribe } from './event-hub.js';

/** 时钟所处的模式。 */
export type SimulationClockMode = 'realtime' | 'replay' | 'demo';

/** 时钟状态。 */
export type SimulationClockState = 'idle' | 'playing' | 'paused' | 'ended' | 'stalled';

/** 时钟的只读快照。 */
export interface SimulationClockSnapshot {
  /** 当前状态。 */
  readonly state: SimulationClockState;
  /** 当前仿真时间，单位为毫秒；尚未设置时间基准时为 `undefined`。 */
  readonly currentTime: number | undefined;
  /** 时间范围起点，单位为毫秒。 */
  readonly startTime: number | undefined;
  /** 时间范围终点，单位为毫秒。 */
  readonly endTime: number | undefined;
  /** 播放倍率，恒为正数。 */
  readonly rate: number;
  /** 播放方向：`1` 正向、`-1` 倒放。 */
  readonly direction: 1 | -1;
  /** 当前模式。 */
  readonly mode: SimulationClockMode;
  /** 实时模式下的安全播放上限，单位为毫秒。 */
  readonly watermark: number | undefined;
  /** 状态原因（如停滞原因），供诊断显示。 */
  readonly reason: string | undefined;
}

/** 时钟配置。 */
export interface SimulationClockOptions {
  /** 模式，默认 `'demo'`。 */
  readonly mode?: SimulationClockMode;
  /** 时间范围起点，单位为毫秒。 */
  readonly startTime?: number;
  /** 时间范围终点，单位为毫秒。 */
  readonly endTime?: number;
  /** 初始仿真时间，默认等于 `startTime`。 */
  readonly initialTime?: number;
  /** 播放倍率，默认 1；必须为正有限数。 */
  readonly rate?: number;
  /** 播放方向，默认 1（正向）。 */
  readonly direction?: 1 | -1;
}

const MODES: readonly SimulationClockMode[] = ['realtime', 'replay', 'demo'];

function invalidClock(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_REALTIME_INPUT',
    module: 'playback',
    operation,
  });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeOptions(
  options: SimulationClockOptions | undefined,
  operation: string,
): Required<Pick<SimulationClockOptions, 'rate' | 'mode' | 'direction'>> & {
  readonly startTime: number | undefined;
  readonly endTime: number | undefined;
  readonly initialTime: number | undefined;
} {
  const startTime = options?.startTime;
  const endTime = options?.endTime;
  if (startTime !== undefined && !finiteNumber(startTime)) {
    throw invalidClock('Simulation startTime must be a finite number of milliseconds.', operation);
  }
  if (endTime !== undefined && !finiteNumber(endTime)) {
    throw invalidClock('Simulation endTime must be a finite number of milliseconds.', operation);
  }
  if (startTime !== undefined && endTime !== undefined && endTime < startTime) {
    throw invalidClock('Simulation endTime must not be earlier than startTime.', operation);
  }
  const mode = options?.mode ?? 'demo';
  if (!MODES.includes(mode)) {
    throw invalidClock('Simulation mode must be realtime, replay, or demo.', operation);
  }
  const rate = options?.rate ?? 1;
  if (!finiteNumber(rate) || rate <= 0) {
    throw invalidClock('Simulation rate must be a positive finite number.', operation);
  }
  // 类型上只有两个取值，运行时（JS 调用方）仍可能传入别的数字。
  const requestedDirection: unknown = options?.direction ?? 1;
  if (requestedDirection !== 1 && requestedDirection !== -1) {
    throw invalidClock('Simulation direction must be 1 or -1.', operation);
  }
  const direction: 1 | -1 = requestedDirection;
  const initialTime = options?.initialTime;
  if (initialTime !== undefined && !finiteNumber(initialTime)) {
    throw invalidClock(
      'Simulation initialTime must be a finite number of milliseconds.',
      operation,
    );
  }
  return { startTime, endTime, mode, rate, direction, initialTime };
}

/**
 * 仿真 / 回放时钟。
 *
 * 这是回放与实时共用的时间基准：**时间推进只由 `advance()` 驱动**（传入真实经过的毫秒数），
 * 时钟本身不依赖 `requestAnimationFrame` 或任何引擎，因此可以用假时间做确定性测试。
 *
 * 三种模式的区别只有一处：`realtime` 模式下 `watermark` 会限制播放上限，避免播放游标越过
 * 尚未确认安全的数据（与 `RealtimeWaterline` 配合使用）；`replay` 与 `demo` 不会被限制。
 *
 * 时间单位统一为**毫秒**（与 `RealtimeWaterline`、`normalizePositions` 一致）；
 * CZML 使用秒，需要转换时按 `秒 × 1000` 处理。
 */
export class SimulationClock {
  private readonly listeners = new Set<(snapshot: SimulationClockSnapshot) => void>();
  private startTime: number | undefined;
  private endTime: number | undefined;
  private mode: SimulationClockMode;
  private time: number | undefined;
  private rate: number;
  private direction: 1 | -1;
  private currentState: SimulationClockState = 'idle';
  private watermark: number | undefined;
  private reason: string | undefined;

  constructor(options: SimulationClockOptions = {}) {
    const normalized = normalizeOptions(options, 'create');
    this.startTime = normalized.startTime;
    this.endTime = normalized.endTime;
    this.mode = normalized.mode;
    this.rate = normalized.rate;
    this.direction = normalized.direction;
    const initialTime = normalized.initialTime ?? normalized.startTime;
    this.time = initialTime === undefined ? undefined : this.clamp(initialTime);
    if (this.atEnd()) {
      this.currentState = 'ended';
    }
  }

  /** 当前状态的只读快照。 */
  get snapshot(): SimulationClockSnapshot {
    return {
      state: this.currentState,
      currentTime: this.time,
      startTime: this.startTime,
      endTime: this.endTime,
      rate: this.rate,
      direction: this.direction,
      mode: this.mode,
      watermark: this.watermark,
      reason: this.reason,
    };
  }

  /** 当前仿真时间，单位为毫秒。 */
  get currentTime(): number | undefined {
    return this.time;
  }

  /** 订阅状态变化；返回取消订阅函数。 */
  subscribe(listener: (snapshot: SimulationClockSnapshot) => void): Unsubscribe {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  /**
   * 原地重置时间基准。
   *
   * 已有订阅会继续跟随同一个时钟实例，因此切换数据源时不需要重新接线。
   */
  reset(options: SimulationClockOptions): SimulationClockSnapshot {
    const next = new SimulationClock(options);
    // 时间范围也要跟着切换，否则 reset 之后仍会按旧范围钳制。
    this.startTime = next.startTime;
    this.endTime = next.endTime;
    this.mode = next.mode;
    this.rate = next.rate;
    this.direction = next.direction;
    this.time = next.time;
    this.currentState = next.currentState;
    this.watermark = undefined;
    this.reason = undefined;
    return this.emit();
  }

  /** 开始播放；已到末尾时先回到起点（按当前方向）。 */
  play(): SimulationClockSnapshot {
    if (this.mode !== 'realtime' && this.atEnd()) {
      // 已停在末尾：按当前方向回到起点再播放；实时模式不做回绕。
      this.time = this.direction === 1 ? this.startTime : this.endTime;
    }
    this.currentState = 'playing';
    this.reason = undefined;
    return this.emit();
  }

  /** 暂停播放；空闲状态调用无副作用。 */
  pause(): SimulationClockSnapshot {
    if (this.currentState === 'playing') {
      this.currentState = 'paused';
    }
    return this.emit();
  }

  /** 跳转到指定时间；落在范围内会被钳制，并进入暂停或结束状态。 */
  seek(time: number): SimulationClockSnapshot {
    if (!finiteNumber(time)) {
      throw invalidClock('Simulation seek time must be a finite number of milliseconds.', 'seek');
    }
    this.time = this.clamp(time);
    this.currentState = this.atEnd() ? 'ended' : 'paused';
    this.reason = undefined;
    return this.emit();
  }

  /** 按当前方向前进（或后退）指定毫秒数，不改变播放状态。 */
  step(deltaMs: number): SimulationClockSnapshot {
    this.assertDelta(deltaMs);
    this.time = this.clamp((this.time ?? this.startTime ?? 0) + deltaMs * this.direction);
    return this.emit();
  }

  /** 设置播放倍率；必须为正有限数。 */
  setRate(rate: number): SimulationClockSnapshot {
    if (!finiteNumber(rate) || rate <= 0) {
      throw invalidClock('Simulation rate must be a positive finite number.', 'setRate');
    }
    this.rate = rate;
    return this.emit();
  }

  /** 设置播放方向；结束状态下切换方向会回到暂停。 */
  setDirection(direction: 1 | -1): SimulationClockSnapshot {
    // 类型上只有两个取值，运行时（JS 调用方）仍可能传入别的数字。
    const requested: unknown = direction;
    if (requested !== 1 && requested !== -1) {
      throw invalidClock('Simulation direction must be 1 or -1.', 'setDirection');
    }
    this.direction = requested;
    if (this.currentState === 'ended') {
      this.currentState = 'paused';
    }
    return this.emit();
  }

  /** 切换模式（`realtime` / `replay` / `demo`）。 */
  setMode(mode: SimulationClockMode): SimulationClockSnapshot {
    if (!MODES.includes(mode)) {
      throw invalidClock('Simulation mode must be realtime, replay, or demo.', 'setMode');
    }
    this.mode = mode;
    return this.emit();
  }

  /**
   * 设置实时模式的安全播放上限。
   *
   * 迟到的实时样本不会让游标倒退：新的上限早于当前上限时会被忽略；同时当前时间超前于
   * 新上限时会被拉回到上限。传入 `undefined` 表示清除上限（例如切到回放模式）。
   */
  setWatermark(time?: number): SimulationClockSnapshot {
    if (time !== undefined && !finiteNumber(time)) {
      throw invalidClock(
        'Simulation watermark must be a finite number of milliseconds.',
        'setWatermark',
      );
    }
    if (
      this.mode === 'realtime' &&
      time !== undefined &&
      this.watermark !== undefined &&
      time < this.watermark
    ) {
      return this.snapshot;
    }
    this.watermark = time;
    if (
      this.mode === 'realtime' &&
      this.time !== undefined &&
      time !== undefined &&
      this.time > time
    ) {
      this.time = time;
    }
    return this.emit();
  }

  /** 标记为停滞（例如实时断流），并记录原因。 */
  stall(reason = 'realtime-stalled'): SimulationClockSnapshot {
    this.currentState = 'stalled';
    this.reason = reason;
    return this.emit();
  }

  /**
   * 按真实经过的毫秒数推进时间。
   *
   * 只有在 `playing` 状态下才推进；`realtime` 模式下播放游标不会越过 `watermark`。
   *
   * @param realDeltaMs - 真实经过的毫秒数，必须为非负有限数。
   * @returns 推进后的快照。
   * @throws `INVALID_REALTIME_INPUT` 时间增量非法。
   */
  advance(realDeltaMs: number): SimulationClockSnapshot {
    this.assertDelta(realDeltaMs);
    if (this.currentState !== 'playing' || this.time === undefined) {
      return this.snapshot;
    }
    const next = this.time + realDeltaMs * this.rate * this.direction;
    const limit = this.mode === 'realtime' && this.watermark !== undefined ? this.watermark : next;
    this.time = this.clamp(this.direction === 1 ? Math.min(next, limit) : Math.max(next, limit));
    if (this.reachedEnd()) {
      this.currentState = 'ended';
    }
    return this.emit();
  }

  private clamp(value: number): number {
    return Math.min(
      this.endTime ?? Number.POSITIVE_INFINITY,
      Math.max(this.startTime ?? Number.NEGATIVE_INFINITY, value),
    );
  }

  /** 是否停在有效时间范围的端点（需要同时给出起止时间）。 */
  private atEnd(): boolean {
    return (
      this.time !== undefined &&
      this.startTime !== undefined &&
      this.endTime !== undefined &&
      this.endTime > this.startTime &&
      (this.direction === 1 ? this.time >= this.endTime : this.time <= this.startTime)
    );
  }

  /** 推进后是否已到达当前方向的终点。 */
  private reachedEnd(): boolean {
    if (this.time === undefined) {
      return false;
    }
    if (this.direction === 1) {
      return this.endTime !== undefined && this.time >= this.endTime;
    }
    return this.time <= (this.startTime ?? Number.NEGATIVE_INFINITY);
  }

  private assertDelta(value: number): void {
    if (!finiteNumber(value) || value < 0) {
      throw invalidClock(
        'Simulation time delta must be a non-negative finite number of milliseconds.',
        'advance',
      );
    }
  }

  private emit(): SimulationClockSnapshot {
    const snapshot = this.snapshot;
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // 订阅者异常不能影响时钟状态推进。
      }
    }
    return snapshot;
  }
}
