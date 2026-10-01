import { GisError } from './errors.js';
import { FrameStatistics } from './frame-statistics.js';
import type { FrameStatisticsSnapshot } from './frame-statistics.js';

/** 内置渲染质量档标识。 */
export type QualityProfileId = 'default' | 'quality' | 'balanced' | 'low';

/** SDK 拥有的可调渲染质量参数。 */
export interface RenderQuality {
  /** 渲染分辨率缩放，范围 0.5 到 2；越大越清晰也越耗 GPU。 */
  readonly resolutionScale: number;
  /** 地形最大屏幕空间误差，范围 1 到 64；越大越省。 */
  readonly terrainSse: number;
  /** 模型并发加载上限，范围 1 到 32 的整数。 */
  readonly modelLoadConcurrency: number;
}

/** 质量快照：当前参数、帧采样与自动画质状态。 */
export interface QualitySnapshot extends RenderQuality {
  /** 滑动窗口内的平均帧率。 */
  readonly fps: number;
  /** 滑动窗口内的平均帧耗时，单位为毫秒。 */
  readonly frameTimeMs: number;
  /** 当前窗口内的有效采样数。 */
  readonly sampleCount: number;
  /**
   * 中位帧耗时（P50），单位为毫秒。
   *
   * 平均值会被卡顿摊平：60 帧里两帧卡到 200 毫秒，平均也才 14 毫秒上下。P50 与
   * {@link QualitySnapshot.frameTimeP95Ms} 一起看才能区分"一直平稳"与"偶发顿挫"。
   */
  readonly frameTimeP50Ms: number;
  /** 95 分位帧耗时（P95），单位为毫秒。 */
  readonly frameTimeP95Ms: number;
  /** 窗口内最长的一帧，单位为毫秒。 */
  readonly frameTimeMaxMs: number;
  /** 达到长帧阈值（默认 50 毫秒，与浏览器 Long Tasks 阈值一致）的帧数。 */
  readonly longFrames: number;
  /** 长帧占比，0 到 1。 */
  readonly longFrameRatio: number;
  /** 是否已有一项参数低于初始值。 */
  readonly degraded: boolean;
  /** 自动画质是否开启。 */
  readonly adaptive: boolean;
}

/** 单项质量参数的上下界。 */
export interface RenderQualityBounds {
  /** 分辨率缩放下界与上界。 */
  readonly resolutionScale?: readonly [number, number];
  /** 地形误差下界与上界。 */
  readonly terrainSse?: readonly [number, number];
  /** 模型并发下界与上界。 */
  readonly modelLoadConcurrency?: readonly [number, number];
}

/**
 * 固定质量档，使渲染、地形与模型调度使用一致的资源预算。
 *
 * `default` 保持 Cesium 的默认渲染参数，是 `createMap()` 不传 `quality` 时的取值；
 * `quality`、`balanced`、`low` 为 Plugin-web 生产验证过的三档，`quality` 最清晰也最耗资源。
 */
export const qualityProfiles: Readonly<Record<QualityProfileId, RenderQuality>> = Object.freeze({
  default: Object.freeze({ resolutionScale: 1, terrainSse: 2, modelLoadConcurrency: 4 }),
  quality: Object.freeze({ resolutionScale: 1.5, terrainSse: 2, modelLoadConcurrency: 8 }),
  balanced: Object.freeze({ resolutionScale: 1, terrainSse: 8, modelLoadConcurrency: 4 }),
  low: Object.freeze({ resolutionScale: 0.75, terrainSse: 12, modelLoadConcurrency: 2 }),
});

function invalidQuality(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_QUALITY_CONFIG',
    module: 'quality',
    operation,
  });
}

/** 判断取值是否是受支持的质量档标识。 */
export function isQualityProfileId(value: unknown): value is QualityProfileId {
  return value === 'default' || value === 'quality' || value === 'balanced' || value === 'low';
}

