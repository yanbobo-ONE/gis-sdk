import type { QualityController } from '../core/quality.js';
import {
  RenderQualityMonitor,
  resolveRenderQuality,
  validateRenderQuality,
} from '../core/quality.js';
import type {
  QualityProfileId,
  QualitySnapshot,
  RenderQuality,
  RenderQualityBounds,
} from '../core/quality.js';
import type { LoadLimiter } from './load-limiter.js';

interface QualityScene {
  readonly globe: { maximumScreenSpaceError: number };
  readonly preUpdate?: {
    addEventListener(listener: () => void): (() => void) | undefined;
  };
  readonly postRender?: {
    addEventListener(listener: () => void): (() => void) | undefined;
  };
  requestRender(): void;
}

interface QualityView {
  resolutionScale: number;
  readonly scene: QualityScene;
}

/** @internal */
export interface CesiumQualityControllerOptions {
  readonly viewer: QualityView;
  /** 模型加载限制器；质量档会同步调整它的并发上限。 */
  readonly limiter: LoadLimiter;
  readonly initial: RenderQuality;
  readonly adaptive: boolean;
  readonly targetFps?: number;
  readonly bounds?: RenderQualityBounds;
  /** 长帧读数阈值；省略时由质量监测取默认值 50。 */
  readonly longFrameMs?: number;
  /** 帧时间来源，默认 `performance.now()`。 */
  readonly now?: () => number;
}

function equalQuality(left: RenderQuality, right: RenderQuality): boolean {
  return (
    left.resolutionScale === right.resolutionScale &&
    left.terrainSse === right.terrainSse &&
    left.modelLoadConcurrency === right.modelLoadConcurrency
  );
}

/**
 * 把质量档写入 Cesium 渲染参数，并按帧采样结果自动升降档。
 *
 * @internal
 */
export class CesiumQualityController implements QualityController {
  private readonly monitor: RenderQualityMonitor;
  private readonly viewer: QualityView;
  private readonly limiter: LoadLimiter;
  private readonly now: () => number;
  private applied: RenderQuality;
  private removeUpdate: (() => void) | undefined;
  private removeRender: (() => void) | undefined;
  private updateIndex = 0;
  private renderedIndex = -1;
  private started = false;

  constructor(private readonly options: CesiumQualityControllerOptions) {
    this.viewer = options.viewer;
    this.limiter = options.limiter;
    this.now = options.now ?? (() => performance.now());
    this.monitor = new RenderQualityMonitor({
      initial: options.initial,
      adaptive: options.adaptive,
      ...(options.targetFps === undefined ? {} : { targetFps: options.targetFps }),
      ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
      ...(options.longFrameMs === undefined ? {} : { longFrameMs: options.longFrameMs }),
    });
    this.applied = options.initial;
    this.apply(options.initial);
  }

  get current(): RenderQuality {
    return this.monitor.current;
  }

  get snapshot(): QualitySnapshot {
    return this.monitor.getSnapshot();
  }

  get adaptive(): boolean {
    return this.snapshot.adaptive;
  }

  setProfile(profile: QualityProfileId): void {
    this.applyQuality(this.monitor.setQuality(resolveRenderQuality(profile, {}, 'setProfile')));
  }

  set(quality: Partial<RenderQuality>): void {
    this.applyQuality(this.monitor.setQuality(quality));
  }

  setAdaptive(enabled: boolean): void {
    this.monitor.setAdaptive(enabled);
  }

  /** 订阅场景帧事件；重复调用不会重复订阅。 */
  start(): void {
    if (this.started) {
      return;
    }
    const scene = this.viewer.scene;
    this.started = true;
    try {
      this.removeUpdate = scene.preUpdate?.addEventListener(() => {
        this.updateIndex += 1;
      });
      this.removeRender = scene.postRender?.addEventListener(() => {
        // 只有"每次场景更新都紧跟着一次渲染"时才采信帧间隔，避免暂停与一次性卡顿被当成性能下降。
        const continuous = this.updateIndex === this.renderedIndex + 1;
        this.renderedIndex = this.updateIndex;
        const snapshot = this.monitor.sample(this.now(), continuous);
        if (equalQuality(snapshot, this.applied)) {
          return;
        }
        this.apply(snapshot);
      });
    } catch (cause: unknown) {
      this.dispose();
      throw cause;
    }
  }

  /** 移除帧事件监听；不会改动已生效的渲染参数。 */
  dispose(): void {
    const removeUpdate = this.removeUpdate;
    const removeRender = this.removeRender;
    this.removeUpdate = undefined;
    this.removeRender = undefined;
    this.started = false;
    removeUpdate?.();
    removeRender?.();
  }

  private applyQuality(snapshot: QualitySnapshot): void {
    this.apply(snapshot);
    this.viewer.scene.requestRender();
  }

  private apply(quality: RenderQuality): void {
    validateRenderQuality(quality, 'set');
    this.viewer.resolutionScale = quality.resolutionScale;
    this.viewer.scene.globe.maximumScreenSpaceError = quality.terrainSse;
    this.limiter.setConcurrency(quality.modelLoadConcurrency);
    this.applied = { ...quality };
  }
}
