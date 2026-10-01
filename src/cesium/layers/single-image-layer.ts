import { Rectangle, SingleTileImageryProvider } from 'cesium';
import type { ImageryLayer, Viewer } from 'cesium';

import { GisError } from '../../core/errors.js';
import type { EventHub } from '../../core/event-hub.js';
import type {
  ImageryLayerHandle,
  LayerEventMap,
  LayerStacking,
  LayerState,
  SingleImageLayerSpec,
  SingleImageRectangle,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import { watchImageryErrors } from './imagery-error-watch.js';
import type { ImageryErrorWatch } from './imagery-error-watch.js';
import { createImageryStacking } from './imagery-stacking.js';

function operationAborted(id: string, cause?: unknown): GisError {
  return new GisError(`Layer "${id}" operation was aborted.`, {
    code: 'LAYER_OPERATION_ABORTED',
    module: 'layer',
    operation: 'add',
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

function validateOpacity(value: number, id: string, operation: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new GisError(`Layer "${id}" opacity must be between 0 and 1.`, {
      code: 'INVALID_LAYER_OPACITY',
      module: 'layer',
      operation,
    });
  }
  return value;
}

function normalizeUrl(url: string, id: string): string {
  const normalized = url.trim();
  if (!normalized) {
    throw new GisError(`Single image layer "${id}" requires a non-empty URL.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }
  return normalized;
}

function createRectangle(
  value: SingleImageRectangle | undefined,
  id: string,
): Rectangle | undefined {
  if (value === undefined) {
    return undefined;
  }
  const { west, south, east, north } = value;
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    throw new GisError(`Single image layer "${id}" rectangle must be valid WGS84 degree bounds.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }
  return Rectangle.fromDegrees(west, south, east, north);
}

class CesiumSingleImageLayerHandle implements ImageryLayerHandle {
  private readonly lifecycle: LayerHandleRuntime;
  private readonly errorWatch: ImageryErrorWatch;
  private readonly stacking: LayerStacking;
  private currentOpacity: number;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    private readonly currentLayer: ImageryLayer,
    visible: boolean,
    opacity: number,
    onDisposed: () => void,
  ) {
    this.currentOpacity = opacity;
    this.lifecycle = new LayerHandleRuntime({
      id,
      type: 'single-image',
      visible,
      onSetVisible: (nextVisible) => {
        this.currentLayer.show = nextVisible;
      },
      onDispose: () => {
        this.errorWatch.dispose();
        this.viewer.imageryLayers.remove(this.currentLayer, true);
      },
      onDisposed,
    });
    this.errorWatch = watchImageryErrors(currentLayer, (cause: unknown) => {
      this.lifecycle.recordError(cause);
    });
    this.stacking = createImageryStacking(viewer, () => this.currentLayer);
  }

  readonly type = 'single-image' as const;

  get state(): LayerState {
    return this.lifecycle.state;
  }

  get visible(): boolean {
    return this.lifecycle.visible;
  }

  get opacity(): number {
    return this.currentOpacity;
  }

  get events(): EventHub<LayerEventMap> {
    return this.lifecycle.events;
  }

  get errorCount(): number {
    return this.lifecycle.errorCount;
  }

  get stackIndex(): number | undefined {
    return this.stacking.stackIndex;
  }

  raise(): boolean {
    this.lifecycle.assertUsable('raise');
    return this.stacking.raise();
  }

  lower(): boolean {
    this.lifecycle.assertUsable('lower');
    return this.stacking.lower();
  }

  raiseToTop(): boolean {
    this.lifecycle.assertUsable('raiseToTop');
    return this.stacking.raiseToTop();
  }

  lowerToBottom(): boolean {
    this.lifecycle.assertUsable('lowerToBottom');
    return this.stacking.lowerToBottom();
  }

  setVisible(visible: boolean): void {
    this.lifecycle.setVisible(visible);
  }

  setOpacity(opacity: number): void {
    this.lifecycle.assertUsable('setOpacity');
    const normalizedOpacity = validateOpacity(opacity, this.id, 'setOpacity');
    this.currentLayer.alpha = normalizedOpacity;
    this.currentOpacity = normalizedOpacity;
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }
}

/** @internal */
export async function createSingleImageLayer(
  viewer: Viewer,
  spec: SingleImageLayerSpec,
  context: LayerFactoryContext,
): Promise<ImageryLayerHandle> {
  try {
    if (context.signal.aborted) {
      throw operationAborted(spec.id, context.signal.reason);
    }
    const url = normalizeUrl(spec.url, spec.id);
    const opacity = validateOpacity(spec.opacity ?? 1, spec.id, 'add');
    const rectangle = createRectangle(spec.rectangle, spec.id);
    const provider = await raceAbort(
      SingleTileImageryProvider.fromUrl(url, rectangle === undefined ? {} : { rectangle }),
      context.signal,
    );
    const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.show = spec.visible ?? true;
    imageryLayer.alpha = opacity;
    return new CesiumSingleImageLayerHandle(
      viewer,
      spec.id,
      imageryLayer,
      spec.visible ?? true,
      opacity,
      context.onDisposed,
    );
  } catch (cause: unknown) {
    if (cause instanceof GisError) {
      return Promise.reject(cause);
    }
    if (context.signal.aborted) {
      return Promise.reject(operationAborted(spec.id, cause));
    }
    return Promise.reject(
      new GisError(`Failed to add single image layer "${spec.id}".`, {
        code: 'LAYER_LOAD_FAILED',
        module: 'layer',
        operation: 'add',
        retryable: true,
        cause,
      }),
    );
  }
}
