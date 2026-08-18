import { GisError } from '../core/errors.js';
import type {
  LayerHandle,
  LayerHandleFor,
  LayerInfo,
  LayerManager,
  LayerSpec,
  OperationOptions,
} from './contracts.js';

/** @internal */
export interface LayerFactoryContext {
  readonly signal: AbortSignal;
  readonly onDisposed: () => void;
}

/** @internal */
export type LayerFactory = (spec: LayerSpec, context: LayerFactoryContext) => Promise<LayerHandle>;

interface PendingLayer {
  readonly controller: AbortController;
  promise: Promise<LayerHandle>;
}

function layerError(
  message: string,
  code:
    | 'INVALID_LAYER_ID'
    | 'DUPLICATE_LAYER_ID'
    | 'LAYER_MANAGER_BUSY'
    | 'LAYER_MANAGER_DISPOSED'
    | 'LAYER_OPERATION_ABORTED'
    | 'LAYER_LOAD_FAILED'
    | 'LAYER_CLEAR_FAILED',
  operation: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): GisError {
  return new GisError(message, {
    code,
    module: 'layer',
    operation,
    ...options,
  });
}

/** @internal */
export class LayerRuntime implements LayerManager {
  private readonly handles = new Map<string, LayerHandle>();
  private readonly pending = new Map<string, PendingLayer>();
  private clearPromise: Promise<void> | undefined;
  private destroyPromise: Promise<void> | undefined;
  private clearing = false;
  private destroying = false;
  private destroyed = false;

  constructor(private readonly factory: LayerFactory) {}

  async add<TSpec extends LayerSpec>(
    spec: TSpec,
    options: OperationOptions = {},
  ): Promise<LayerHandleFor<TSpec>> {
    this.assertActive('add');
    const id = spec.id.trim();
    if (!id) {
      throw layerError('Layer id must be a non-empty string.', 'INVALID_LAYER_ID', 'add');
    }
    if (this.handles.has(id) || this.pending.has(id)) {
      throw layerError(`Layer id "${id}" already exists.`, 'DUPLICATE_LAYER_ID', 'add');
    }

    const normalizedSpec = { ...spec, id } as TSpec;
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternal = () => {
      controller.abort(externalSignal?.reason);
    };
    if (externalSignal?.aborted) {
      abortFromExternal();
    } else {
      externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    }

    let createdHandle: LayerHandle | undefined;
    const pendingLayer: PendingLayer = {
      controller,
      promise: Promise.resolve(undefined as never),
    };
    this.pending.set(id, pendingLayer);

    const creation = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          throw controller.signal.reason;
        }
        return this.factory(normalizedSpec, {
          signal: controller.signal,
          onDisposed: () => {
            if (!createdHandle || this.handles.get(id) === createdHandle) {
              this.handles.delete(id);
            }
          },
        });
      })
      .then(async (handle) => {
        createdHandle = handle;
        if (controller.signal.aborted || this.destroying || this.destroyed) {
          await handle.dispose();
          throw controller.signal.reason;
        }
        this.handles.set(id, handle);
        return handle;
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || this.destroying || this.destroyed) {
          throw layerError(`Adding layer "${id}" was aborted.`, 'LAYER_OPERATION_ABORTED', 'add', {
            cause,
          });
        }
        if (cause instanceof GisError) {
          throw cause;
        }
        throw layerError(`Failed to load layer "${id}".`, 'LAYER_LOAD_FAILED', 'add', {
          retryable: true,
          cause,
        });
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', abortFromExternal);
        if (this.pending.get(id) === pendingLayer) {
          this.pending.delete(id);
        }
      });

    pendingLayer.promise = creation;
    return (await creation) as LayerHandleFor<TSpec>;
  }

  get(id: string): LayerHandle | undefined {
    return this.handles.get(id.trim());
  }

  list(): readonly LayerInfo[] {
    return [...this.handles.values()].map((handle) => ({
      id: handle.id,
      type: handle.type,
      state: handle.state,
      visible: handle.visible,
    }));
  }

  async remove(id: string): Promise<boolean> {
    this.assertActive('remove');
    const normalizedId = id.trim();
    const pending = this.pending.get(normalizedId);
    if (pending) {
      pending.controller.abort('Layer removed while loading.');
      await pending.promise.catch(() => undefined);
      return true;
    }

    const handle = this.handles.get(normalizedId);
    if (!handle) {
      return false;
    }
    await handle.dispose();
    this.handles.delete(normalizedId);
    return true;
  }

  clear(): Promise<void> {
    if (this.clearPromise) {
      return this.clearPromise;
    }
    this.assertActive('clear');
    return this.clearAll();
  }

  /** Permanently closes the manager after disposing all owned layers. */
  destroy(): Promise<void> {
    if (this.destroyed) {
      return Promise.resolve();
    }
    if (this.destroyPromise) {
      return this.destroyPromise;
    }

    this.destroying = true;
    this.destroyPromise = this.clearAll().then(
      () => {
        this.destroyed = true;
        this.destroying = false;
      },
      (error: unknown) => {
        this.destroying = false;
        this.destroyPromise = undefined;
        throw error;
      },
    );
    return this.destroyPromise;
  }

  private clearAll(): Promise<void> {
    if (this.clearPromise) {
      return this.clearPromise;
    }

    this.clearing = true;
    this.clearPromise = Promise.resolve()
      .then(async () => {
        const pending = [...this.pending.values()];
        for (const layer of pending) {
          layer.controller.abort('Layer manager is clearing.');
        }
        await Promise.allSettled(pending.map((layer) => layer.promise));

        const results = await Promise.allSettled(
          [...this.handles.values()].map((handle) => handle.dispose()),
        );
        const failures: unknown[] = [];
        for (const result of results) {
          if (result.status === 'rejected') {
            failures.push(result.reason as unknown);
          }
        }
        if (failures.length > 0) {
          throw layerError(
            'One or more layers could not be disposed.',
            'LAYER_CLEAR_FAILED',
            'clear',
            {
              retryable: true,
              cause: new AggregateError(failures, 'Layer cleanup failed.'),
            },
          );
        }
      })
      .finally(() => {
        this.clearing = false;
        this.clearPromise = undefined;
      });

    return this.clearPromise;
  }

  private assertActive(operation: string): void {
    if (this.destroying || this.destroyed) {
      throw layerError('Layer manager has been disposed.', 'LAYER_MANAGER_DISPOSED', operation);
    }
    if (this.clearing) {
      throw layerError('Layer manager is clearing.', 'LAYER_MANAGER_BUSY', operation, {
        retryable: true,
      });
    }
  }
}
