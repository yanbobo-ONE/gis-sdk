import { GisError } from './errors.js';
import type { Unsubscribe } from './event-hub.js';
import type { ReplaySample, ReplayTimeline } from './replay-timeline.js';
import { SimulationClock } from './simulation-clock.js';
import type { SimulationClockState } from './simulation-clock.js';

/**
 * 一次提交给业务的时刻快照。
 *
 * `time` 是**毫秒**（与 `SimulationClock` 一致），`timelineTime` 是**秒**（与
 * `ReplayTimeline` 一致）——两个单位都是各自模块的既有契约，这里一并给出，省得业务在
 * 每个渲染回调里自己换算，也不用猜拿到的是哪一种。
 */
export interface ReplaySessionSnapshot<T extends ReplaySample = ReplaySample> {
  /** 会话时刻，单位为毫秒。 */
  readonly time: number;
  /** 同一时刻换算到时间轴的时间，单位为秒。 */
  readonly timelineTime: number;
  /** 该时刻能解析出样本的对象，按对象 key 索引；解析不到的对象不会出现在这里。 */
  readonly samples: Readonly<Record<string, T>>;
}

/** 会话状态读数；`time` 为 `undefined` 表示时钟还没有时间基准。 */
export interface ReplaySessionStatus {
  /** 当前会话时刻（毫秒）；未设置时间基准时为 `undefined`。 */
  readonly time: number | undefined;
  /** 时钟状态。 */
  readonly state: SimulationClockState;
  /** 播放倍率。 */
  readonly rate: number;
  /** 播放方向。 */
  readonly direction: 1 | -1;
}

/** 一段时间内每个对象的样本，供业务导出（格式由业务决定）。 */
export interface ReplaySessionExport<T extends ReplaySample = ReplaySample> {
  /** 导出范围起点，单位为毫秒。 */
  readonly startTime: number;
  /** 导出范围终点，单位为毫秒。 */
  readonly endTime: number;
  /** 每个对象在该范围内的原始样本（时间戳为秒）；范围内没有样本的对象不会出现。 */
  readonly samples: Readonly<Record<string, readonly T[]>>;
}

/** 回放会话配置。 */
export interface ReplaySessionOptions<T extends ReplaySample = ReplaySample> {
  /** 提供样本的时间轴；会话只读它，不做数据读取与缓存。 */
  readonly timeline: ReplayTimeline<T>;
  /**
   * 每次时刻变化后的提交入口，可以是异步的（例如写图层、发请求）。
   *
   * `signal` 在会话被销毁时中止；快速连跳时过期的那几次**不会**被调用，正在执行的那一次
   * 会看到 `signal.aborted`。
   */
  readonly apply: (snapshot: ReplaySessionSnapshot<T>, signal: AbortSignal) => void | Promise<void>;
  /**
   * 会话时钟；省略时按时间轴范围新建一个 `replay` 模式时钟。
   *
   * 传入自己的时钟可以复用已有播放状态；此时 `load()` 不会改动时钟的时间范围。
   */
  readonly clock?: SimulationClock;
  /** 提交失败的上报入口（例如接到 `map:error` 或日志）。 */
  readonly onError?: (error: GisError) => void;
}

function sessionError(
  message: string,
  code: 'INVALID_REPLAY_INPUT' | 'REPLAY_SESSION_DISPOSED' | 'REPLAY_APPLY_FAILED',
  operation: string,
  options: { readonly cause?: unknown } = {},
): GisError {
  return new GisError(message, { code, module: 'playback', operation, ...options });
}

/**
 * 回放会话：把 SDK 的时钟与时间轴接成一条"时刻变化 → 提交快照"的线路。
 *
 * 分工是刻意的：**时间轴与时钟由业务提供，本模块不读数据、不预取、不缓存**；参照实现里
 * 的窗口预取与结构检查点（`snapshotAt`）与业务实体模型绑定，因此不在这里。
 *
 * 两件它替你做的事：
 *
 * 1. **按修订号合并**。快速连跳（拖时间轴滑块、连点"下一步"）时只有最后一次提交会真正执行，
 *    过期的那些直接丢弃；正在执行的提交能从 `signal` 上看到会话已更新或已销毁，从而停止后续写入。
 * 2. **订阅时钟而不是只认自己的调用**。快照提交由时钟状态变化触发，因此 `session.advance()`
 *    与 `map.clock.bind(session.clock)` 的按帧推进走同一条路——业务用哪种方式驱动时钟都行。
 */
export class ReplaySession<T extends ReplaySample = ReplaySample> {
  private timelineRef: ReplayTimeline<T>;
  private readonly clockRef: SimulationClock;
  private readonly ownsClock: boolean;
  private readonly applyRef: ReplaySessionOptions<T>['apply'];
  private readonly onError: ((error: GisError) => void) | undefined;
  private readonly unsubscribe: Unsubscribe;
  private readonly lifetime = new AbortController();
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();
  private applied: ReplaySessionSnapshot<T> | undefined;
  private failures = 0;
  private disposed = false;

