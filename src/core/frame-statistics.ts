import { GisError } from './errors.js';

/**
 * 帧耗时统计的分位口径：**最近秩（nearest-rank）**。
 *
 * 升序排序后取第 `ceil(p × n)` 个样本（下标从 1 起，越界时取端点）。相比线性插值，
 * 它给出的值一定是真出现过的某一帧——报"P95 帧耗时 42.3 毫秒"时，确实有一帧就是 42.3 毫秒，
 * 而不是两个样本插出来的数。窗口内样本很少时（例如刚启动只有 3 帧）分位数会退化为端点值，
 * 读数里同时给出 `samples`，判断时先看样本数。
 */
function nearestRank(sortedAscending: readonly number[], fraction: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}

/** 帧耗时统计配置。 */
export interface FrameStatisticsOptions {
  /** 滑动窗口保留的帧数，默认 60（与质量监测的窗口一致，约一秒的 60 fps 画面）。 */
  readonly windowSize?: number;
  /**
   * 单帧耗时达到该毫秒数即计入长帧，默认 50。
   *
   * 50 毫秒是浏览器 Long Tasks API 的阈值，取同一个数便于把"长帧"与主线程长任务对照着看：
   * 长帧多而长任务少，说明卡在 GPU 或合成；两者都多，说明卡在主线程计算。
   */
  readonly longFrameMs?: number;
}

/** 帧耗时统计读数。 */
export interface FrameStatisticsSnapshot {
  /** 窗口内的有效帧数。 */
  readonly samples: number;
  /** 窗口内的平均帧耗时，单位为毫秒；窗口为空时为 0。 */
  readonly averageMs: number;
  /** 由平均帧耗时换算的帧率；窗口为空时为 0。 */
  readonly fps: number;
  /** 中位帧耗时（P50），单位为毫秒；窗口为空时为 0。 */
  readonly p50Ms: number;
  /** 95 分位帧耗时（P95），单位为毫秒；窗口为空时为 0。 */
  readonly p95Ms: number;
  /** 窗口内最长的一帧，单位为毫秒；窗口为空时为 0。 */
  readonly maxMs: number;
  /** 达到长帧阈值的帧数。 */
  readonly longFrames: number;
  /** 长帧占比，0 到 1。 */
  readonly longFrameRatio: number;
}

/**
 * 帧耗时滑动窗口统计（零依赖，纯计算）。
 *
 * 平均值会把卡顿摊平：60 帧里只要有两帧卡到 200 毫秒，平均帧耗时也才 14 毫秒上下，
 * 看上去"还有 68 fps"，但操作起来是两次明显的顿挫。因此除了平均值，这里同时给出
 * P50 / P95 / 最长帧与长帧计数，让"稳不稳"和"快不快"分开看。
 *
 * 只接受正的有限帧耗时：非有限值（时间戳回拨、`performance.now()` 跳变）与 0 直接丢弃，
 * 它们不是"很快的一帧"，混进窗口会把统计拉偏。
 */
export class FrameStatistics {
  private readonly windowSize: number;
  private readonly longFrameMs: number;
  private frames: number[] = [];

  constructor(options: FrameStatisticsOptions = {}) {
    const windowSize = options.windowSize ?? 60;
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new GisError('Frame statistics windowSize must be a positive integer.', {
        code: 'INVALID_FRAME_STATISTICS_CONFIG',
        module: 'frames',
        operation: 'create',
      });
    }
    const longFrameMs = options.longFrameMs ?? 50;
    if (!Number.isFinite(longFrameMs) || longFrameMs <= 0) {
      throw new GisError('Frame statistics longFrameMs must be a positive finite number.', {
        code: 'INVALID_FRAME_STATISTICS_CONFIG',
        module: 'frames',
        operation: 'create',
      });
    }
    this.windowSize = windowSize;
    this.longFrameMs = longFrameMs;
  }

  /** 记录一帧耗时；非正的或非有限的取值会被忽略。 */
  push(frameTimeMs: number): void {
    if (!Number.isFinite(frameTimeMs) || frameTimeMs <= 0) {
      return;
    }
    this.frames.push(frameTimeMs);
    if (this.frames.length > this.windowSize) {
      this.frames.shift();
    }
  }

  /** 清空窗口（例如检测到暂停或单帧卡顿超过停滞阈值之后）。 */
  reset(): void {
    this.frames = [];
  }

  /** 当前窗口的统计读数。 */
  get snapshot(): FrameStatisticsSnapshot {
    const samples = this.frames.length;
    if (samples === 0) {
      return {
        samples: 0,
        averageMs: 0,
        fps: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        longFrames: 0,
        longFrameRatio: 0,
      };
    }
    const sorted = [...this.frames].sort((left, right) => left - right);
    const average = this.frames.reduce((sum, value) => sum + value, 0) / samples;
    let longFrames = 0;
    for (const frame of this.frames) {
      if (frame >= this.longFrameMs) {
        longFrames += 1;
      }
    }
    return {
      samples,
      averageMs: average,
      fps: 1000 / average,
      p50Ms: nearestRank(sorted, 0.5),
      p95Ms: nearestRank(sorted, 0.95),
      maxMs: sorted[sorted.length - 1] ?? 0,
      longFrames,
      longFrameRatio: longFrames / samples,
    };
  }
}
