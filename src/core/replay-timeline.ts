import { GisError } from './errors.js';

/** 时间轴样本的最低形状：必须带一个有限的时间戳（秒）。 */
export interface ReplaySample {
  /** 样本时间，单位为秒；同一条序列内按它排序。 */
  readonly time: number;
}

/** 时间轴当前的样本跨度；没有样本时两个字段都是 `undefined`。 */
export interface ReplayTimeRange {
  /** 最早样本的时间，单位为秒。 */
  readonly startTime: number | undefined;
  /** 最晚样本的时间，单位为秒。 */
  readonly endTime: number | undefined;
}

/** 回放时间轴配置。 */
export interface ReplayTimelineOptions<T extends ReplaySample> {
  /** 单个对象保留的样本上限，超出后丢弃最旧的，默认 600。 */
  readonly maxSamplesPerKey?: number;
  /**
   * 两个相邻样本之间的插值函数；`ratio` 在 0 到 1 之间（前一个样本为 0）。
   *
   * 不提供时 `sampleAt()` 只返回时间上**不晚于**查询时刻的最近样本，不做插值。
   */
  readonly interpolate?: (previous: T, next: T, ratio: number) => T;
  /** 序列两端之外允许外推的秒数，默认 0（不外推）。 */
  readonly maxExtrapolationSeconds?: number;
  /** `trackAt()` 默认向前回溯的秒数，默认 900。 */
  readonly trackWindowSeconds?: number;
  /** 返回样本时的复制函数；省略时按引用返回，调用方不应修改。 */
  readonly clone?: (sample: T) => T;
}

function invalidInput(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_REPLAY_INPUT',
    module: 'replay',
    operation,
  });
}

