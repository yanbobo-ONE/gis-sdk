import { Cartesian3, Color, Material, PolylineCollection } from 'cesium';
import type { Polyline, Viewer } from 'cesium';

import type { PickingMarker } from '../../core/controls.js';
import { GisError } from '../../core/errors.js';
import type { EventHub } from '../../core/event-hub.js';
import type {
  LayerEventMap,
  LayerState,
  OperationOptions,
  PolylineLayerHandle,
  PolylineLayerSpec,
  PolylineLayerStyle,
  PolylineMaterialKind,
  PolylineSpec,
} from '../../layers/contracts.js';
import { MAX_POLYLINES_PER_LAYER, MAX_POLYLINE_VERTICES } from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';

/** 折线默认颜色。 */
const DEFAULT_COLOR = '#ffffff';
/** 折线默认轮廓颜色。 */
const DEFAULT_OUTLINE_COLOR = '#000000';
const MIN_WIDTH = 0;
const MAX_WIDTH = 64;
const MAX_GLOW_POWER = 1;
const MAX_OUTLINE_WIDTH = 16;
const MIN_DASH_LENGTH = 1;
const MAX_DASH_LENGTH = 128;

/** 材质类型到 Cesium 内置材质名的映射；全部是公开材质，不触碰私有缓存。 */
const MATERIAL_TYPES: Readonly<Record<PolylineMaterialKind, string>> = Object.freeze({
  solid: 'Color',
  glow: 'PolylineGlow',
  outline: 'PolylineOutline',
  arrow: 'PolylineArrow',
  dash: 'PolylineDash',
});

interface NormalizedStyle {
  readonly width: number;
  readonly color: Color;
  readonly outlineColor: Color;
  readonly material: PolylineMaterialKind;
  readonly glowPower: number;
  readonly outlineWidth: number;
  readonly dashLength: number;
}

interface NormalizedPolyline {
  readonly key: string;
  readonly positions: Cartesian3[];
  readonly style: NormalizedStyle;
  readonly marker: PickingMarker;
}

function layerError(
  id: string,
  message: string,
  operation: string,
  code: 'INVALID_LAYER_CONFIG' | 'INVALID_LAYER_COLOR' = 'INVALID_LAYER_CONFIG',
): GisError {
  return new GisError(`Polyline layer "${id}" ${message}`, {
    code,
    module: 'layer',
    operation,
  });
}

