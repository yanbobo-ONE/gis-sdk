import { Color, GeoJsonDataSource } from 'cesium';
import type { DataSource, Viewer } from 'cesium';
import type { GeoJSON } from 'geojson';

import { GisError } from '../../core/errors.js';
import type {
  GeoJsonLayerHandle,
  GeoJsonLayerSpec,
  GeoJsonSource,
  GeoJsonStyle,
  LayerEventMap,
  LayerState,
  OperationOptions,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import type { EventHub } from '../../core/event-hub.js';
import { registerPickableEntities } from './pickable-entities.js';

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

function parseColor(value: string, id: string, operation: string): Color {
  const color = Color.fromCssColorString(value) as Color | undefined;
  if (!color) {
    throw new GisError(`Layer "${id}" contains an invalid CSS color: "${value}".`, {
      code: 'INVALID_LAYER_STYLE',
      module: 'layer',
      operation,
    });
  }
  return color;
}

function positiveNumber(value: number, name: string, id: string, operation: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new GisError(`Layer "${id}" requires ${name} to be a positive finite number.`, {
      code: 'INVALID_LAYER_STYLE',
      module: 'layer',
      operation,
    });
  }
  return value;
}

function createLoadOptions(
  style: GeoJsonStyle | undefined,
  id: string,
  operation: string,
): GeoJsonDataSource.LoadOptions {
  const options: GeoJsonDataSource.LoadOptions = {};
  if (!style) {
    return options;
  }

  if (style.marker?.color) {
    options.markerColor = parseColor(style.marker.color, id, operation);
  }
  if (style.marker?.size !== undefined) {
    options.markerSize = positiveNumber(style.marker.size, 'marker.size', id, operation);
  }
  if (style.marker?.symbol) {
    options.markerSymbol = style.marker.symbol;
  }
  if (style.stroke) {
    options.stroke = parseColor(style.stroke, id, operation);
  }
  if (style.strokeWidth !== undefined) {
    options.strokeWidth = positiveNumber(style.strokeWidth, 'strokeWidth', id, operation);
  }
  if (style.fill) {
    options.fill = parseColor(style.fill, id, operation);
  }
  if (style.clampToGround !== undefined) {
    options.clampToGround = style.clampToGround;
  }
  return options;
}

async function resolveSource(source: GeoJsonSource, signal: AbortSignal): Promise<GeoJSON> {
  if (typeof source !== 'string') {
    return source;
  }

  const response = await fetch(source, { signal });
  if (!response.ok) {
    throw new Error(`GeoJSON request failed with HTTP ${String(response.status)}.`);
  }
  const data: unknown = await response.json();
  return data as GeoJSON;
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

function linkedController(signal: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly unlink: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  return {
    controller,
    unlink: () => {
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function removeLateDataSource(viewer: Viewer, adding: Promise<DataSource>): void {
  void adding
    .then((dataSource) => {
      viewer.dataSources.remove(dataSource, true);
    })
    .catch(() => undefined);
}

async function loadDataSource(
  id: string,
  source: GeoJsonSource,
  loadOptions: GeoJsonDataSource.LoadOptions,
  signal: AbortSignal,
  operation: string,
): Promise<GeoJsonDataSource> {
  try {
    const data = await resolveSource(source, signal);
    return await raceAbort(GeoJsonDataSource.load(data, loadOptions), signal);
  } catch (cause: unknown) {
    if (signal.aborted) {
      throw operationAborted(id, operation, cause);
    }
    if (cause instanceof GisError) {
      throw cause;
    }
    throw new GisError(`Failed to load GeoJSON for layer "${id}".`, {
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation,
      retryable: true,
      cause,
    });
  }
}

class CesiumGeoJsonLayerHandle implements GeoJsonLayerHandle {
  readonly type = 'geojson' as const;

  private readonly lifecycle: LayerHandleRuntime;
  private currentDataSource: GeoJsonDataSource;
  private updateController: AbortController | undefined;
  private updatePromise: Promise<void> | undefined;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    initialDataSource: GeoJsonDataSource,
    visible: boolean,
    private readonly loadOptions: GeoJsonDataSource.LoadOptions,
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

  setVisible(visible: boolean): void {
    this.lifecycle.setVisible(visible);
  }

  setData(data: GeoJsonSource, options: OperationOptions = {}): Promise<void> {
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
        // 取消是正常结果：旧数据仍然生效，图层回到稳定状态而不是错误状态。
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

  private async replaceData(data: GeoJsonSource, signal: AbortSignal): Promise<void> {
    const candidate = await loadDataSource(this.id, data, this.loadOptions, signal, 'setData');
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
      registerPickableEntities(candidate.entities.values, this.id);
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
      throw new GisError(`Failed to replace GeoJSON for layer "${this.id}".`, {
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
export async function createGeoJsonLayer(
  viewer: Viewer,
  spec: GeoJsonLayerSpec,
  context: LayerFactoryContext,
): Promise<GeoJsonLayerHandle> {
  const visible = spec.visible ?? true;
  const loadOptions = createLoadOptions(spec.style, spec.id, 'add');
  const dataSource = await loadDataSource(spec.id, spec.data, loadOptions, context.signal, 'add');
  dataSource.show = visible;
  registerPickableEntities(dataSource.entities.values, spec.id);

  let added = false;
  let adding: Promise<DataSource> | undefined;
  try {
    adding = viewer.dataSources.add(dataSource);
    await raceAbort(adding, context.signal);
    added = true;
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', context.signal.reason);
    }
    return new CesiumGeoJsonLayerHandle(
      viewer,
      spec.id,
      dataSource,
      visible,
      loadOptions,
      context.onDisposed,
    );
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
    throw new GisError(`Failed to add GeoJSON layer "${spec.id}".`, {
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation: 'add',
      retryable: true,
      cause,
    });
  }
}