  /**
   * @param options - 时间轴与提交入口必填；JS 调用方漏传时给出结构化的 `INVALID_REPLAY_INPUT`，
   * 而不是 `undefined` 上的属性读取错误。
   */
  constructor(options: ReplaySessionOptions<T> = {} as ReplaySessionOptions<T>) {
    // 类型上这两个字段必填；JS 调用方仍可能整个漏传，所以按运行时未知输入校验。
    const apply: unknown = options.apply;
    if (typeof apply !== 'function') {
      throw sessionError(
        'Replay session requires an apply function.',
        'INVALID_REPLAY_INPUT',
        'create',
      );
    }
    const timeline: unknown = options.timeline;
    if (!isReplayTimeline<T>(timeline)) {
      throw sessionError(
        'Replay session requires a replay timeline.',
        'INVALID_REPLAY_INPUT',
        'create',
      );
    }
    this.applyRef = apply as ReplaySessionOptions<T>['apply'];
    this.onError = options.onError;
    this.timelineRef = timeline;
    if (options.clock) {
      this.clockRef = options.clock;
      this.ownsClock = false;
    } else {
      this.clockRef = createClockForTimeline(timeline);
      this.ownsClock = true;
    }
    this.unsubscribe = this.clockRef.subscribe(() => {
      // 提交失败不能中断时钟推进：记账并上报，由调用方决定怎么处理。
      void this.schedule().catch(() => undefined);
    });
  }

  /** 会话时钟；`map.clock.bind(session.clock)` 可以直接把它接到地图时间轴上。 */
  get clock(): SimulationClock {
    return this.clockRef;
  }

  /** 当前时间轴。 */
  get timeline(): ReplayTimeline<T> {
    return this.timelineRef;
  }

  /** 最近一次成功提交的快照；还没提交过时为 `undefined`。 */
  get lastApplied(): ReplaySessionSnapshot<T> | undefined {
    return this.applied;
  }

  /** 提交失败次数（`apply` 抛错或拒绝）。 */
  get errorCount(): number {
    return this.failures;
  }

  /** 状态读数；不去读 `clock.snapshot` 的全部字段，只给面板需要的几项。 */
  get status(): ReplaySessionStatus {
    const snapshot = this.clockRef.snapshot;
    return {
      time: snapshot.currentTime,
      state: snapshot.state,
      rate: snapshot.rate,
      direction: snapshot.direction,
    };
  }

  /**
   * 换一版时间轴（例如加载了新一批样本），返回提交完成后的 Promise。
   *
   * 会话自己创建的时钟会跟着换成新时间轴的范围；业务传入的时钟不动——那是业务的状态。
   */
  load(timeline: ReplayTimeline<T>): Promise<void> {
    this.assertUsable('load');
    const next: unknown = timeline;
    if (!isReplayTimeline<T>(next)) {
      throw sessionError(
        'Replay session requires a replay timeline.',
        'INVALID_REPLAY_INPUT',
        'load',
      );
    }
    this.timelineRef = next;
    if (this.ownsClock) {
      const range = next.range;
      if (range.startTime !== undefined && range.endTime !== undefined) {
        this.clockRef.reset({
          mode: 'replay',
          startTime: range.startTime * 1000,
          endTime: range.endTime * 1000,
          initialTime: range.startTime * 1000,
        });
      }
    }
    return this.schedule();
  }

  /** 开始播放。 */
  play(): Promise<void> {
    this.assertUsable('play');
    this.clockRef.play();
    return this.schedule();
  }

  /** 暂停；不改变当前时刻。 */
  pause(): Promise<void> {
    this.assertUsable('pause');
    this.clockRef.pause();
    return this.schedule();
  }

  /** 跳到指定时刻（毫秒），落在范围内会被钳制，并进入暂停或结束状态。 */
  seek(time: number): Promise<void> {
    this.assertUsable('seek');
    this.clockRef.seek(time);
    return this.schedule();
  }

  /** 按真实经过的毫秒数推进；只有播放中才前进。 */
  advance(realDeltaMs: number): Promise<void> {
    this.assertUsable('advance');
    this.clockRef.advance(realDeltaMs);
    return this.schedule();
  }