function operationAborted(id: string, operation: string, cause?: unknown): GisError {
  return new GisError(`Layer "${id}" operation was aborted.`, {
    code: 'LAYER_OPERATION_ABORTED',
    module: 'layer',
    operation,
    cause,
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseColor(id: string, value: unknown, operation: string, name: string): Color {
  const text = typeof value === 'string' ? value.trim() : '';
  const color = text ? Color.fromCssColorString(text) : undefined;
  if (!color) {
    throw layerError(
      id,
      `${name} must be a CSS color string, for example "#ffffff".`,
      operation,
      'INVALID_LAYER_COLOR',
    );
  }
  return color;
}

function normalizeStyle(id: string, style: PolylineLayerStyle, operation: string): NormalizedStyle {
  const width = style.width ?? 2;
  if (!finite(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
    throw layerError(
      id,
      `width must be a finite number between ${String(MIN_WIDTH)} and ${String(MAX_WIDTH)}.`,
      operation,
    );
  }
  // 类型上只有五种取值，运行时（JS 调用方）仍可能传入别的字符串。
  const requestedMaterial: unknown = style.material ?? 'solid';
  if (typeof requestedMaterial !== 'string' || !(requestedMaterial in MATERIAL_TYPES)) {
    throw layerError(
      id,
      `material "${typeof requestedMaterial === 'string' ? requestedMaterial : typeof requestedMaterial}" is not supported; use solid, glow, outline, arrow, or dash.`,
      operation,
    );
  }
  const material = requestedMaterial as PolylineMaterialKind;
  const glowPower = style.glowPower ?? 0.2;
  if (!finite(glowPower) || glowPower < 0 || glowPower > MAX_GLOW_POWER) {
    throw layerError(
      id,
      `glowPower must be a finite number between 0 and ${String(MAX_GLOW_POWER)}.`,
      operation,
    );
  }
  const outlineWidth = style.outlineWidth ?? 2;
  if (!finite(outlineWidth) || outlineWidth < 0 || outlineWidth > MAX_OUTLINE_WIDTH) {
    throw layerError(
      id,
      `outlineWidth must be a finite number between 0 and ${String(MAX_OUTLINE_WIDTH)}.`,
      operation,
    );
  }
  const dashLength = style.dashLength ?? 16;
  if (!finite(dashLength) || dashLength < MIN_DASH_LENGTH || dashLength > MAX_DASH_LENGTH) {
    throw layerError(
      id,
      `dashLength must be a finite number between ${String(MIN_DASH_LENGTH)} and ${String(MAX_DASH_LENGTH)}.`,
      operation,
    );
  }
  return {
    width,
    color: parseColor(id, style.color ?? DEFAULT_COLOR, operation, 'color'),
    outlineColor: parseColor(
      id,
      style.outlineColor ?? DEFAULT_OUTLINE_COLOR,
      operation,
      'outlineColor',
    ),
    material,
    glowPower,
    outlineWidth,
    dashLength,
  };
}

function normalizePositions(id: string, positions: unknown, operation: string): Cartesian3[] {
  if (!Array.isArray(positions)) {
    throw layerError(id, 'positions must be an array of points.', operation);
  }
  if (positions.length < 2) {
    throw layerError(id, 'positions requires at least 2 points.', operation);
  }
  if (positions.length > MAX_POLYLINE_VERTICES) {
    throw layerError(
      id,
      `positions exceed the ${String(MAX_POLYLINE_VERTICES)} vertex limit.`,
      operation,
    );
  }
  return positions.map((vertex, index) => {
    const {
      longitude,
      latitude,
      height = 0,
    } = (vertex ?? {}) as {
      readonly longitude?: unknown;
      readonly latitude?: unknown;
      readonly height?: unknown;
    };
    if (
      !finite(longitude) ||
      !finite(latitude) ||
      !finite(height) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw layerError(
        id,
        `positions[${String(index)}] must be a valid WGS84 longitude, latitude, and height.`,
        operation,
      );
    }
    return Cartesian3.fromDegrees(longitude, latitude, height);
  });
}

function normalizePolylines(
  id: string,
  polylines: unknown,
  defaults: PolylineLayerStyle,
  operation: string,
): readonly NormalizedPolyline[] {
  if (!Array.isArray(polylines)) {
    throw layerError(id, 'polylines must be an array.', operation);
  }
  if (polylines.length > MAX_POLYLINES_PER_LAYER) {
    throw layerError(
      id,
      `polylines exceed the ${String(MAX_POLYLINES_PER_LAYER)} per-layer limit.`,
      operation,
    );
  }
  return (polylines as readonly unknown[]).map((entry, index) => {
    // 每一条都按运行时未知输入校验，缺字段或类型不对都给出可读错误。
    const spec = (entry ?? {}) as Partial<PolylineSpec>;
    const positions = normalizePositions(id, spec.positions, operation);
    const style = normalizeStyle(id, { ...defaults, ...spec }, operation);
    const objectId =
      typeof spec.id === 'string' && spec.id.trim() !== '' ? spec.id.trim() : undefined;
    return {
      key: `polyline-${String(index)}`,
      positions,
      style,
      marker: objectId === undefined ? { layerId: id } : { layerId: id, objectId },
    };
  });
}

/** 按材质类型组装 uniform；只使用 Cesium 公开材质类型的参数。 */
function materialFor(style: NormalizedStyle): Material {
  const type = MATERIAL_TYPES[style.material];
  switch (style.material) {
    case 'glow':
      return Material.fromType(type, { color: style.color, glowPower: style.glowPower });
    case 'outline':
      return Material.fromType(type, {
        color: style.color,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
      });
    case 'dash':
      return Material.fromType(type, { color: style.color, dashLength: style.dashLength });
    default:
      return Material.fromType(type, { color: style.color });
  }
}

function applyStyle(polyline: Polyline, style: NormalizedStyle): void {
  polyline.width = style.width;
  polyline.material = materialFor(style);
}

function buildCollection(polylines: readonly NormalizedPolyline[]): PolylineCollection {
  const collection = new PolylineCollection();
  for (const polyline of polylines) {
    const added = collection.add({
      positions: polyline.positions,
      id: polyline.marker,
    });
    applyStyle(added, polyline.style);
  }
  return collection;
}

class CesiumPolylineLayerHandle implements PolylineLayerHandle {
  readonly type = 'polyline' as const;
  private readonly lifecycle: LayerHandleRuntime;
  private currentCollection: PolylineCollection;
  private currentCount: number;
  private currentStyleSource: PolylineLayerStyle;
  private currentStyle: NormalizedStyle;
  private updatePromise: Promise<void> | undefined;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    initialCollection: PolylineCollection,
    initialCount: number,
    style: NormalizedStyle,
    styleSource: PolylineLayerStyle,
    visible: boolean,
    onDisposed: () => void,
  ) {
    this.currentCollection = initialCollection;
    this.currentCount = initialCount;
    this.currentStyle = style;
    this.currentStyleSource = styleSource;
    this.lifecycle = new LayerHandleRuntime({
      id,
      type: this.type,
      visible,
      onSetVisible: (nextVisible) => {
        this.currentCollection.show = nextVisible;
      },
      onDispose: () => {
        this.removeCollection(this.currentCollection);
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

  get count(): number {
    return this.currentCount;
  }

  setVisible(visible: boolean): void {
    this.lifecycle.setVisible(visible);
  }

  setStyle(style: PolylineLayerStyle): void {
    this.lifecycle.assertUsable('setStyle');
    // 以字符串形态的样式为底，避免把已解析的 Color 再当成 CSS 颜色解析一次。
    const merged: PolylineLayerStyle = { ...this.currentStyleSource, ...style };
    const normalized = normalizeStyle(this.id, merged, 'setStyle');
    this.currentStyleSource = merged;
    this.currentStyle = normalized;
    for (let index = 0; index < this.currentCollection.length; index += 1) {
      const polyline: Polyline = this.currentCollection.get(index);
      applyStyle(polyline, normalized);
    }
  }

  setData(polylines: readonly PolylineSpec[], options: OperationOptions = {}): Promise<void> {
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
    const update = Promise.resolve()
      .then(() => {
        if (options.signal?.aborted) {
          throw options.signal.reason;
        }
        const normalized = normalizePolylines(
          this.id,
          polylines,
          this.currentStyleSource,
          'setData',
        );
        if (options.signal?.aborted) {
          throw options.signal.reason;
        }
        // 先建好新集合再加入场景，最后移除旧集合，避免替换过程中出现空白帧。
        const next = buildCollection(normalized);
        try {
          this.viewer.scene.primitives.add(next);
        } catch (cause: unknown) {
          next.destroy();
          throw cause;
        }
        const previous = this.currentCollection;
        this.currentCollection = next;
        this.currentCollection.show = this.visible;
        this.currentCount = normalized.length;
        this.removeCollection(previous);
      })
      .then(
        () => {
          this.lifecycle.completeLoading();
        },
        (cause: unknown) => {
          if (options.signal?.aborted) {
            this.lifecycle.completeLoading();
            throw operationAborted(this.id, 'setData', cause);
          }
          this.lifecycle.failLoading();
          throw cause instanceof GisError
            ? cause
            : layerError(this.id, 'failed to replace polylines.', 'setData');
        },
      );

    this.updatePromise = update.finally(() => {
      this.updatePromise = undefined;
    });
    return this.updatePromise;
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  private removeCollection(collection: PolylineCollection): void {
    const removed = this.viewer.scene.primitives.remove(collection);
    if (!removed) {
      collection.destroy();
    }
  }
}

/** @internal */
export function createPolylineLayer(
  viewer: Viewer,
  spec: PolylineLayerSpec,
  context: LayerFactoryContext,
): Promise<PolylineLayerHandle> {
  let collection: PolylineCollection | undefined;
  let added = false;
  try {
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', context.signal.reason);
    }
    const styleSource: PolylineLayerStyle = { ...spec };
    const style = normalizeStyle(spec.id, styleSource, 'add');
    const polylines = normalizePolylines(spec.id, spec.polylines, styleSource, 'add');
    const visible = spec.visible ?? true;
    collection = buildCollection(polylines);
    collection.show = visible;
    viewer.scene.primitives.add(collection);
    added = true;
    // 建线是同步过程，工厂契约要求返回 Promise，这里显式包一层。
    return Promise.resolve(
      new CesiumPolylineLayerHandle(
        viewer,
        spec.id,
        collection,
        polylines.length,
        style,
        styleSource,
        visible,
        context.onDisposed,
      ),
    );
  } catch (cause: unknown) {
    if (added && collection) {
      const removed = viewer.scene.primitives.remove(collection);
      if (!removed) {
        collection.destroy();
      }
    } else {
      collection?.destroy();
    }
    if (cause instanceof GisError) {
      throw cause;
    }
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', cause);
    }
    throw layerError(spec.id, 'failed to create polyline primitives.', 'add');
  }
}
