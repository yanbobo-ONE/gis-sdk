import { SceneMode } from 'cesium';
import type { Scene } from 'cesium';

import type { MapSceneMode, SceneController } from '../core/controls.js';
import { GisError } from '../core/errors.js';

type SceneLike = Pick<Scene, 'mode' | 'morphTo2D' | 'morphTo3D' | 'morphComplete'>;

function invalidDuration(): GisError {
  return new GisError('Scene morph duration must be a non-negative finite number of seconds.', {
    code: 'INVALID_SCENE_CONFIG',
    module: 'scene',
    operation: 'setMode',
  });
}

function superseded(): GisError {
  return new GisError('Scene morph was superseded by another mode change.', {
    code: 'SCENE_MORPH_SUPERSEDED',
    module: 'scene',
    operation: 'setMode',
    retryable: true,
  });
}

function disposed(): GisError {
  return new GisError('Scene controller has been disposed.', {
    code: 'MAP_DISPOSED',
    module: 'scene',
    operation: 'setMode',
  });
}

/**
 * Cesium 侧场景模式控制器。
 *
 * 直接使用 Cesium 的 `morphTo2D` / `morphTo3D`：一次形变完成才结算 Promise。
 * 需要"无闪烁切换"的业务可以先用 `map.capture()` 抓一张过渡图，再调用 `setMode()`。
 *
 * @internal
 */
export class CesiumSceneController implements SceneController {
  private pending:
    | {
        readonly mode: MapSceneMode;
        readonly resolve: () => void;
        readonly reject: (error: GisError) => void;
      }
    | undefined;
  private removeMorphComplete: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly scene: SceneLike) {}

  get mode(): MapSceneMode {
    if (this.pending) {
      // 形变过程中对外返回目标模式；Cesium 此时报的是 MORPHING。
      return this.pending.mode;
    }
    return this.scene.mode === SceneMode.SCENE2D ? '2d' : '3d';
  }

  /** 是否形变在途；只反映由 SDK 发起的切换（Cesium 未公开 `morphing` 字段）。 */
  get morphing(): boolean {
    return this.pending !== undefined;
  }

  setMode(mode: MapSceneMode, duration?: number): Promise<void> {
    if (this.disposed) {
      return Promise.reject(disposed());
    }
    // 类型上只有两个取值，运行时（JS 调用方）仍可能传入别的字符串。
    const requested: unknown = mode;
    if (requested !== '2d' && requested !== '3d') {
      return Promise.reject(
        new GisError(
          `Unsupported scene mode "${typeof requested === 'string' ? requested : typeof requested}"; use "2d" or "3d".`,
          {
            code: 'INVALID_SCENE_CONFIG',
            module: 'scene',
            operation: 'setMode',
          },
        ),
      );
    }
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 0)) {
      return Promise.reject(invalidDuration());
    }

    // 已经处于目标模式且没有形变在途：直接结算，不触发一次多余形变。
    if (!this.morphing && this.mode === mode) {
      return Promise.resolve();
    }

    this.rejectPending(superseded());
    return new Promise<void>((resolve, reject) => {
      this.pending = { mode, resolve, reject };
      this.removeMorphComplete = this.scene.morphComplete.addEventListener(() => {
        this.finish();
      });
      try {
        if (mode === '2d') {
          this.scene.morphTo2D(duration);
        } else {
          this.scene.morphTo3D(duration);
        }
      } catch (cause: unknown) {
        this.rejectPending(
          new GisError('Failed to start scene morph.', {
            code: 'INVALID_SCENE_CONFIG',
            module: 'scene',
            operation: 'setMode',
            cause,
          }),
        );
      }
    });
  }

  /** 拒绝尚未结算的形变并解绑监听；不再等待 Cesium 的形变结束。 */
  destroy(): void {
    this.disposed = true;
    this.rejectPending(disposed());
  }

  private finish(): void {
    const pending = this.pending;
    this.pending = undefined;
    this.removeMorphComplete?.();
    this.removeMorphComplete = undefined;
    pending?.resolve();
  }

  private rejectPending(error: GisError): void {
    const pending = this.pending;
    this.pending = undefined;
    this.removeMorphComplete?.();
    this.removeMorphComplete = undefined;
    pending?.reject(error);
  }
}