/** 校验一组完整质量参数；非法取值抛出 `INVALID_QUALITY_CONFIG`。 */
export function validateRenderQuality(quality: RenderQuality, operation = 'set'): void {
  if (
    !Number.isFinite(quality.resolutionScale) ||
    quality.resolutionScale < 0.5 ||
    quality.resolutionScale > 2
  ) {
    throw invalidQuality('resolutionScale must be a finite number between 0.5 and 2.', operation);
  }
  if (!Number.isFinite(quality.terrainSse) || quality.terrainSse < 1 || quality.terrainSse > 64) {
    throw invalidQuality('terrainSse must be a finite number between 1 and 64.', operation);
  }
  if (
    !Number.isInteger(quality.modelLoadConcurrency) ||
    quality.modelLoadConcurrency < 1 ||
    quality.modelLoadConcurrency > 32
  ) {
    throw invalidQuality('modelLoadConcurrency must be an integer between 1 and 32.', operation);
  }
}

/**
 * 合并质量档与自定义覆盖，并校验结果。
 *
 * 非法质量档标识或非法参数都会抛出 `INVALID_QUALITY_CONFIG`，不会静默回退。
 */
export function resolveRenderQuality(
  profile: QualityProfileId,
  overrides: Partial<RenderQuality> = {},
  operation = 'createMap',
): RenderQuality {
  if (!isQualityProfileId(profile)) {
    throw invalidQuality(`Unknown quality profile "${String(profile)}".`, operation);
  }
  const quality: RenderQuality = { ...qualityProfiles[profile], ...overrides };
  validateRenderQuality(quality, operation);
  return Object.freeze(quality);
}

/** 自动画质监测配置。 */
export interface RenderQualityMonitorOptions {
  /** 初始质量参数，同时作为升降档的上界基准。 */
  readonly initial: RenderQuality;
  /** 目标帧率，默认 30。 */
  readonly targetFps?: number;
  /** 是否开启自动画质，默认 `true`。 */
  readonly adaptive?: boolean;
  /** 各项参数的升降档边界；省略时由初始值推导。 */
  readonly bounds?: RenderQualityBounds;
  /** 单帧耗时超过该毫秒数视为卡顿，重置滑动窗口，默认 250。 */
  readonly stallFrameMs?: number;
  /**
   * 单帧耗时达到该毫秒数即计入长帧读数，默认 50；只影响读数，不影响升降档判断。
   *
   * 与 `stallFrameMs` 是两件事：卡顿（默认 250 毫秒）会重置窗口并跳过这一次判断，
   * 长帧只是记账——1 帧 60 毫秒够不上卡顿，但它确实是一次可感知的顿挫。
   */
  readonly longFrameMs?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 快照里来自帧窗口的那部分字段。 */
type FrameReadings = Pick<
  QualitySnapshot,
  | 'fps'
  | 'frameTimeMs'
  | 'sampleCount'
  | 'frameTimeP50Ms'
  | 'frameTimeP95Ms'
  | 'frameTimeMaxMs'
  | 'longFrames'
  | 'longFrameRatio'
>;

/** 地图实例的类型化渲染质量控制。 */
export interface QualityController {
  /** 当前生效的质量参数。 */
  readonly current: RenderQuality;
  /** 最近一次帧采样与自动画质状态。 */
  readonly snapshot: QualitySnapshot;
  /** 自动画质是否开启。 */
  readonly adaptive: boolean;
  /** 应用内置质量档；会退出自动画质。 */
  setProfile(profile: QualityProfileId): void;
  /** 覆盖部分质量参数；会退出自动画质。 */
  set(quality: Partial<RenderQuality>): void;
  /** 开关自动画质；开启后以当前参数为基线继续升降。 */
  setAdaptive(enabled: boolean): void;
}

/**
 * 用滑动窗口监测渲染帧率，持续低帧时降低质量，恢复后逐步回升。
 *
 * 该模块只做帧采样与档位计算，不依赖 Cesium；把结果写入引擎参数由适配器负责。
 * 帧率不足以判断时（窗口未满、非连续渲染、单帧卡顿超阈值）会重置窗口而不是降档，
 * 避免页面切换、标签页隐藏等一次性噪声被当成性能问题。
 */
export class RenderQualityMonitor {
  private readonly bounds: Required<{
    resolutionScale: readonly [number, number];
    terrainSse: readonly [number, number];
    modelLoadConcurrency: readonly [number, number];
  }>;
  private readonly targetFps: number;
  private readonly stallFrameMs: number;
  private readonly windowSize = 60;
  private readonly minSamples = 10;
  private readonly changeIntervalMs = 2_000;
  private readonly degradeFrames = 10;
  private readonly raiseFrames = 30;
  private readonly degradeRatio = 0.8;
  private readonly raiseRatio = 1.1;