/** 第一个不小于 `time` 的下标（下界）。 */
function lowerBound(items: readonly ReplaySample[], time: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const sample = items[middle];
    if (sample !== undefined && sample.time < time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** 第一个大于 `time` 的下标（上界）。 */
function upperBound(items: readonly ReplaySample[], time: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const sample = items[middle];
    if (sample !== undefined && sample.time <= time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * 按对象分组的回放时间轴。
 *
 * 只负责"同一对象的样本序列"这一件事：时间排序、同刻去重、容量上限、按时间查询与按窗口切片。
 * 样本内容对 SDK 不透明（位置、姿态、标量都可以），插值与复制由调用方注入，因此同一份实现
 * 既能服务卫星轨迹，也能服务遥测曲线。
 *
 * 与 `SimulationClock` 的分工：时钟只管"现在是什么时刻"，时间轴管"这个时刻的数据长什么样"。
 * 时间轴不读数据源、不做缓存策略、不做 Worker 解析——那些留在业务侧。
 *
 * @typeParam T - 样本类型；至少带一个 `time` 字段。
 */
export class ReplayTimeline<T extends ReplaySample = ReplaySample> {
  private readonly samples = new Map<string, T[]>();
  private readonly maxSamplesPerKey: number;
  private readonly interpolate: ((previous: T, next: T, ratio: number) => T) | undefined;
  private readonly maxExtrapolationSeconds: number;
  private readonly trackWindowSeconds: number;
  private readonly clone: ((sample: T) => T) | undefined;
  private startTime: number | undefined;
  private endTime: number | undefined;

  /**
   * @param options - 容量、插值、外推与复制策略。
   */
  constructor(options: ReplayTimelineOptions<T> = {}) {
    const max = options.maxSamplesPerKey ?? 600;
    if (!Number.isFinite(max) || max < 2) {
      throw invalidInput('maxSamplesPerKey must be a finite number of at least 2.', 'configure');
    }
    const extrapolation = options.maxExtrapolationSeconds ?? 0;
    if (!Number.isFinite(extrapolation) || extrapolation < 0) {
      throw invalidInput(
        'maxExtrapolationSeconds must be a finite number of at least 0.',
        'configure',
      );
    }
    const trackWindow = options.trackWindowSeconds ?? 900;
    if (!Number.isFinite(trackWindow) || trackWindow < 0) {
      throw invalidInput('trackWindowSeconds must be a finite number of at least 0.', 'configure');
    }
    this.maxSamplesPerKey = Math.floor(max);
    this.interpolate = options.interpolate;
    this.maxExtrapolationSeconds = extrapolation;
    this.trackWindowSeconds = trackWindow;
    this.clone = options.clone;
  }

  /** 已有样本的对象数量。 */
  get size(): number {
    return this.samples.size;
  }

  /** 已有样本的对象标识。 */
  get keys(): readonly string[] {
    return [...this.samples.keys()];
  }

  /**
   * 当前保留样本的时间跨度；没有样本时两个字段都是 `undefined`。
   *
   * 反映的是**此刻手上还剩什么数据**：样本因容量上限被丢弃、或某个对象被 `clear(key)` 之后，
   * 跨度会跟着收缩，不会留下已经取不到的旧时间点。
   */
  get range(): ReplayTimeRange {
    return { startTime: this.startTime, endTime: this.endTime };
  }

  /**
   * 追加一条样本。
   *
   * 同一对象同一时刻重复写入会**替换**原样本，不会产生两条同刻样本；超过容量上限时丢弃最旧的。
   *
   * @param key - 对象标识。
   * @param sample - 样本；时间必须是有限数。
   */
  addSample(key: string, sample: T): void {
    this.assertSample(sample);
    const list = this.samples.get(key) ?? [];
    const index = list.findIndex((item) => item.time === sample.time);
    if (index >= 0) {
      list[index] = sample;
    } else {
      list.push(sample);
      list.sort((left, right) => left.time - right.time);
    }
    this.samples.set(key, list);
    this.truncate(key, list);
    this.extendRange(sample.time);
  }

  /**
   * 批量追加样本；排序与去重只在结束时做一次。
   *
   * @param key - 对象标识。
   * @param samples - 样本序列。
   */
  addSamples(key: string, samples: readonly T[]): void {
    for (const sample of samples) {
      this.assertSample(sample);
      const list = this.samples.get(key) ?? [];
      const index = list.findIndex((item) => item.time === sample.time);
      if (index >= 0) {
        list[index] = sample;
      } else {
        list.push(sample);
      }
      this.samples.set(key, list);
      this.extendRange(sample.time);
    }
    const list = this.samples.get(key);
    if (!list) {
      return;
    }
    list.sort((left, right) => left.time - right.time);
    this.truncate(key, list);
  }

  /** 该对象已保留的样本数。 */
  count(key: string): number {
    return this.samples.get(key)?.length ?? 0;
  }

  /** 是否已有该对象的样本。 */
  has(key: string): boolean {
    return (this.samples.get(key)?.length ?? 0) > 0;
  }

  /**
   * 取时间上不晚于 `time` 的最近一条样本。
   *
   * @param key - 对象标识。
   * @param time - 查询时刻，单位为秒。
   * @returns 最近样本；没有样本或全部晚于查询时刻时返回 `undefined`。
   */
  latest(key: string, time: number): T | undefined {
    this.assertTime(time);
    const list = this.samples.get(key);
    if (!list?.length) {
      return undefined;
    }
    const index = upperBound(list, time);
    const sample = index === 0 ? undefined : list[index - 1];
    return sample === undefined ? undefined : this.returnSample(sample);
  }

  /**
   * 取指定时刻的样本。
   *
   * 落在两个样本之间时按 {@link ReplayTimelineOptions.interpolate} 插值；没有插值函数时退化为
   * 前一条样本（`latest()` 的语义）。序列两端之外只有在配置了外推秒数且至少有两个样本时才返回
   * 结果，否则返回 `undefined`——不伪造数据。
   *
   * @param key - 对象标识。
   * @param time - 查询时刻，单位为秒。
   */
  sampleAt(key: string, time: number): T | undefined {
    this.assertTime(time);
    const list = this.samples.get(key);
    if (!list?.length) {
      return undefined;
    }
    const first = list[0];
    const last = list[list.length - 1];
    if (first === undefined || last === undefined) {
      return undefined;
    }
    if (time < first.time) {
      return this.extrapolate(list, time, true);
    }
    if (time > last.time) {
      return this.extrapolate(list, time, false);
    }
    const nextIndex = lowerBound(list, time);
    if (nextIndex <= 0) {
      return this.returnSample(first);
    }
    const next = list[nextIndex];
    const previous = list[nextIndex - 1];
    if (next === undefined || previous === undefined) {
      return undefined;
    }
    if (!this.interpolate || next.time === previous.time) {
      return this.returnSample(previous);
    }
    const ratio = (time - previous.time) / (next.time - previous.time);
    return this.returnSample(this.interpolate(previous, next, ratio));
  }

  /**
   * 按时间窗口切片，两端都包含。
   *
   * @param key - 对象标识。
   * @param startTime - 窗口起点，单位为秒。
   * @param endTime - 窗口终点，单位为秒；小于起点时返回空数组。
   * @returns 窗口内的样本，按时间升序。
   */
  window(key: string, startTime: number, endTime: number): T[] {
    this.assertTime(startTime);
    this.assertTime(endTime);
    const list = this.samples.get(key);
    if (!list?.length || endTime < startTime) {
      return [];
    }
    const start = lowerBound(list, startTime);
    const end = upperBound(list, endTime);
    return list.slice(start, end).map((sample) => this.returnSample(sample));
  }

  /**
   * 轨迹窗口：从 `time` 往前回溯配置的秒数。
   *
   * 与 `window()` 的区别是终点包含 `time` 上的样本，便于直接画出"到目前为止的轨迹"。
   *
   * @param key - 对象标识。
   * @param time - 当前时刻，单位为秒。
   * @param seconds - 回溯秒数；省略时使用配置的 `trackWindowSeconds`（默认 900 秒）。
   */
  trackAt(key: string, time: number, seconds = this.trackWindowSeconds): T[] {
    return this.window(key, time - Math.max(0, seconds), time);
  }

  /**
   * 清空样本。
   *
   * @param key - 对象标识；省略时清空全部对象。
   */
  clear(key?: string): void {
    if (key === undefined) {
      this.samples.clear();
      this.startTime = undefined;
      this.endTime = undefined;
      return;
    }
    this.samples.delete(key);
    this.recomputeRange();
  }

  private extrapolate(list: readonly T[], time: number, before: boolean): T | undefined {
    if (this.maxExtrapolationSeconds <= 0 || list.length < 2 || !this.interpolate) {
      return undefined;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const previous = before ? first : list[list.length - 2];
    const next = before ? list[1] : last;
    if (previous === undefined || next === undefined || first === undefined || last === undefined) {
      return undefined;
    }
    const anchor = before ? first : last;
    if (Math.abs(time - anchor.time) > this.maxExtrapolationSeconds) {
      return undefined;
    }
    const span = next.time - previous.time;
    if (span <= 0) {
      return undefined;
    }
    const ratio = (time - previous.time) / span;
    return this.returnSample(this.interpolate(previous, next, ratio));
  }

  private returnSample(sample: T): T {
    return this.clone ? this.clone(sample) : sample;
  }

  /** 丢弃超出容量上限的旧样本；被丢的正好是当前起点时重算跨度。 */
  private truncate(_key: string, list: T[]): void {
    if (list.length <= this.maxSamplesPerKey) {
      return;
    }
    const removed = list.splice(0, list.length - this.maxSamplesPerKey);
    if (removed.some((sample) => sample.time === this.startTime)) {
      this.recomputeRange();
    }
  }

  private extendRange(time: number): void {
    this.startTime = this.startTime === undefined ? time : Math.min(this.startTime, time);
    this.endTime = this.endTime === undefined ? time : Math.max(this.endTime, time);
  }

  private recomputeRange(): void {
    let start: number | undefined;
    let end: number | undefined;
    for (const list of this.samples.values()) {
      for (const sample of list) {
        start = start === undefined ? sample.time : Math.min(start, sample.time);
        end = end === undefined ? sample.time : Math.max(end, sample.time);
      }
    }
    this.startTime = start;
    this.endTime = end;
  }

  private assertSample(sample: ReplaySample): void {
    const candidate: unknown = sample;
    if (typeof candidate !== 'object' || candidate === null) {
      throw invalidInput('Replay sample must be an object with a finite time.', 'addSample');
    }
    this.assertTime((candidate as { time?: unknown }).time, 'addSample');
  }

  private assertTime(time: unknown, operation = 'query'): void {
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      throw invalidInput('Replay time must be a finite number of seconds.', operation);
    }
  }
}
