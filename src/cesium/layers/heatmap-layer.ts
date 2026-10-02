import { Rectangle, SingleTileImageryProvider } from 'cesium';
import type { ImageryLayer, Viewer } from 'cesium';

import { GisError } from '../../core/errors.js';
import { buildHeatmapGrid, colorizeHeatmap } from '../../core/heatmap.js';
import type { EventHub } from '../../core/event-hub.js';
import type {
  HeatmapLayerBounds,
  HeatmapLayerHandle,
  HeatmapLayerPoint,
  HeatmapLayerSpec,
  HeatmapStyleOptions,
  LayerEventMap,
  LayerStacking,
  LayerState,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import { watchImageryErrors } from './imagery-error-watch.js';
import type { ImageryErrorWatch } from './imagery-error-watch.js';
import { createImageryStacking } from './imagery-stacking.js';

function layerError(
  message: string,
  code: 'INVALID_LAYER_CONFIG' | 'INVALID_LAYER_OPACITY' | 'LAYER_BUSY' | 'LAYER_LOAD_FAILED',
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

function validateOpacity(value: number, id: string, operation: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw layerError(
      `Layer "${id}" opacity must be between 0 and 1.`,
      'INVALID_LAYER_OPACITY',
      operation,
    );
  }
  return value;
}

function validatePoints(
  value: unknown,
  id: string,
  operation: string,
): readonly HeatmapLayerPoint[] {
  if (!Array.isArray(value)) {
    throw layerError(
      `Heatmap layer "${id}" points must be an array.`,
      'INVALID_LAYER_CONFIG',
      operation,
    );
  }
  return value as readonly HeatmapLayerPoint[];
}

function toRectangle(bounds: HeatmapLayerBounds | undefined): Rectangle | undefined {
  if (bounds === undefined) {
    return undefined;
  }
  return Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north);
}

/**
 * 热力图栅格化出口。
 *
 * 默认实现用浏览器的 canvas 把 RGBA 像素编码成 PNG data URL；测试注入假实现即可在
 * 无 DOM 环境验证整条链路（这也让"网格 → 像素"的纯计算部分留在 `/core` 单测里）。
 *
 * @internal
 */
export interface HeatmapRasterizer {
  toDataUrl(pixels: Uint8ClampedArray, width: number, height: number): string;
}

/** @internal */
export function createCanvasHeatmapRasterizer(): HeatmapRasterizer {
  return {
    toDataUrl(pixels: Uint8ClampedArray, width: number, height: number): string {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw layerError(
          'Heatmap needs a 2D canvas context to rasterize its grid.',
          'LAYER_LOAD_FAILED',
          'add',
          { retryable: true },
        );
      }
      // 用空图 + set() 写入像素：ImageData 的构造重载在新版 TS DOM 类型下对
      // Uint8ClampedArray 的泛型参数更严格，这样写不需要任何断言。
      const image = new ImageData(width, height);
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    },
  };
}

/** 归一化后的样式：省略项在构建期补齐，`setStyle()` 只覆盖显式给出的字段。 */
interface ResolvedHeatmapStyle {
  readonly radiusMeters: number | undefined;
  readonly resolution: number | undefined;
  readonly colorRamp: HeatmapStyleOptions['colorRamp'];
  readonly maxDensity: number | undefined;
  readonly bounds: HeatmapLayerBounds | undefined;
}

function toGridOptions(points: readonly HeatmapLayerPoint[], style: ResolvedHeatmapStyle) {
  return {
    points,
    ...(style.radiusMeters === undefined ? {} : { radiusMeters: style.radiusMeters }),
    ...(style.resolution === undefined ? {} : { resolution: style.resolution }),
    ...(style.bounds === undefined ? {} : { bounds: style.bounds }),
  };
}

/** 把一次栅格化的结果包成"影像提供者需要的东西"。 */
interface RasterizedTile {
  readonly url: string;
  readonly rectangle: Rectangle | undefined;
  readonly pointCount: number;
}

function rasterize(
  points: readonly HeatmapLayerPoint[],
  style: ResolvedHeatmapStyle,
  rasterizer: HeatmapRasterizer,
  id: string,
  operation: string,
): RasterizedTile {
  if (points.length === 0) {
    // 空数据不是错误：出一张全透明的小图，图层照常存在、读数归零。
    return {
      url: rasterizer.toDataUrl(new Uint8ClampedArray(4), 1, 1),
      rectangle: toRectangle(style.bounds),
      pointCount: 0,
    };
  }

  let grid;
  try {
    grid = buildHeatmapGrid(toGridOptions(points, style));
  } catch (cause: unknown) {
    if (cause instanceof GisError) {
      throw layerError(
        `Heatmap layer "${id}" ${cause.message}`,
        'INVALID_LAYER_CONFIG',
        operation,
        {
          cause,
        },
      );
    }
    throw cause;
  }

  const pixels =
    grid.maxDensity > 0
      ? colorizeHeatmap(grid, {
          ...(style.colorRamp === undefined ? {} : { colorRamp: style.colorRamp }),
          ...(style.maxDensity === undefined ? {} : { maxDensity: style.maxDensity }),
        })
      : new Uint8ClampedArray(grid.width * grid.height * 4);

  return {
    url: rasterizer.toDataUrl(pixels, grid.width, grid.height),
    rectangle: toRectangle(grid.bounds),
    pointCount: grid.pointCount,
  };
}

class CesiumHeatmapLayerHandle implements HeatmapLayerHandle {
  readonly type = 'heatmap' as const;

