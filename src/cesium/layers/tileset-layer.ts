import { Cesium3DTileset } from 'cesium';
import type { Viewer } from 'cesium';

import { GisError } from '../../core/errors.js';
import type { EventHub } from '../../core/event-hub.js';
import type {
  LayerEventMap,
  LayerHandle,
  LayerState,
  Tiles3dLayerSpec,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';

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

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal.reason));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function normalizeConfig(spec: Tiles3dLayerSpec): {
  readonly url: string;
  readonly options: Cesium3DTileset.ConstructorOptions;
} {
  const url = typeof spec.url === 'string' ? spec.url.trim() : '';
  if (!url) {
    throw new GisError(`3D Tiles layer "${spec.id}" requires a non-empty URL.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }

  const options: Cesium3DTileset.ConstructorOptions = {};
  if (spec.maximumScreenSpaceError !== undefined) {
    if (!Number.isFinite(spec.maximumScreenSpaceError) || spec.maximumScreenSpaceError <= 0) {
      throw new GisError(
        `3D Tiles layer "${spec.id}" maximumScreenSpaceError must be a positive finite number.`,
        {
          code: 'INVALID_LAYER_CONFIG',
          module: 'layer',
          operation: 'add',
        },
      );
    }
    options.maximumScreenSpaceError = spec.maximumScreenSpaceError;
  }
  if (spec.skipLevelOfDetail !== undefined) {
    if (typeof spec.skipLevelOfDetail !== 'boolean') {
      throw new GisError(`3D Tiles layer "${spec.id}" skipLevelOfDetail must be a boolean.`, {
        code: 'INVALID_LAYER_CONFIG',
        module: 'layer',
        operation: 'add',
      });
    }
    options.skipLevelOfDetail = spec.skipLevelOfDetail;
  }
  return { url, options };
}

function destroyTileset(tileset: Cesium3DTileset): void {
  tileset.destroy();
}

function removeTileset(viewer: Viewer, tileset: Cesium3DTileset): void {
  const removed = viewer.scene.primitives.remove(tileset);
  if (!removed) {
    destroyTileset(tileset);
  }
}

function destroyLateTileset(loading: Promise<Cesium3DTileset>): void {
  void loading
    .then((tileset) => {
      destroyTileset(tileset);
    })
    .catch(() => undefined);
}

class CesiumTiles3dLayerHandle implements LayerHandle {
  readonly type = '3d-tiles' as const;

  private readonly lifecycle: LayerHandleRuntime;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    private readonly tileset: Cesium3DTileset,
    visible: boolean,
    onDisposed: () => void,
  ) {
    this.lifecycle = new LayerHandleRuntime({
      id,
      type: this.type,
      visible,
      onSetVisible: (nextVisible) => {
        this.tileset.show = nextVisible;
      },
      onDispose: () => {
        removeTileset(this.viewer, this.tileset);
      },
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

  setVisible(visible: boolean): void {
    this.lifecycle.setVisible(visible);
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }
}

/** @internal */
export async function createTiles3dLayer(
  viewer: Viewer,
  spec: Tiles3dLayerSpec,
  context: LayerFactoryContext,
): Promise<LayerHandle> {
  let loading: Promise<Cesium3DTileset> | undefined;
  let tileset: Cesium3DTileset | undefined;
  let added = false;

  try {
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', context.signal.reason);
    }
    const { url, options } = normalizeConfig(spec);
    const visible = spec.visible ?? true;
    loading = Cesium3DTileset.fromUrl(url, options);
    tileset = await raceAbort(loading, context.signal);

    tileset.show = visible;
    viewer.scene.primitives.add(tileset);
    added = true;
    return new CesiumTiles3dLayerHandle(viewer, spec.id, tileset, visible, context.onDisposed);
  } catch (cause: unknown) {
    if (added && tileset) {
      removeTileset(viewer, tileset);
    } else if (tileset) {
      destroyTileset(tileset);
    } else if (loading && context.signal.aborted) {
      destroyLateTileset(loading);
    }
    if (cause instanceof GisError) {
      throw cause;
    }
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', cause);
    }
    throw new GisError(`Failed to load 3D Tiles for layer "${spec.id}".`, {
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation: 'add',
      retryable: true,
      cause,
    });
  }
}
