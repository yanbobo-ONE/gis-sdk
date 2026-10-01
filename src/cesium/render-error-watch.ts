import { GisError } from '../core/errors.js';

/** Cesium 的渲染错误事件；`Scene` 在渲染循环抛出后触发一次，随后停止渲染。 */
interface RenderErrorSource {
  readonly renderError: {
    addEventListener(listener: (scene: unknown, error: unknown) => void): () => void;
  };
}

/** 渲染循环致命错误的观察器。 */
export interface RenderErrorWatch {
  /** 接入错误上报入口；在它被设置之前发生的失败会保留到设置之后再上报。 */
  setReporter(reporter: (error: GisError) => void): void;
  /** 停止观察。 */
  dispose(): void;
}

/**
 * 把引擎渲染循环的致命错误转成 SDK 错误。
 *
 * Cesium 在渲染循环里抛出后会**停掉渲染**并弹出自己的错误面板，但业务侧只看到"画面不动了"：
 * 地图状态、图层状态都还停在原地，没有任何事件。这里把它接进 SDK 的错误通道，
 * 让业务至少能知道"渲染已经停了"，而不是把它当成画面卡顿去查。
 *
 * 只在第一次上报：Cesium 触发这个事件后就停止渲染，重复上报只会刷屏。
 *
 * @internal
 */
export function watchRenderErrors(scene: RenderErrorSource): RenderErrorWatch {
  let reporter: ((error: GisError) => void) | undefined;
  let pending: GisError | undefined;
  let reported = false;
  const remove = scene.renderError.addEventListener((_scene, error: unknown) => {
    if (reported) {
      return;
    }
    reported = true;
    const failure = new GisError('Rendering stopped after an unrecoverable engine error.', {
      code: 'RENDER_LOOP_FAILED',
      module: 'scene',
      operation: 'render',
      cause: error,
    });
    if (reporter) {
      reporter(failure);
    } else {
      // 上报入口还没接上（例如失败发生在 createMap 过程中）：留到接上之后再报，别丢掉。
      pending = failure;
    }
  });
  return {
    setReporter: (next) => {
      reporter = next;
      if (pending) {
        const failure = pending;
        pending = undefined;
        next(failure);
      }
    },
    dispose: () => {
      remove();
    },
  };
}