  private readonly lifecycle: LayerHandleRuntime;
  private readonly stacking: LayerStacking;
  private currentLayer: ImageryLayer;
  private errorWatch: ImageryErrorWatch;
  private style: ResolvedHeatmapStyle;
  private points: readonly HeatmapLayerPoint[];
  private currentOpacity: number;
  private currentPointCount: number;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    private readonly rasterizer: HeatmapRasterizer,
    initialLayer: ImageryLayer,
    visible: boolean,
    opacity: number,
    style: ResolvedHeatmapStyle,
    points: readonly HeatmapLayerPoint[],
    pointCount: number,
    onDisposed: () => void,
  ) {
    this.currentLayer = initialLayer;
    this.style = style;
    this.points = points;
    this.currentPointCount = pointCount;
    this.currentOpacity = opacity;
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

  get pointCount(): number {
    return this.currentPointCount;
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

  setData(points: readonly HeatmapLayerPoint[]): Promise<void> {
    this.lifecycle.assertUsable('setData');
    const validated = validatePoints(points, this.id, 'setData');
    return this.replace(validated, this.style, 'setData');
  }

  setStyle(style: HeatmapStyleOptions): Promise<void> {
    this.lifecycle.assertUsable('setStyle');
    const requested = (style as Partial<HeatmapStyleOptions> | undefined) ?? {};
    const merged: ResolvedHeatmapStyle = {
      radiusMeters: requested.radiusMeters ?? this.style.radiusMeters,
      resolution: requested.resolution ?? this.style.resolution,
      colorRamp: requested.colorRamp ?? this.style.colorRamp,
      maxDensity: requested.maxDensity ?? this.style.maxDensity,
      bounds: requested.bounds ?? this.style.bounds,
    };
    return this.replace(this.points, merged, 'setStyle');
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  /**
   * 原子替换影像：先按新参数栅格化，成功后再换图层，并把透明度、显隐与堆叠位置继承过去。
   *
   * 栅格化是同步的，返回 Promise 是为了与其它图层的 `setData()` 保持一致的调用形状
   * （也都用 `LAYER_BUSY` 挡住并发替换）。
   */
  private replace(
    points: readonly HeatmapLayerPoint[],
    style: ResolvedHeatmapStyle,
    operation: string,
  ): Promise<void> {
    if (this.pending) {
      return Promise.reject(
        layerError(`Layer "${this.id}" is already replacing its data.`, 'LAYER_BUSY', operation, {
          retryable: true,
        }),
      );
    }
    let tile: RasterizedTile;
    try {
      tile = rasterize(points, style, this.rasterizer, this.id, operation);
    } catch (cause: unknown) {
      return Promise.reject(
        cause instanceof Error ? cause : new Error('Heatmap rasterization failed.', { cause }),
      );
    }

    const operation$ = Promise.resolve().then(() => {
      this.lifecycle.assertUsable(operation);
      const previous = this.currentLayer;
      const index = this.viewer.imageryLayers.indexOf(previous);
      const provider = new SingleTileImageryProvider({
        url: tile.url,
        ...(tile.rectangle === undefined ? {} : { rectangle: tile.rectangle }),
      });
      this.errorWatch.dispose();
      const next = this.viewer.imageryLayers.addImageryProvider(
        provider,
        index < 0 ? undefined : index,
      );
      next.show = this.lifecycle.visible;
      next.alpha = this.currentOpacity;
      this.viewer.imageryLayers.remove(previous, true);
      this.currentLayer = next;
      this.errorWatch = watchImageryErrors(next, (cause: unknown) => {
        this.lifecycle.recordError(cause);
      });
      this.points = points;
      this.style = style;
      this.currentPointCount = tile.pointCount;
    });
    const tracked = operation$.finally(() => {
      if (this.pending === tracked) {
        this.pending = undefined;
      }
    });
    this.pending = tracked;
    return tracked;
  }
}

/** @internal */
export function createHeatmapLayer(
  viewer: Viewer,
  spec: HeatmapLayerSpec,
  context: LayerFactoryContext,
  rasterizer: HeatmapRasterizer = createCanvasHeatmapRasterizer(),
): Promise<HeatmapLayerHandle> {
  try {
    const opacity = validateOpacity(spec.opacity ?? 1, spec.id, 'add');
    const points = validatePoints(
      (spec as { readonly points?: unknown }).points ?? [],
      spec.id,
      'add',
    );
    const style: ResolvedHeatmapStyle = {
      radiusMeters: spec.radiusMeters,
      resolution: spec.resolution,
      colorRamp: spec.colorRamp,
      maxDensity: spec.maxDensity,
      bounds: spec.bounds,
    };
    const tile = rasterize(points, style, rasterizer, spec.id, 'add');
    const provider = new SingleTileImageryProvider({
      url: tile.url,
      ...(tile.rectangle === undefined ? {} : { rectangle: tile.rectangle }),
    });
    const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
    imageryLayer.show = spec.visible ?? true;
    imageryLayer.alpha = opacity;
    return Promise.resolve(
      new CesiumHeatmapLayerHandle(
        viewer,
        spec.id,
        rasterizer,
        imageryLayer,
        spec.visible ?? true,
        opacity,
        style,
        points,
        tile.pointCount,
        context.onDisposed,
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof GisError) {
      return Promise.reject(cause);
    }
    return Promise.reject(
      layerError(`Failed to add heatmap layer "${spec.id}".`, 'LAYER_LOAD_FAILED', 'add', {
        retryable: true,
        cause,
      }),
    );
  }
}