  /** 按当前方向前后迈一步（毫秒），不改变播放状态。 */
  step(deltaMs: number): Promise<void> {
    this.assertUsable('step');
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw sessionError(
        'Replay step delta must be a non-negative finite number of milliseconds.',
        'INVALID_REPLAY_INPUT',
        'step',
      );
    }
    this.clockRef.step(deltaMs);
    return this.schedule();
  }

  /** 设置播放倍率。 */
  setRate(rate: number): Promise<void> {
    this.assertUsable('setRate');
    this.clockRef.setRate(rate);
    return this.schedule();
  }

  /** 设置播放方向。 */
  setDirection(direction: 1 | -1): Promise<void> {
    this.assertUsable('setDirection');
    this.clockRef.setDirection(direction);
    return this.schedule();
  }

  /** 停止：暂停并回到时间轴起点（按当前方向）。 */
  stop(): Promise<void> {
    this.assertUsable('stop');
    const range = this.timelineRef.range;
    this.clockRef.pause();
    const start = range.startTime;
    if (start !== undefined) {
      this.clockRef.seek(start * 1000);
    }
    return this.schedule();
  }

  /** 在原时刻重新提交一次；用于数据换版或样式变化后重绘，不改变时刻与播放状态。 */
  refresh(): Promise<void> {
    this.assertUsable('refresh');
    return this.schedule();
  }

  /** 等待当前这次提交结束（成功、失败或过期被丢弃都会兑现）。 */
  flush(): Promise<void> {
    return this.pending;
  }

  /**
   * 取一段时间内每个对象的样本，交给业务导出。
   *
   * SDK 只负责按时间取数，**不做序列化格式**：导出成 CSV、GeoJSON 还是业务自己的报文，
   * 由业务决定。
   */
  exportRange(startTime: number, endTime: number): ReplaySessionExport<T> {
    this.assertUsable('exportRange');
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      throw sessionError(
        'Replay export range must be finite milliseconds.',
        'INVALID_REPLAY_INPUT',
        'exportRange',
      );
    }
    const startSeconds = startTime / 1000;
    const endSeconds = endTime / 1000;
    const samples: Record<string, readonly T[]> = Object.create(null) as Record<
      string,
      readonly T[]
    >;
    for (const key of this.timelineRef.keys) {
      const window = this.timelineRef.window(key, startSeconds, endSeconds);
      if (window.length > 0) {
        samples[key] = Object.freeze([...window]);
      }
    }
    return Object.freeze({
      startTime,
      endTime,
      samples: Object.freeze(samples),
    });
  }

  /** 释放会话：暂停时钟、中止在途提交，并让后续调用抛 `REPLAY_SESSION_DISPOSED`。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.revision += 1;
    this.unsubscribe();
    this.clockRef.pause();
    this.lifetime.abort();
  }

  /** 安排一次提交；过期的那几次直接丢弃，只有最新一次会真正执行。 */
  private schedule(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const revision = ++this.revision;
    const task = Promise.resolve().then(async () => {
      if (!this.isCurrent(revision)) {
        return;
      }
      const snapshot = this.buildSnapshot();
      if (!snapshot) {
        // 时钟还没有时间基准：不提交，也不报错——与 map.clock.bind 的处理一致。
        return;
      }
      if (!this.isCurrent(revision)) {
        return;
      }
      this.applied = snapshot;
      await this.applyRef(snapshot, this.lifetime.signal);
    });
    this.pending = task.then(
      () => undefined,
      (cause: unknown) => {
        this.failures += 1;
        const error =
          cause instanceof GisError
            ? cause
            : sessionError('Replay snapshot apply failed.', 'REPLAY_APPLY_FAILED', 'apply', {
                cause,
              });
        this.onError?.(error);
        throw error;
      },
    );
    // 帧驱动路径（map.clock.bind）没人 await 这个 Promise，挂上兜底避免未处理拒绝。
    this.pending.catch(() => undefined);
    return this.pending;
  }

  private isCurrent(revision: number): boolean {
    return !this.disposed && revision === this.revision;
  }

  private buildSnapshot(): ReplaySessionSnapshot<T> | undefined {
    const time = this.clockRef.currentTime;
    if (time === undefined) {
      return undefined;
    }
    const timelineTime = time / 1000;
    const samples: Record<string, T> = Object.create(null) as Record<string, T>;
    for (const key of this.timelineRef.keys) {
      const sample = this.timelineRef.sampleAt(key, timelineTime);
      if (sample !== undefined) {
        samples[key] = sample;
      }
    }
    return Object.freeze({ time, timelineTime, samples: Object.freeze(samples) });
  }

  private assertUsable(operation: string): void {
    if (this.disposed) {
      throw sessionError('Replay session has been disposed.', 'REPLAY_SESSION_DISPOSED', operation);
    }
  }
}

/** 运行时判断一个值像不像回放时间轴：只要具备查询接口就够，不要求具体实现类。 */
function isReplayTimeline<T extends ReplaySample>(value: unknown): value is ReplayTimeline<T> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { sampleAt?: unknown; keys?: unknown; range?: unknown };
  return (
    typeof candidate.sampleAt === 'function' &&
    Array.isArray(candidate.keys) &&
    typeof candidate.range === 'object'
  );
}

/** 按时间轴范围建一个回放时钟；范围是秒，时钟是毫秒，这里就是换算点。 */
function createClockForTimeline<T extends ReplaySample>(
  timeline: ReplayTimeline<T>,
): SimulationClock {
  const range = timeline.range;
  if (range.startTime === undefined || range.endTime === undefined) {
    throw sessionError('Replay timeline has no samples.', 'INVALID_REPLAY_INPUT', 'create');
  }
  return new SimulationClock({
    mode: 'replay',
    startTime: range.startTime * 1000,
    endTime: range.endTime * 1000,
    initialTime: range.startTime * 1000,
  });
}
