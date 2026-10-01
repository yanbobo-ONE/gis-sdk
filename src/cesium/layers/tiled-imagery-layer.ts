import { TileMapServiceImageryProvider, WebMapTileServiceImageryProvider } from 'cesium';
import type { ImageryLayer, ImageryProvider, Resource as CesiumResource, Viewer } from 'cesium';

import { GisError } from '../../core/errors.js';
import { normalizeRequestHeaders, withRequestHeaders } from './request-headers.js';
import type { EventHub } from '../../core/event-hub.js';
import type {
  ImageryLayerHandle,
  LayerEventMap,
  LayerStacking,
  LayerState,
  TmsLayerSpec,
  WmtsLayerSpec,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import { watchImageryErrors } from './imagery-error-watch.js';
import type { ImageryErrorWatch } from './imagery-error-watch.js';
import { createImageryStacking } from './imagery-stacking.js';

type TmsProviderOptions = NonNullable<Parameters<typeof TileMapServiceImageryProvider.fromUrl>[1]>;
type WmtsProviderOptions = ConstructorParameters<typeof WebMapTileServiceImageryProvider>[0];

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

function validateLevel(value: number | undefined, name: string, id: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new GisError(`Layer "${id}" ${name} must be a non-negative integer.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }
  return value;
}

function validateDimension(
  value: number | undefined,
  name: string,
  id: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new GisError(`Layer "${id}" ${name} must be a positive integer.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }
  return value;
}

function validateLevelRange(
  minimumLevel: number | undefined,
  maximumLevel: number | undefined,
  id: string,
): void {
  if (minimumLevel !== undefined && maximumLevel !== undefined && maximumLevel < minimumLevel) {
    throw new GisError(`Layer "${id}" maximumLevel must not be below minimumLevel.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }
}

function normalizeUrl(url: string, id: string): string {
  const normalized = url.trim();
  if (!normalized) {
    throw new GisError(`Tiled imagery layer "${id}" requires a non-empty URL.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }
  return normalized;
}

function normalizeTms(spec: TmsLayerSpec): {
  readonly url: string | CesiumResource;
  readonly options: TmsProviderOptions;
} {
  const url = normalizeUrl(spec.url, spec.id);
  const minimumLevel = validateLevel(spec.minimumLevel, 'minimumLevel', spec.id);
  const maximumLevel = validateLevel(spec.maximumLevel, 'maximumLevel', spec.id);
  validateLevelRange(minimumLevel, maximumLevel, spec.id);
  const tileWidth = validateDimension(spec.tileWidth, 'tileWidth', spec.id);
  const tileHeight = validateDimension(spec.tileHeight, 'tileHeight', spec.id);
  const options: TmsProviderOptions = {};
  if (spec.fileExtension?.trim()) options.fileExtension = spec.fileExtension.trim();
  if (minimumLevel !== undefined) options.minimumLevel = minimumLevel;
  if (maximumLevel !== undefined) options.maximumLevel = maximumLevel;
  if (tileWidth !== undefined) options.tileWidth = tileWidth;
  if (tileHeight !== undefined) options.tileHeight = tileHeight;
  if (spec.flipXY !== undefined) options.flipXY = spec.flipXY;
  return { url: withRequestHeaders(url, normalizeRequestHeaders(spec.headers, spec.id)), options };
}

function normalizeWmts(spec: WmtsLayerSpec): {
  readonly url: string | CesiumResource;
  readonly options: WmtsProviderOptions;
} {
  const url = normalizeUrl(spec.url, spec.id);
  const layer = spec.layer.trim();
  const style = spec.style.trim();
  const tileMatrixSetID = spec.tileMatrixSetID.trim();
  if (!layer || !style || !tileMatrixSetID) {
    throw new GisError(
      `WMTS layer "${spec.id}" requires non-empty layer, style, and tileMatrixSetID.`,
      {
        code: 'INVALID_LAYER_CONFIG',
        module: 'layer',
        operation: 'add',
      },
    );
  }

  const minimumLevel = validateLevel(spec.minimumLevel, 'minimumLevel', spec.id);
  const maximumLevel = validateLevel(spec.maximumLevel, 'maximumLevel', spec.id);
  validateLevelRange(minimumLevel, maximumLevel, spec.id);
  const tileMatrixLabels = spec.tileMatrixLabels?.map((label) => label.trim());
  if (tileMatrixLabels?.some((label) => !label)) {
    throw new GisError(`WMTS layer "${spec.id}" contains an empty tileMatrix label.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }
  const options: WmtsProviderOptions = {
    url,
    layer,
    style,
    tileMatrixSetID,
  };
  if (spec.format?.trim()) options.format = spec.format.trim();
  if (spec.enablePickFeatures !== undefined) options.enablePickFeatures = spec.enablePickFeatures;
  if (minimumLevel !== undefined) options.minimumLevel = minimumLevel;
  if (maximumLevel !== undefined) options.maximumLevel = maximumLevel;
  if (tileMatrixLabels !== undefined) options.tileMatrixLabels = tileMatrixLabels;
  if (spec.subdomains !== undefined) {
    options.subdomains =
      typeof spec.subdomains === 'string' ? spec.subdomains : [...spec.subdomains];
  }
  return { url: withRequestHeaders(url, normalizeRequestHeaders(spec.headers, spec.id)), options };
}

class CesiumTiledImageryLayerHandle implements ImageryLayerHandle {
  private readonly lifecycle: LayerHandleRuntime;
  private readonly errorWatch: ImageryErrorWatch;
  private readonly stacking: LayerStacking;
  private currentOpacity: number;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    readonly type: 'tms' | 'wmts',
    private readonly currentLayer: ImageryLayer,
    visible: boolean,
    opacity: number,
    onDisposed: () => void,
  ) {
    this.currentOpacity = opacity;
    this.lifecycle = new LayerHandleRuntime({
      id,
      type,
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

function createHandle(
  viewer: Viewer,
  id: string,
  type: 'tms' | 'wmts',
  provider: ImageryProvider,
  visible: boolean,
  opacity: number,
  onDisposed: () => void,
): ImageryLayerHandle {
  const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
  imageryLayer.show = visible;
  imageryLayer.alpha = opacity;
  return new CesiumTiledImageryLayerHandle(
    viewer,
    id,
    type,
    imageryLayer,
    visible,
    opacity,
    onDisposed,
  );
}

/** @internal */
export async function createTmsLayer(
  viewer: Viewer,
  spec: TmsLayerSpec,
  context: LayerFactoryContext,
): Promise<ImageryLayerHandle> {
  try {
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', context.signal.reason);
    }
    const config = normalizeTms(spec);
    const opacity = validateOpacity(spec.opacity ?? 1, spec.id, 'add');
    const provider = await raceAbort(
      TileMapServiceImageryProvider.fromUrl(config.url, config.options),
      context.signal,
    );
    return createHandle(
      viewer,
      spec.id,
      'tms',
      provider,
      spec.visible ?? true,
      opacity,
      context.onDisposed,
    );
  } catch (cause: unknown) {
    if (cause instanceof GisError) {
      return Promise.reject(cause);
    }
    if (context.signal.aborted) {
      return Promise.reject(operationAborted(spec.id, 'add', cause));
    }
    return Promise.reject(
      new GisError(`Failed to add TMS layer "${spec.id}".`, {
        code: 'LAYER_LOAD_FAILED',
        module: 'layer',
        operation: 'add',
        retryable: true,
        cause,
      }),
    );
  }
}

/** @internal */
export async function createWmtsLayer(
  viewer: Viewer,
  spec: WmtsLayerSpec,
  context: LayerFactoryContext,
): Promise<ImageryLayerHandle> {
  try {
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', context.signal.reason);
    }
    const config = normalizeWmts(spec);
    const opacity = validateOpacity(spec.opacity ?? 1, spec.id, 'add');
    const provider = new WebMapTileServiceImageryProvider(config.options);
    return createHandle(
      viewer,
      spec.id,
      'wmts',
      provider,
      spec.visible ?? true,
      opacity,
      context.onDisposed,
    );
  } catch (cause: unknown) {
    if (cause instanceof GisError) {
      return Promise.reject(cause);
    }
    if (context.signal.aborted) {
      return Promise.reject(operationAborted(spec.id, 'add', cause));
    }
    return Promise.reject(
      new GisError(`Failed to add WMTS layer "${spec.id}".`, {
        code: 'LAYER_LOAD_FAILED',
        module: 'layer',
        operation: 'add',
        retryable: true,
        cause,
      }),
    );
  }
}
