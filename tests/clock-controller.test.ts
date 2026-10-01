import { describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const MS_PER_DAY = 86_400_000;

  /**
   * 按 Cesium 的两个分量建模 `JulianDate`：`dayNumber` 是整天数（儒略日从正午起算），
   * `secondsOfDay` 的小数部分无法用二进制精确表示——这正是毫秒读数会丢掉 1 毫秒的来源。
   * 假实现必须保留这个陷阱，否则"读写往返不丢毫秒"的回归测试就没有意义。
   */
  class JulianDate {
    constructor(
      readonly dayNumber: number,
      readonly secondsOfDay: number,
    ) {}

    static fromDate(date: Date): JulianDate {
      const ms = date.getTime();
      const dayOffset = Math.floor(ms / MS_PER_DAY);
      // 整天与「日内秒」分开算：先相加再取小数会把秒内的小数精度抹掉，真实实现也不会那么做。
      return new JulianDate(2_440_587 + dayOffset, 43_200 + (ms - dayOffset * MS_PER_DAY) / 1000);
    }

    /** 复刻 Cesium 的 `toDate()`：整秒进 `Date`，小数毫秒被 setter 截断。 */
    static toDate(value: JulianDate): Date {
      const gregorian = JulianDate.toGregorianDate(value);
      const date = new Date(0);
      date.setUTCFullYear(gregorian.year, gregorian.month - 1, gregorian.day);
      date.setUTCHours(
        gregorian.hour,
        gregorian.minute,
        gregorian.second,
        Math.trunc(gregorian.millisecond),
      );
      return date;
    }

    static toGregorianDate(value: JulianDate): {
      readonly year: number;
      readonly month: number;
      readonly day: number;
      readonly hour: number;
      readonly minute: number;
      readonly second: number;
      readonly millisecond: number;
    } {
      // 小数毫秒只在"秒内"的小数量级上计算，换到整秒基准才不会因浮点精度被抹平。
      const wholeSecond = Math.floor(value.secondsOfDay);
      const millisecond = (value.secondsOfDay - wholeSecond) * 1000;
      const base = new Date(
        (value.dayNumber - 2_440_587) * MS_PER_DAY + (wholeSecond - 43_200) * 1000,
      );
      return {
        year: base.getUTCFullYear(),
        month: base.getUTCMonth() + 1,
        day: base.getUTCDate(),
        hour: base.getUTCHours(),
        minute: base.getUTCMinutes(),
        second: base.getUTCSeconds(),
        millisecond,
      };
    }

    static toMilliseconds(value: JulianDate): number {
      return (value.dayNumber - 2_440_587) * MS_PER_DAY + (value.secondsOfDay - 43_200) * 1000;
    }
  }
  return { JulianDate };
});

vi.mock('cesium', () => ({ JulianDate: cesium.JulianDate }));

import { CesiumClockController } from '../src/cesium/clock-controller.js';
import { SimulationClock } from '../src/core/simulation-clock.js';

interface FakeClock {
  currentTime: InstanceType<typeof cesium.JulianDate> | undefined;
  startTime: InstanceType<typeof cesium.JulianDate> | undefined;
  stopTime: InstanceType<typeof cesium.JulianDate> | undefined;
  multiplier: number;
  shouldAnimate: boolean;
}

/** 假实现里的时刻读成整数毫秒；小数部分按真实语义四舍五入。 */
function engineMilliseconds(value: InstanceType<typeof cesium.JulianDate> | undefined): number {
  return value === undefined ? Number.NaN : Math.round(cesium.JulianDate.toMilliseconds(value));
}