  private quality: RenderQuality;
  private snapshot: QualitySnapshot;
  private readonly frames: FrameStatistics;
  private lastTimestamp: number | undefined;
  private lastChange = Number.NEGATIVE_INFINITY;
  private lowFrames = 0;
  private goodFrames = 0;
  private adaptive: boolean;

  constructor(options: RenderQualityMonitorOptions) {
    validateRenderQuality(options.initial, 'createMap');
    const { initial } = options;
    const bounds = options.bounds ?? {};
    this.bounds = {
      resolutionScale: bounds.resolutionScale ?? [0.5, initial.resolutionScale],
      terrainSse: bounds.terrainSse ?? [initial.terrainSse, Math.max(12, initial.terrainSse)],
      modelLoadConcurrency: bounds.modelLoadConcurrency ?? [
        Math.min(2, initial.modelLoadConcurrency),
        initial.modelLoadConcurrency,
      ],
    };
    this.targetFps = options.targetFps ?? 30;
    this.stallFrameMs = options.stallFrameMs ?? 250;
    this.adaptive = options.adaptive ?? true;
    this.quality = { ...initial };
    this.frames = new FrameStatistics(
      options.longFrameMs === undefined
        ? { windowSize: this.windowSize }
        : { windowSize: this.windowSize, longFrameMs: options.longFrameMs },
    );
    this.snapshot = {
      ...this.quality,
      ...this.frameReadings(),
      degraded: false,
      adaptive: this.adaptive,
    };
  }

  /** 当前生效的质量参数。 */
  get current(): RenderQuality {
    return { ...this.quality };
  }

  /** 最近一次帧采样与自动画质状态。 */
  getSnapshot(): QualitySnapshot {
    return { ...this.snapshot };
  }

  /**
   * 记录一帧并返回最新快照。
   *
   * `continuousRendering` 为 false 表示该帧与上一帧之间发生过暂停（例如刚恢复渲染），
   * 此时只更新瞬时帧率并重置窗口。
   */
  sample(timestamp: number, continuousRendering = true): QualitySnapshot {
    if (!Number.isFinite(timestamp)) {
      return this.getSnapshot();
    }
    if (this.lastTimestamp === undefined) {
      this.lastTimestamp = timestamp;
      return this.getSnapshot();
    }

    const frameTime = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;
    if (frameTime <= 0) {
      return this.getSnapshot();
    }
    if (!continuousRendering || frameTime > this.stallFrameMs) {
      this.resetWindow(timestamp);
      this.snapshot = {
        ...this.quality,
        // 窗口刚被清空：分位数与长帧计数归零，只给出这一帧的瞬时帧率供诊断。
        ...this.frameReadings(),
        fps: 1000 / frameTime,
        frameTimeMs: frameTime,
        sampleCount: 0,
        adaptive: this.adaptive,
        degraded: this.isDegraded(),
      };
      return this.getSnapshot();
    }

    this.frames.push(frameTime);
    const readings = this.frameReadings();
    this.classify(readings.fps, readings.sampleCount);
    if (this.adaptive && timestamp - this.lastChange >= this.changeIntervalMs) {
      if (this.lowFrames >= this.degradeFrames) {
        this.lowerQuality();
        this.lowFrames = 0;
        this.lastChange = timestamp;
      } else if (this.goodFrames >= this.raiseFrames) {
        this.raiseQuality();
        this.goodFrames = 0;
        this.lastChange = timestamp;
      }
    }
    this.snapshot = {
      ...this.quality,
      ...readings,
      adaptive: this.adaptive,
      degraded: this.isDegraded(),
    };
    return this.getSnapshot();
  }

