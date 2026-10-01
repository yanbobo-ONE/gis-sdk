import { JulianDate } from 'cesium';
import type { Clock } from 'cesium';

import type {
  MapClockBindOptions,
  MapClockController,
  MapClockSnapshot,
} from '../core/controls.js';
import { GisError } from '../core/errors.js';
import type { Unsubscribe } from '../core/event-hub.js';
import type { SimulationClock } from '../core/simulation-clock.js';

/** 读取真实时间，作为推进源时钟与计算帧间隔的来源；测试可注入假时钟。 */
export type ClockNow = () => number;

function invalidClock(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_CLOCK_CONFIG',
    module: 'clock',
    operation,
  });
}

function timeUnavailable(operation: string): GisError {
  return new GisError('The map clock has no current time.', {
    code: 'CLOCK_TIME_UNAVAILABLE',
    module: 'clock',
    operation,
  });
}

function toMilliseconds(value: number | Date, operation: string): number {
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) {
    throw invalidClock(
      'Clock time must be a finite number of milliseconds or a valid Date.',
      operation,
    );
  }
  return milliseconds;
}

/**
 * 把引擎时钟的 `JulianDate` 读成毫秒时间戳。
 *
 * 这里不走 `JulianDate.toDate()`：它把小数毫秒交给 `Date` 的 setter，而 setter 会截断，
 * 于是 `375.999999996` 这样的值变成 375。整秒时间戳最容易踩到——CZML 文档的 epoch 正是整秒——
 * 表现为"按毫秒写进去、读回来少 1 毫秒"，跨时钟比对（例如与源时钟的时间戳相等）会随机失败。
 * 改为把小数毫秒四舍五入后加回整秒基准，进位交给时间戳加法处理（闰秒的 60 秒也会正常进位）。
 */
function readMilliseconds(value: JulianDate): number {
  const gregorian = JulianDate.toGregorianDate(value);
  const wholeSecond = new Date(0);
  wholeSecond.setUTCFullYear(gregorian.year, gregorian.month - 1, gregorian.day);
  wholeSecond.setUTCHours(gregorian.hour, gregorian.minute, gregorian.second, 0);
  return wholeSecond.getTime() + Math.round(gregorian.millisecond);
}

/**
 * 引擎时钟的只读视图，避免在测试里依赖完整 Viewer。
 *
 * 三个时间字段在 Cesium 的类型上非空，但 JS 调用方可以直接把它们写成 `undefined`，
 * 因此这里按可空读取，让校验真正生效。
 */
type ClockSource = Pick<Clock, 'multiplier' | 'shouldAnimate'> & {
  currentTime: JulianDate | undefined;
  startTime: JulianDate | undefined;
  stopTime: JulianDate | undefined;
};

/** 逐帧回调的订阅入口。 */
interface FrameSource {
  readonly clock: ClockSource;
  readonly scene: { readonly preRender: { addEventListener(listener: () => void): () => void } };
}

/**
 * Cesium 侧地图时钟。
 *
 * 直接读写 `viewer.clock`，因此 CZML / 动态实体按当前时间求值；`bind()` 把 SDK 的
 * {@link SimulationClock} 镜像进来，并在渲染帧里按真实经过时间推进它，让业务不必自己写帧循环。
 *
 * @internal
 */
export class CesiumClockController implements MapClockController {
  private unbind: Unsubscribe | undefined;
  private disposed = false;

  constructor(
    private readonly viewer: FrameSource,
    private readonly now: ClockNow = () => Date.now(),
  ) {}

  get snapshot(): MapClockSnapshot {
    const clock = this.clock;
    const currentTime = clock.currentTime;
    if (!currentTime) {
      throw timeUnavailable('snapshot');
    }
    return Object.freeze({
      time: readMilliseconds(currentTime),
      startTime: clock.startTime ? readMilliseconds(clock.startTime) : undefined,
      endTime: clock.stopTime ? readMilliseconds(clock.stopTime) : undefined,
      multiplier: clock.multiplier,
      animating: clock.shouldAnimate,
    });
  }

  get time(): number {
    return this.snapshot.time;
  }

  setTime(time: number | Date): void {
    this.assertActive('setTime');
    this.clock.currentTime = JulianDate.fromDate(new Date(toMilliseconds(time, 'setTime')));
  }

  setRange(start: number | Date, end: number | Date): void {
    this.assertActive('setRange');
    const startMs = toMilliseconds(start, 'setRange');
    const endMs = toMilliseconds(end, 'setRange');
    if (endMs < startMs) {
      throw invalidClock('Clock endTime must not be earlier than startTime.', 'setRange');
    }
    this.clock.startTime = JulianDate.fromDate(new Date(startMs));
    this.clock.stopTime = JulianDate.fromDate(new Date(endMs));
  }

  setMultiplier(multiplier: number): void {
    this.assertActive('setMultiplier');
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw invalidClock('Clock multiplier must be a positive finite number.', 'setMultiplier');
    }
    this.clock.multiplier = multiplier;
  }

  setAnimating(animating: boolean): void {
    this.assertActive('setAnimating');
    if (typeof animating !== 'boolean') {
      throw invalidClock('Clock animating must be a boolean.', 'setAnimating');
    }
    this.clock.shouldAnimate = animating;
  }

  bind(source: SimulationClock, options: MapClockBindOptions = {}): Unsubscribe {
    this.assertActive('bind');
    const drive = options.drive ?? true;
    if (typeof drive !== 'boolean') {
      throw invalidClock('Clock bind drive must be a boolean.', 'bind');
    }
    this.unbind?.();

    let lastTick = this.now();
    const removeFrameListener = this.viewer.scene.preRender.addEventListener(() => {
      const tick = this.now();
      // 帧间隔取非负值：挂起恢复或时间回拨都不会让源时钟倒退。
      const deltaMs = Math.max(0, tick - lastTick);
      lastTick = tick;
      if (drive) {
        source.advance(deltaMs);
      }
      this.mirror(source);
    });
    this.mirror(source);

    const unsubscribe = () => {
      removeFrameListener();
      if (this.unbind === unsubscribe) {
        this.unbind = undefined;
      }
    };
    this.unbind = unsubscribe;
    return unsubscribe;
  }

  destroy(): void {
    this.unbind?.();
    this.unbind = undefined;
    this.disposed = true;
  }

  /** 把源时钟的时间、范围与播放状态镜像到引擎时钟；源时钟时间由它自己推进，因此倍率恒为 1。 */
  private mirror(source: SimulationClock): void {
    const { currentTime, startTime, endTime, state } = source.snapshot;
    if (currentTime === undefined) {
      return;
    }
    const clock = this.clock;
    clock.currentTime = JulianDate.fromDate(new Date(currentTime));
    clock.multiplier = 1;
    clock.shouldAnimate = state === 'playing';
    if (startTime !== undefined) {
      clock.startTime = JulianDate.fromDate(new Date(startTime));
    }
    if (endTime !== undefined) {
      clock.stopTime = JulianDate.fromDate(new Date(endTime));
    }
  }

  private get clock(): ClockSource {
    return this.viewer.clock;
  }

  private assertActive(operation: string): void {
    if (this.disposed) {
      throw new GisError('Map clock has been disposed.', {
        code: 'MAP_DISPOSED',
        module: 'clock',
        operation,
      });
    }
  }
}
