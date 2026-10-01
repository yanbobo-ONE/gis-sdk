import { GisError } from './errors.js';

/** 事件播放方向。 */
export type SimulationEventDirection = 'forward' | 'reverse';

/**
 * 一条仿真事件。
 *
 * 时间单位为**秒**，与回放时间轴（`ReplayTimeline`）一致；需要与地图时钟
 * （`map.clock`，毫秒时间戳）对齐时自行换算。
 */
export interface SimulationEvent<T = unknown> {
  /**
   * 稳定标识。
   *
   * 同 id 再次 `add()` 视为**改期**：替换原事件的时间与载荷，而不是并列两条；
   * `remove()` 也按它取消。
   */
  readonly id: string;
  /** 事件时间，单位为秒。 */
  readonly timeSeconds: number;
  /** 事件类型标签，供业务在回调侧分派。 */
  readonly type: string;
  /** 业务载荷；SDK 只做搬运，不解释内容。 */
  readonly payload: T;
}

function invalidEvent(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SIMULATION_INPUT',
    module: 'simulation',
    operation,
  });
}

/**
 * 按时间调度可取消、可反向遍历的仿真事件。
 *
 * 面向业务的事件表：调度器只维护"什么时候触发什么"，触发后的动作由业务决定，因此它
 * 不依赖 Cesium、不持有计时器——回放循环按帧用 {@link between} 取走这一段该触发的事件即可。
 *
 * 与相邻模块的分工：`SimulationClock` 决定"现在是什么时刻"，`ReplayTimeline` 负责样本查询，
 * 本模块负责"这一段区间里有哪些事件"。时间单位与 `ReplayTimeline` 一致，都是秒。
 *
 * 规模预期是业务级事件表（百量级），因此实现保持简单：插入时整表按时间排序，不引入索引结构。
 */
export class SimulationEventScheduler<T = unknown> {
  private events: SimulationEvent<T>[] = [];

  /** 当前事件数量。 */
  get count(): number {
    return this.events.length;
  }

  /**
   * 新增或改期一条事件。
   *
   * @throws `INVALID_SIMULATION_INPUT` 事件缺少 id / type，或 `timeSeconds` 不是有限数。
   */
  add(event: SimulationEvent<T>): SimulationEvent<T> {
    const candidate = event as
      | { readonly id?: unknown; readonly timeSeconds?: unknown; readonly type?: unknown }
      | null
      | undefined;
    if (!candidate || typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
      throw invalidEvent('Simulation event id must be a non-empty string.', 'add');
    }
    if (typeof candidate.timeSeconds !== 'number' || !Number.isFinite(candidate.timeSeconds)) {
      throw invalidEvent('Simulation event timeSeconds must be a finite number.', 'add');
    }
    if (typeof candidate.type !== 'string' || candidate.type.trim().length === 0) {
      throw invalidEvent('Simulation event type must be a non-empty string.', 'add');
    }

    this.remove(candidate.id);
    this.events.push(event);
    this.events.sort((left, right) => left.timeSeconds - right.timeSeconds);
    return event;
  }

  /**
   * 取消一条事件。
   *
   * @returns 取消前存在该 id 时为 `true`，不存在时为 `false`（不抛错）。
   */
  remove(id: string): boolean {
    const previousLength = this.events.length;
    this.events = this.events.filter((event) => event.id !== id);
    return previousLength !== this.events.length;
  }

  /** 清空全部事件。 */
  clear(): void {
    this.events = [];
  }

  /**
   * 取出一段播放区间内该触发的事件。
   *
   * 区间在**播放方向**上都是半开半闭，配合同一循环里"上一帧 → 这一帧"的连续取值不会重复触发：
   * - `'forward'`：`from < timeSeconds <= to`，按时间升序返回；
   * - `'reverse'`：`from > timeSeconds >= to`，按时间**降序**返回，即倒放时的触发顺序。
   *
   * @throws `INVALID_SIMULATION_INPUT` 区间端点不是有限数，或方向不是 `'forward'` / `'reverse'`。
   */
  between(
    fromSeconds: number,
    toSeconds: number,
    direction: SimulationEventDirection = 'forward',
  ): SimulationEvent<T>[] {
    const requested: unknown = direction;
    if (requested !== 'forward' && requested !== 'reverse') {
      throw invalidEvent('Simulation event direction must be "forward" or "reverse".', 'between');
    }
    if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds)) {
      throw invalidEvent('Simulation event range must be finite numbers.', 'between');
    }

    const selected = this.events.filter((event) =>
      direction === 'forward'
        ? event.timeSeconds > fromSeconds && event.timeSeconds <= toSeconds
        : event.timeSeconds < fromSeconds && event.timeSeconds >= toSeconds,
    );
    return direction === 'forward' ? selected : selected.reverse();
  }

  /** 全部事件的时间升序副本；改动返回值不影响调度器。 */
  all(): SimulationEvent<T>[] {
    return [...this.events];
  }
}
