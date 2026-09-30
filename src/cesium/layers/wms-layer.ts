import { WebMapServiceImageryProvider } from 'cesium';
import type { ImageryLayer, Viewer } from 'cesium';

import { GisError } from '../../core/errors.js';
import { normalizeRequestHeaders, withRequestHeaders } from './request-headers.js';
import type { RequestHeaders } from './request-headers.js';
import type { EventHub } from '../../core/event-hub.js';
import type {
  LayerEventMap,
  LayerState,
  WmsFilter,
  WmsLayerHandle,
  WmsLayerSpec,
  WmsParameterValue,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import { watchImageryErrors } from './imagery-error-watch.js';
import type { ImageryErrorWatch } from './imagery-error-watch.js';
import { serializeWmsFilter } from './wms-filter.js';

const reservedParameterNames = new Set(['cql_filter', 'layers', 'styles']);

function operationAborted(id: string, operation: string, cause?: unknown): GisError {
  return new GisError(`Layer "${id}" operation was aborted.`, {
    code: 'LAYER_OPERATION_ABORTED',
    module: 'layer',
    operation,
    cause,
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

function normalizeConfig(spec: WmsLayerSpec): {
  readonly url: string;
  readonly layers: string;
  readonly parameters: Readonly<Record<string, WmsParameterValue>>;
} {
  const url = spec.url.trim();
  const layers = (typeof spec.layers === 'string' ? spec.layers.split(',') : spec.layers)
    .map((layer) => layer.trim())
    .filter(Boolean)
    .join(',');
  if (!url || !layers) {
    throw new GisError(`WMS layer "${spec.id}" requires a non-empty URL and layer list.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
  }

  const parameters = { ...spec.parameters };
  for (const key of Object.keys(parameters)) {
    if (reservedParameterNames.has(key.toLowerCase())) {
      throw new GisError(`WMS parameter "${key}" must use its typed layer option.`, {
        code: 'INVALID_WMS_PARAMETERS',
        module: 'layer',
        operation: 'add',
      });
    }
  }
  return { url, layers, parameters };
}

function buildParameters(
  parameters: Readonly<Record<string, WmsParameterValue>>,
  style: string | undefined,
  filter: WmsFilter | undefined,
): Record<string, WmsParameterValue> {
  const result = { ...parameters };
  if (style) {
    result.styles = style;
  }
  if (filter) {
    result.cql_filter = serializeWmsFilter(filter);
  }
  return result;
}

function normalizeStyle(style: string | undefined): string | undefined {
  const normalized = style?.trim();
  return normalized === '' ? undefined : normalized;
}

class CesiumWmsLayerHandle implements WmsLayerHandle {
  readonly type = 'wms' as const;

  private readonly lifecycle: LayerHandleRuntime;
  private errorWatch: ImageryErrorWatch;
  private currentLayer: ImageryLayer;
  private currentOpacity: number;
  private currentStyle: string | undefined;
  private currentFilter: WmsFilter | undefined;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    private readonly url: string,
    private readonly headers: RequestHeaders | undefined,
    private readonly layerNames: string,
    private readonly parameters: Readonly<Record<string, WmsParameterValue>>,
    initialLayer: ImageryLayer,
    visible: boolean,
    opacity: number,
    style: string | undefined,
    filter: WmsFilter | undefined,
    onDisposed: () => void,
  ) {
    this.currentLayer = initialLayer;
    this.currentOpacity = opacity;
    this.currentStyle = style;
    this.currentFilter = filter;
    this.lifecycle = new LayerHandleRuntime({
      id,
      type: this.type,
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
    this.errorWatch = watchImageryErrors(initialLayer, (cause: unknown) => {
      this.lifecycle.recordError(cause);
    });
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

  setVisible(visible: boolean): void {
    this.lifecycle.setVisible(visible);
  }

  setOpacity(opacity: number): void {
    this.lifecycle.assertUsable('setOpacity');
    const normalizedOpacity = validateOpacity(opacity, this.id, 'setOpacity');
    this.currentLayer.alpha = normalizedOpacity;
    this.currentOpacity = normalizedOpacity;
  }

  setFilter(filter?: WmsFilter): Promise<void> {
    return this.updateProvider(this.currentStyle, filter, 'setFilter');
  }

  setStyle(style?: string): Promise<void> {
    return this.updateProvider(normalizeStyle(style), this.currentFilter, 'setStyle');
  }

  reload(): Promise<void> {
    return this.updateProvider(this.currentStyle, this.currentFilter, 'reload');
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  private updateProvider(
    style: string | undefined,
    filter: WmsFilter | undefined,
    operation: string,
  ): Promise<void> {
    try {
      this.lifecycle.assertUsable(operation);
      this.lifecycle.beginLoading(operation);
      const provider = this.createProvider(style, filter);
      const previousLayer = this.currentLayer;
      const previousIndex = this.viewer.imageryLayers.indexOf(previousLayer);
      const candidate =
        previousIndex >= 0
          ? this.viewer.imageryLayers.addImageryProvider(provider, previousIndex)
          : this.viewer.imageryLayers.addImageryProvider(provider);
      candidate.show = this.visible;
      candidate.alpha = this.currentOpacity;
      this.errorWatch.dispose();
      this.currentLayer = candidate;
      this.errorWatch = watchImageryErrors(candidate, (cause: unknown) => {
        this.lifecycle.recordError(cause);
      });
      this.currentStyle = style;
      this.currentFilter = filter;
      this.viewer.imageryLayers.remove(previousLayer, true);
      this.lifecycle.completeLoading();
      return Promise.resolve();
    } catch (cause: unknown) {
      this.lifecycle.failLoading();
      if (cause instanceof GisError) {
        return Promise.reject(cause);
      }
      return Promise.reject(
        new GisError(`Failed to update WMS layer "${this.id}".`, {
          code: 'LAYER_LOAD_FAILED',
          module: 'layer',
          operation,
          retryable: true,
          cause,
        }),
      );
    }
  }

  private createProvider(
    style: string | undefined,
    filter: WmsFilter | undefined,
  ): WebMapServiceImageryProvider {
    return new WebMapServiceImageryProvider({
      url: withRequestHeaders(this.url, this.headers),
      layers: this.layerNames,
      parameters: buildParameters(this.parameters, style, filter),
    });
  }
}

/** @internal */
export function createWmsLayer(
  viewer: Viewer,
  spec: WmsLayerSpec,
  context: LayerFactoryContext,
): Promise<WmsLayerHandle> {
  try {
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', context.signal.reason);
    }
    const config = normalizeConfig(spec);
    const headers = normalizeRequestHeaders(spec.headers, spec.id, 'add');
    const visible = spec.visible ?? true;
    const opacity = validateOpacity(spec.opacity ?? 1, spec.id, 'add');
    const style = normalizeStyle(spec.style);
    const parameters = buildParameters(config.parameters, style, spec.filter);
    const provider = new WebMapServiceImageryProvider({
      url: withRequestHeaders(config.url, headers),
      layers: config.layers,
      parameters,
    });
    const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.show = visible;
    imageryLayer.alpha = opacity;

    return Promise.resolve(
      new CesiumWmsLayerHandle(
        viewer,
        spec.id,
        config.url,
        headers,
        config.layers,
        config.parameters,
        imageryLayer,
        visible,
        opacity,
        style,
        spec.filter,
        context.onDisposed,
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof GisError) {
      return Promise.reject(cause);
    }
    return Promise.reject(
      new GisError(`Failed to add WMS layer "${spec.id}".`, {
        code: 'LAYER_LOAD_FAILED',
        module: 'layer',
        operation: 'add',
        retryable: true,
        cause,
      }),
    );
  }
}