  /** 覆盖部分质量参数并退出自动画质；非法取值抛出 `INVALID_QUALITY_CONFIG`。 */
  setQuality(quality: Partial<RenderQuality>): QualitySnapshot {
    const next: RenderQuality = { ...this.quality, ...quality };
    validateRenderQuality(next);
    this.quality = next;
    this.adaptive = false;
    this.resetWindow();
    this.snapshot = { ...this.snapshot, ...next, adaptive: false, degraded: this.isDegraded() };
    return this.getSnapshot();
  }

  /** 开关自动画质；切换时重置滑动窗口，避免沿用旧噪声。 */
  setAdaptive(enabled: boolean): QualitySnapshot {
    this.adaptive = enabled;
    this.resetWindow();
    this.snapshot = { ...this.snapshot, adaptive: enabled };
    return this.getSnapshot();
  }

  private classify(fps: number, samples: number): void {
    if (samples < this.minSamples) {
      this.lowFrames = 0;
      this.goodFrames = 0;
      return;
    }
    if (fps < this.targetFps * this.degradeRatio) {
      this.lowFrames += 1;
      this.goodFrames = 0;
      return;
    }
    if (fps > this.targetFps * this.raiseRatio) {
      this.goodFrames += 1;
      this.lowFrames = 0;
      return;
    }
    this.lowFrames = 0;
    this.goodFrames = 0;
  }

  private lowerQuality(): void {
    this.quality = {
      resolutionScale: roundTo(
        clamp(this.quality.resolutionScale - 0.1, ...this.bounds.resolutionScale),
        2,
      ),
      terrainSse: roundTo(clamp(this.quality.terrainSse + 1, ...this.bounds.terrainSse), 2),
      modelLoadConcurrency: Math.round(
        clamp(this.quality.modelLoadConcurrency - 1, ...this.bounds.modelLoadConcurrency),
      ),
    };
  }

  private raiseQuality(): void {
    this.quality = {
      resolutionScale: roundTo(
        clamp(this.quality.resolutionScale + 0.1, ...this.bounds.resolutionScale),
        2,
      ),
      terrainSse: roundTo(clamp(this.quality.terrainSse - 1, ...this.bounds.terrainSse), 2),
      modelLoadConcurrency: Math.round(
        clamp(this.quality.modelLoadConcurrency + 1, ...this.bounds.modelLoadConcurrency),
      ),
    };
  }

  private isDegraded(): boolean {
    return (
      this.quality.resolutionScale < this.bounds.resolutionScale[1] ||
      this.quality.terrainSse > this.bounds.terrainSse[0] ||
      this.quality.modelLoadConcurrency < this.bounds.modelLoadConcurrency[1]
    );
  }

  /** 重置滑动窗口；卡顿后保留时间戳，使下一帧仍能测到真实间隔。 */
  private resetWindow(lastTimestamp?: number): void {
    this.frames.reset();
    this.lowFrames = 0;
    this.goodFrames = 0;
    this.lastTimestamp = lastTimestamp;
  }

  /** 把帧窗口统计拍扁成快照字段；升降档判断仍只看平均帧率，口径与改动前一致。 */
  private frameReadings(): FrameReadings {
    const stats: FrameStatisticsSnapshot = this.frames.snapshot;
    return {
      fps: stats.fps,
      frameTimeMs: stats.averageMs,
      sampleCount: stats.samples,
      frameTimeP50Ms: stats.p50Ms,
      frameTimeP95Ms: stats.p95Ms,
      frameTimeMaxMs: stats.maxMs,
      longFrames: stats.longFrames,
      longFrameRatio: stats.longFrameRatio,
    };
  }
}