function createViewer(initialTimeMs = 0) {
  const listeners = new Set<() => void>();
  const clock: FakeClock = {
    currentTime: cesium.JulianDate.fromDate(new Date(initialTimeMs)),
    startTime: cesium.JulianDate.fromDate(new Date(initialTimeMs)),
    stopTime: cesium.JulianDate.fromDate(new Date(initialTimeMs + 86_400_000)),
    multiplier: 1,
    shouldAnimate: false,
  };
  const viewer = {
    clock,
    scene: {
      preRender: {
        addEventListener: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    },
  };
  return {
    viewer,
    clock,
    runFrame: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

describe('CesiumClockController', () => {
  it('reports engine clock readings as millisecond timestamps', () => {
    const view = createViewer(1_000);
    const controller = new CesiumClockController(view.viewer as never);

    expect(controller.snapshot).toEqual({
      time: 1_000,
      startTime: 1_000,
      endTime: 86_401_000,
      multiplier: 1,
      animating: false,
    });
    expect(controller.time).toBe(1_000);
  });

  it('round-trips millisecond timestamps without losing one', () => {
    const view = createViewer();
    const controller = new CesiumClockController(view.viewer as never);

    // 这些时刻在 `JulianDate` 里的小数毫秒是 x.999…：走 `JulianDate.toDate()` 会各丢 1 毫秒，
    // 而"整秒 + 三位小数"正是 CZML 文档最常见的时间写法。
    for (const milliseconds of [1_790_726_400_376, 1_790_726_401_123, 1_664_471_040_123]) {
      controller.setTime(milliseconds);
      expect(controller.time).toBe(milliseconds);
    }

    controller.setRange(1_790_726_400_376, 1_790_726_401_123);
    expect(controller.snapshot.startTime).toBe(1_790_726_400_376);
    expect(controller.snapshot.endTime).toBe(1_790_726_401_123);
  });

  it('models the Cesium millisecond truncation the round-trip test depends on', () => {
    // 假实现若被"修好"成精确往返，上面那条回归测试就失去意义：这里把它钉住。
    const truncated = cesium.JulianDate.toDate(
      cesium.JulianDate.fromDate(new Date(1_790_726_400_376)),
    );
    expect(truncated.getTime()).toBe(1_790_726_400_375);
  });

  it('accepts numbers and Dates for time and range, and rejects invalid values', () => {
    const view = createViewer();
    const controller = new CesiumClockController(view.viewer as never);

    controller.setTime(new Date(5_000));
    expect(engineMilliseconds(view.clock.currentTime)).toBe(5_000);

    controller.setRange(1_000, 9_000);
    expect(engineMilliseconds(view.clock.startTime)).toBe(1_000);
    expect(engineMilliseconds(view.clock.stopTime)).toBe(9_000);

    // 结束早于开始会让 Cesium 时钟一直停在结束点，按配置错误拒绝。
    expect(() => {
      controller.setRange(9_000, 1_000);
    }).toThrow(expect.objectContaining({ code: 'INVALID_CLOCK_CONFIG' }));
    expect(engineMilliseconds(view.clock.startTime)).toBe(1_000);

    expect(() => {
      controller.setTime(Number.NaN);
    }).toThrow(expect.objectContaining({ code: 'INVALID_CLOCK_CONFIG' }));
    expect(() => {
      controller.setMultiplier(0);
    }).toThrow(expect.objectContaining({ code: 'INVALID_CLOCK_CONFIG' }));
    expect(() => {
      controller.setAnimating('yes' as never);
    }).toThrow(expect.objectContaining({ code: 'INVALID_CLOCK_CONFIG' }));
  });

  it('throws CLOCK_TIME_UNAVAILABLE when the engine clock has no time', () => {
    const view = createViewer();
    const controller = new CesiumClockController(view.viewer as never);

    view.clock.currentTime = undefined;

    expect(() => controller.time).toThrow(
      expect.objectContaining({ code: 'CLOCK_TIME_UNAVAILABLE', module: 'clock' }),
    );
    expect(() => controller.snapshot).toThrow(
      expect.objectContaining({ code: 'CLOCK_TIME_UNAVAILABLE' }),
    );
  });

  it('advances a bound source per rendered frame and mirrors it', () => {
    const view = createViewer(100);
    let now = 1_000;
    const controller = new CesiumClockController(view.viewer as never, () => now);
    const source = new SimulationClock({ startTime: 0, endTime: 60_000, initialTime: 0 });
    source.play();

    const unbind = controller.bind(source);

    // 绑定时先镜像一次，绑定后立刻读到的就是源时钟状态。
    expect(engineMilliseconds(view.clock.currentTime)).toBe(0);
    expect(view.clock.shouldAnimate).toBe(true);
    expect(engineMilliseconds(view.clock.startTime)).toBe(0);
    expect(engineMilliseconds(view.clock.stopTime)).toBe(60_000);
    // 源时钟自己按倍率推进，引擎时钟的倍率恒为 1。
    expect(view.clock.multiplier).toBe(1);

    now += 16;
    view.runFrame();

    expect(source.currentTime).toBe(16);
    expect(engineMilliseconds(view.clock.currentTime)).toBe(16);

    unbind();
    expect(view.listenerCount()).toBe(0);
  });

  it('mirrors without driving the source when drive is false', () => {
    const view = createViewer();
    let now = 1_000;
    const controller = new CesiumClockController(view.viewer as never, () => now);
    const source = new SimulationClock({ startTime: 0, endTime: 60_000, initialTime: 0 });
    source.play();

    const unbind = controller.bind(source, { drive: false });
    now += 500;
    view.runFrame();

    // 推进交给业务，控制器只做镜像。
    expect(source.currentTime).toBe(0);
    expect(engineMilliseconds(view.clock.currentTime)).toBe(0);

    source.seek(7_000);
    source.pause();
    now += 16;
    view.runFrame();
    expect(engineMilliseconds(view.clock.currentTime)).toBe(7_000);
    expect(view.clock.shouldAnimate).toBe(false);

    unbind();
  });

  it('does not mirror a source without a time base, and ignores a clock going backwards', () => {
    const view = createViewer(4_242);
    let now = 5_000;
    const controller = new CesiumClockController(view.viewer as never, () => now);
    const source = new SimulationClock();
    source.play();

    const unbind = controller.bind(source);

    // 源时钟还没 seek 过：不写引擎时钟，也不报错。
    expect(engineMilliseconds(view.clock.currentTime)).toBe(4_242);

    source.seek(1_000);
    now -= 50;
    view.runFrame();

    // 帧间隔取非负值：时间回拨不会让源时钟倒退。
    expect(source.currentTime).toBe(1_000);
    expect(engineMilliseconds(view.clock.currentTime)).toBe(1_000);

    unbind();
  });

  it('keeps a single binding and rejects invalid bind options', () => {
    const view = createViewer();
    let now = 0;
    const controller = new CesiumClockController(view.viewer as never, () => now);
    const first = new SimulationClock({ startTime: 0, endTime: 1_000, initialTime: 0 });
    const second = new SimulationClock({ startTime: 0, endTime: 1_000, initialTime: 0 });
    first.play();
    second.play();

    controller.bind(first);
    controller.bind(second);
    expect(view.listenerCount()).toBe(1);

    now += 16;
    view.runFrame();
    expect(first.currentTime).toBe(0);
    expect(second.currentTime).toBe(16);

    expect(() => {
      controller.bind(second, { drive: 'yes' as never });
    }).toThrow(expect.objectContaining({ code: 'INVALID_CLOCK_CONFIG' }));
  });

  it('rejects every operation after dispose and stops frame callbacks', () => {
    const view = createViewer();
    const controller = new CesiumClockController(view.viewer as never);
    const source = new SimulationClock({ startTime: 0, endTime: 1_000, initialTime: 0 });
    controller.bind(source);

    controller.destroy();

    expect(view.listenerCount()).toBe(0);
    for (const operation of [
      () => {
        controller.setTime(1);
      },
      () => {
        controller.setRange(0, 1);
      },
      () => {
        controller.setMultiplier(2);
      },
      () => {
        controller.setAnimating(true);
      },
      () => {
        controller.bind(source);
      },
    ]) {
      expect(operation).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED', module: 'clock' }));
    }
    // 只读读数不需要 assertActive：时钟本身还能读，销毁的是控制器。
    expect(controller.time).toBe(0);
  });
});
