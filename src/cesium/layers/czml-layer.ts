import { CzmlDataSource } from 'cesium';
import type { DataSource, Viewer } from 'cesium';

import { GisError } from '../../core/errors.js';
import type {
  CzmlLayerHandle,
  CzmlLayerSpec,
  CzmlSource,
  LayerEventMap,
  LayerState,
  OperationOptions,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import type { EventHub } from '../../core/event-hub.js';

function operationAborted(id: string, operation: string, cause?: unknown): GisError {
  return new GisError(`Layer "${id}" operation was aborted.`, {
    code: 'LAYER_OPERATION_ABORTED',
    module: 'layer',
    operation,
    cause,
  });
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Operation aborted.', { cause: reason });
}

/** 把 `AbortSignal` 与一次 Promise 绑定；中止时立即以 `LAYER_OPERATION_ABORTED` 语义拒绝。 */
function linkedController(signal: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly unlink: () => void;
} {
  const controller = new AbortController();
  if (!signal) {
    return { controller, unlink: () => undefined };
  }
  if (signal.aborted) {
    controller.abort(abortReason(signal.reason));
    return { controller, unlink: () => undefined };
  }
  const onAbort = (): void => {
    controller.abort(abortReason(signal.reason));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    controller,
    unlink: () => {
      signal.removeEventListener('abort', onAbort);
    },
  };
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 解析 CZML 源：数组直接用，字符串按 URL 拉取 JSON。 */
async function resolveSource(source: CzmlSource, signal: AbortSignal): Promise<unknown> {
  if (Array.isArray(source)) {
    return source;
  }
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new GisError('CZML layer data must be a document array or a non-empty URL.', {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'load',
    });
  }
  const response = await fetch(source, { signal });
  if (!response.ok) {
    throw new GisError(`CZML request failed with status ${String(response.status)}.`, {
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation: 'load',
      retryable: true,
    });
  }
  return await response.json();
}

/** Cesium 的 `dataSources.add` 返回 Promise，但取消时资源仍会稍后加入：这种情况要补一次移除。 */
function removeLateDataSource(viewer: Viewer, adding: Promise<DataSource>): void {
  void adding
    .then((dataSource) => {
      viewer.dataSources.remove(dataSource, true);
    })
    .catch(() => undefined);
}

async function loadDataSource(
  id: string,
  source: CzmlSource,
  signal: AbortSignal,
  operation: string,
): Promise<CzmlDataSource> {
  try {
    const data = await resolveSource(source, signal);
    return await raceAbort(CzmlDataSource.load(data), signal);
  } catch (cause: unknown) {
    if (signal.aborted) {
      throw operationAborted(id, operation, cause);
    }
    if (cause instanceof GisError) {
      throw cause;
    }
    throw new GisError(`Failed to load CZML for layer "${id}".`, {
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation,
      retryable: true,
      cause,
    });
  }
}

class CesiumCzmlLayerHandle implements CzmlLayerHandle {
  readonly type = 'czml' as const;

  private readonly lifecycle: LayerHandleRuntime;
  private currentDataSource: CzmlDataSource;
  private updateController: AbortController | undefined;
  private updatePromise: Promise<void> | undefined;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    initialDataSource: CzmlDataSource,
    visible: boolean,
    onDisposed: () => void,
  ) {
    this.currentDataSource = initialDataSource;
    this.lifecycle = new LayerHandleRuntime({
      id,
      type: this.type,
      visible,
      onSetVisible: (nextVisible) => {
        this.currentDataSource.show = nextVisible;
      },
      onDispose: () => this.disposeResources(),
      onDisposed,
    });
  }

  get state(): LayerState {
    return this.lifecycle.state;
  }

  get visible(): boolean {
    return this.lifecycle.visible;
  }

  get events(): EventHub<LayerEventMap> {
    return this.lifecycle.events;
  }

  get errorCount(): number {
    return this.lifecycle.errorCount;
  }

  get entityCount(): number {
    return this.currentDataSource.entities.values.length;
  }

  setVisible(visible: boolean): void {
    this.lifecycle.setVisible(visible);
  }

  setData(data: CzmlSource, options: OperationOptions = {}): Promise<void> {
    this.lifecycle.assertUsable('setData');
    if (this.updatePromise) {
      return Promise.reject(
        new GisError(`Layer "${this.id}" is already replacing its data.`, {
          code: 'LAYER_BUSY',
          module: 'layer',
          operation: 'setData',
          retryable: true,
        }),
      );
    }

    this.lifecycle.beginLoading('setData');
    const { controller, unlink } = linkedController(options.signal);
    this.updateController = controller;
    const update = this.replaceData(data, controller.signal).then(
      () => {
        this.lifecycle.completeLoading();
      },
      (error: unknown) => {
        // 取消是正常结果：旧文档仍然生效，图层回到稳定状态而不是错误状态。
        if (error instanceof GisError && error.code === 'LAYER_OPERATION_ABORTED') {
          this.lifecycle.completeLoading();
        } else {
          this.lifecycle.failLoading();
        }
        throw error;
      },
    );
    this.updatePromise = update.finally(() => {
      unlink();
      if (this.updateController === controller) {
        this.updateController = undefined;
        this.updatePromise = undefined;
      }
    });
    return this.updatePromise;
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  private async replaceData(data: CzmlSource, signal: AbortSignal): Promise<void> {
    const candidate = await loadDataSource(this.id, data, signal, 'setData');
    candidate.show = this.visible;
    let added = false;
    let adding: Promise<DataSource> | undefined;
    try {
      adding = this.viewer.dataSources.add(candidate);
      await raceAbort(adding, signal);
      added = true;
      if (signal.aborted) {
        throw operationAborted(this.id, 'setData', signal.reason);
      }

      const previous = this.currentDataSource;
      this.currentDataSource = candidate;
      this.viewer.dataSources.remove(previous, true);
    } catch (cause: unknown) {
      if (added) {
        this.viewer.dataSources.remove(candidate, true);
      } else if (adding) {
        removeLateDataSource(this.viewer, adding);
      }
      if (cause instanceof GisError) {
        throw cause;
      }
      if (signal.aborted) {
        throw operationAborted(this.id, 'setData', cause);
      }
      throw new GisError(`Failed to replace CZML for layer "${this.id}".`, {
        code: 'LAYER_LOAD_FAILED',
        module: 'layer',
        operation: 'setData',
        retryable: true,
        cause,
      });
    }
  }

  private async disposeResources(): Promise<void> {
    this.updateController?.abort('Layer disposed.');
    await this.updatePromise?.catch(() => undefined);
    this.viewer.dataSources.remove(this.currentDataSource, true);
  }
}

/** @internal */
export async function createCzmlLayer(
  viewer: Viewer,
  spec: CzmlLayerSpec,
  context: LayerFactoryContext,
): Promise<CzmlLayerHandle> {
  const visible = spec.visible ?? true;
  const dataSource = await loadDataSource(spec.id, spec.data, context.signal, 'add');
  dataSource.show = visible;

  let added = false;
  let adding: Promise<DataSource> | undefined;
  try {
    adding = viewer.dataSources.add(dataSource);
    await raceAbort(adding, context.signal);
    added = true;
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', context.signal.reason);
    }
    return new CesiumCzmlLayerHandle(viewer, spec.id, dataSource, visible, context.onDisposed);
  } catch (cause: unknown) {
    if (added) {
      viewer.dataSources.remove(dataSource, true);
    } else if (adding) {
      removeLateDataSource(viewer, adding);
    }
    if (cause instanceof GisError) {
      throw cause;
    }
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', cause);
    }
    throw new GisError(`Failed to add CZML layer "${spec.id}".`, {
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation: 'add',
      retryable: true,
      cause,
    });
  }
}
