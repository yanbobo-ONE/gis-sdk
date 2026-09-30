import { Cartesian2, Cartesian3, Color, LabelCollection, PointPrimitiveCollection } from 'cesium';
import type { PointPrimitive, Viewer } from 'cesium';

import type { PickingMarker } from '../../core/controls.js';
import { GisError } from '../../core/errors.js';
import type { EventHub } from '../../core/event-hub.js';
import type {
  LayerEventMap,
  LayerState,
  OperationOptions,
  PointSpec,
  PointsLabelStyle,
  PointsLayerHandle,
  PointsLayerSpec,
  PointsLayerStyle,
} from '../../layers/contracts.js';
import { MAX_POINT_LAYER_POINTS } from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';

/** 点位默认颜色，沿用 Plugin-web 的既有取值。 */
const DEFAULT_COLOR = '#43bfeb';

/** 点直径的取值范围。 */
const MIN_PIXEL_SIZE = 2;
const MAX_PIXEL_SIZE = 40;

/** 轮廓宽度的取值范围。 */
const MAX_OUTLINE_WIDTH = 16;

/** 标签默认字体与颜色。 */
const DEFAULT_LABEL_FONT = '13px sans-serif';
const DEFAULT_LABEL_COLOR = '#ffffff';
const DEFAULT_LABEL_OUTLINE_COLOR = '#0b1310';
const DEFAULT_LABEL_OUTLINE_WIDTH = 2;
const DEFAULT_LABEL_OFFSET: readonly [number, number] = [0, -18];
const DEFAULT_MAX_LABELS = 2_000;
const MAX_LABELS_LIMIT = 50_000;
const MAX_OUTLINE_WIDTH_LABEL = 8;
/** 单条标签文本上限，避免把整段业务描述灌进 GPU。 */
const MAX_LABEL_LENGTH = 64;

interface NormalizedLabelStyle {
  readonly enabled: boolean;
  readonly font: string;
  readonly color: Color;
  readonly outlineColor: Color;
  readonly outlineWidth: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly maxLabels: number;
}

interface NormalizedStyle {
  readonly color: Color;
  readonly pixelSize: number;
  readonly outlineWidth: number;
  readonly outlineColor: Color;
  readonly labels: NormalizedLabelStyle;
}

function layerError(
  id: string,
  message: string,
  operation: string,
  code: 'INVALID_LAYER_CONFIG' | 'INVALID_LAYER_COLOR' = 'INVALID_LAYER_CONFIG',
): GisError {
  return new GisError(`Points layer "${id}" ${message}`, {
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

/** 运行期数组判断；单独写一层是为了不让 `Array.isArray` 把类型塌成 `any[]`。 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function parseColor(id: string, value: unknown, operation: string): Color {
  const text = typeof value === 'string' ? value.trim() : '';
  const color = text ? Color.fromCssColorString(text) : undefined;
  if (!color) {
    throw layerError(
      id,
      'color must be a CSS color string, for example "#43bfeb".',
      operation,
      'INVALID_LAYER_COLOR',
    );
  }
  return color;
}

function normalizeStyle(id: string, style: PointsLayerStyle, operation: string): NormalizedStyle {
  const color = parseColor(id, style.color ?? DEFAULT_COLOR, operation);
  const pixelSize = style.pixelSize ?? 8;
  if (!Number.isFinite(pixelSize) || pixelSize < MIN_PIXEL_SIZE || pixelSize > MAX_PIXEL_SIZE) {
    throw layerError(
      id,
      `pixelSize must be a finite number between ${String(MIN_PIXEL_SIZE)} and ${String(MAX_PIXEL_SIZE)}.`,
      operation,
    );
  }
  const outlineWidth = style.outlineWidth ?? 0;
  if (!Number.isFinite(outlineWidth) || outlineWidth < 0 || outlineWidth > MAX_OUTLINE_WIDTH) {
    throw layerError(
      id,
      `outlineWidth must be a finite number between 0 and ${String(MAX_OUTLINE_WIDTH)}.`,
      operation,
    );
  }
  return {
    color,
    pixelSize,
    outlineWidth,
    outlineColor: parseColor(id, style.outlineColor ?? style.color ?? DEFAULT_COLOR, operation),
    labels: normalizeLabelStyle(id, style.labels, operation),
  };
}

/** 标签样式：默认关闭；开启时校验字体、颜色、偏移与上限。 */
function normalizeLabelStyle(
  id: string,
  labels: PointsLabelStyle | undefined,
  operation: string,
): NormalizedLabelStyle {
  if (labels === undefined) {
    return {
      enabled: false,
      font: DEFAULT_LABEL_FONT,
      color: Color.WHITE,
      outlineColor: parseColor(id, DEFAULT_LABEL_OUTLINE_COLOR, operation),
      outlineWidth: DEFAULT_LABEL_OUTLINE_WIDTH,
      offsetX: DEFAULT_LABEL_OFFSET[0],
      offsetY: DEFAULT_LABEL_OFFSET[1],
      maxLabels: DEFAULT_MAX_LABELS,
    };
  }
  const font = labels.font ?? DEFAULT_LABEL_FONT;
  if (typeof font !== 'string' || font.trim().length === 0) {
    throw layerError(id, 'labels.font must be a non-empty CSS font string.', operation);
  }
  const outlineWidth = labels.outlineWidth ?? DEFAULT_LABEL_OUTLINE_WIDTH;
  if (
    !Number.isFinite(outlineWidth) ||
    outlineWidth < 0 ||
    outlineWidth > MAX_OUTLINE_WIDTH_LABEL
  ) {
    throw layerError(
      id,
      `labels.outlineWidth must be a finite number between 0 and ${String(MAX_OUTLINE_WIDTH_LABEL)}.`,
      operation,
    );
  }
  // 运行期可能收到任意值：先收窄成 unknown[] 再逐项校验，避免直接信任类型标注。
  const rawOffset: unknown = labels.offsetPixels ?? DEFAULT_LABEL_OFFSET;
  const offsetValues: readonly unknown[] | undefined = isUnknownArray(rawOffset) ? rawOffset : undefined;
  const offsetX = offsetValues?.[0];
  const offsetY = offsetValues?.[1];
  if (offsetValues?.length !== 2 || !finite(offsetX) || !finite(offsetY)) {
    throw layerError(id, 'labels.offsetPixels must be a pair of finite numbers.', operation);
  }
  const maxLabels = labels.maxLabels ?? DEFAULT_MAX_LABELS;
  if (!Number.isInteger(maxLabels) || maxLabels < 0 || maxLabels > MAX_LABELS_LIMIT) {
    throw layerError(
      id,
      `labels.maxLabels must be an integer between 0 and ${String(MAX_LABELS_LIMIT)}.`,
      operation,
    );
  }
  return {
    enabled: labels.enabled === true,
    font,
    color: parseColor(id, labels.color ?? DEFAULT_LABEL_COLOR, operation),
    outlineColor: parseColor(id, labels.outlineColor ?? DEFAULT_LABEL_OUTLINE_COLOR, operation),
    outlineWidth,
    offsetX,
    offsetY,
    maxLabels,
  };
}

interface NormalizedPoint {
  readonly position: Cartesian3;
  readonly color: Color | undefined;
  readonly pixelSize: number | undefined;
  /** 标签文本；没有或空白时为 `undefined`。 */
  readonly label: string | undefined;
  /** 拾取标记；命中后由拾取控制器还原图层与对象 id。 */
  readonly marker: PickingMarker;
}

/** 按运行时未知输入校验；JS 调用方可能传入缺少字段的对象。 */
function normalizePoint(id: string, point: unknown, operation: string): NormalizedPoint {
  const candidate = (point ?? {}) as Partial<PointSpec>;
  const objectId =
    typeof candidate.id === 'string' && candidate.id.trim() !== ''
      ? candidate.id.trim()
      : undefined;
  const marker: PickingMarker =
    objectId === undefined ? { layerId: id } : { layerId: id, objectId };
  const { longitude, latitude, height = 0 } = candidate;
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
      'points must contain valid WGS84 longitude, latitude, and height.',
      operation,
    );
  }
  if (
    candidate.pixelSize !== undefined &&
    (!finite(candidate.pixelSize) ||
      candidate.pixelSize < MIN_PIXEL_SIZE ||
      candidate.pixelSize > MAX_PIXEL_SIZE)
  ) {
    throw layerError(
      id,
      `point pixelSize must be a finite number between ${String(MIN_PIXEL_SIZE)} and ${String(MAX_PIXEL_SIZE)}.`,
      operation,
    );
  }
  const rawLabel = typeof candidate.label === 'string' ? candidate.label.trim() : '';
  if (rawLabel.length > MAX_LABEL_LENGTH) {
    throw layerError(
      id,
      `point label must be at most ${String(MAX_LABEL_LENGTH)} characters.`,
      operation,
    );
  }
  return {
    position: Cartesian3.fromDegrees(longitude, latitude, height),
    color: candidate.color === undefined ? undefined : parseColor(id, candidate.color, operation),
    pixelSize: candidate.pixelSize,
    label: rawLabel.length === 0 ? undefined : rawLabel,
    marker,
  };
}

function normalizePoints(
  id: string,
  points: unknown,
  operation: string,
): readonly NormalizedPoint[] {
  if (!Array.isArray(points)) {
    throw layerError(id, 'points must be an array.', operation);
  }
  const list = points as readonly PointSpec[];
  if (list.length > MAX_POINT_LAYER_POINTS) {
    throw layerError(
      id,
      `points exceed the ${String(MAX_POINT_LAYER_POINTS)} per-layer limit.`,
      operation,
    );
  }
  return list.map((point) => normalizePoint(id, point, operation));
}

/** 按样式批量建点；点位自身的覆盖值优先。 */
function buildCollection(
  points: readonly NormalizedPoint[],
  style: NormalizedStyle,
): PointPrimitiveCollection {
  const collection = new PointPrimitiveCollection();
  for (const point of points) {
    collection.add({
      position: point.position,
      color: point.color ?? style.color,
      pixelSize: point.pixelSize ?? style.pixelSize,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      id: point.marker,
    });
  }
  return collection;
}

/**
 * 按样式批量建标签；标签关闭或没有带文本的点时返回 `undefined`。
 *
 * 超过 `labels.maxLabels` 的点只渲染点、不渲染标签，`labelCount` 会反映实际数量。
 */
function buildLabels(
  points: readonly NormalizedPoint[],
  style: NormalizedStyle,
): LabelCollection | undefined {
  const labels = style.labels;
  if (!labels.enabled || labels.maxLabels === 0) {
    return undefined;
  }
  const candidates = points.filter((point) => point.label !== undefined);
  if (candidates.length === 0) {
    return undefined;
  }
  const collection = new LabelCollection();
  for (const point of candidates.slice(0, labels.maxLabels)) {
    const text = point.label;
    if (text === undefined) {
      continue;
    }
    collection.add({
      position: point.position,
      text,
      font: labels.font,
      fillColor: labels.color,
      outlineColor: labels.outlineColor,
      outlineWidth: labels.outlineWidth,
      pixelOffset: new Cartesian2(labels.offsetX, labels.offsetY),
      id: point.marker,
    });
  }
  return collection;
}

class CesiumPointsLayerHandle implements PointsLayerHandle {
  readonly type = 'points' as const;
  private readonly lifecycle: LayerHandleRuntime;
  private currentCollection: PointPrimitiveCollection;
  private currentLabels: LabelCollection | undefined;
  private currentCount: number;
  private currentStyle: NormalizedStyle;
  private currentStyleSource: PointsLayerStyle;
  private currentPoints: readonly NormalizedPoint[];
  private updatePromise: Promise<void> | undefined;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    initialCollection: PointPrimitiveCollection,
    initialLabels: LabelCollection | undefined,
    initialPoints: readonly NormalizedPoint[],
    initialCount: number,
    style: NormalizedStyle,
    styleSource: PointsLayerStyle,
    visible: boolean,
    onDisposed: () => void,
  ) {
    this.currentCollection = initialCollection;
    this.currentLabels = initialLabels;
    this.currentPoints = initialPoints;
    this.currentCount = initialCount;
    this.currentStyle = style;
    this.currentStyleSource = styleSource;
    this.lifecycle = new LayerHandleRuntime({
      id,
      type: this.type,
      visible,
      onSetVisible: (nextVisible) => {
        this.currentCollection.show = nextVisible;
        if (this.currentLabels) {
          this.currentLabels.show = nextVisible;
        }
      },
      onDispose: () => {
        this.removeCollection(this.currentCollection);
        if (this.currentLabels) {
          this.removeCollection(this.currentLabels);
          this.currentLabels = undefined;
        }
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

  get labelCount(): number {
    return this.currentLabels?.length ?? 0;
  }

  setVisible(visible: boolean): void {
    this.lifecycle.setVisible(visible);
  }

  setStyle(style: PointsLayerStyle): void {
    this.lifecycle.assertUsable('setStyle');
    // 以字符串形态的样式为底，避免把已解析的 Color 再当成 CSS 颜色解析一次。
    const merged: PointsLayerStyle = { ...this.currentStyleSource, ...style };
    const normalized = normalizeStyle(this.id, merged, 'setStyle');
    this.currentStyleSource = merged;
    this.currentStyle = normalized;
    for (let index = 0; index < this.currentCollection.length; index += 1) {
      const point: PointPrimitive = this.currentCollection.get(index);
      point.color = normalized.color;
      point.pixelSize = normalized.pixelSize;
      point.outlineWidth = normalized.outlineWidth;
      point.outlineColor = normalized.outlineColor;
    }
    // 标签的颜色 / 字体 / 偏移是逐条属性：开关或外观变化都按新样式整层重建。
    const labels = this.currentLabels;
    if (labels) {
      this.removeCollection(labels);
      this.currentLabels = undefined;
    }
    const next = this.currentStyle.labels.enabled ? this.buildLabelsForCurrentPoints() : undefined;
    if (next) {
      next.show = this.visible;
      this.currentLabels = next;
    }
  }

  /**
   * 用当前样式重建标签集合。
   *
   * 标签属性（字体、颜色、偏移）是逐条写入的，没有整层批量接口，因此样式变化时按当前点位重建；
   * 点位本身在 `currentCollection` 里只存了 Cartesian3，重建标签需要文本，所以这里保住原始规格。
   */
  private buildLabelsForCurrentPoints(): LabelCollection | undefined {
    const collection = buildLabels(this.currentPoints, this.currentStyle);
    if (!collection) {
      return undefined;
    }
    try {
      this.viewer.scene.primitives.add(collection);
    } catch (cause: unknown) {
      collection.destroy();
      throw cause;
    }
    return collection;
  }

  setData(points: readonly PointSpec[], options: OperationOptions = {}): Promise<void> {
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
        const normalized = normalizePoints(this.id, points, 'setData');
        if (options.signal?.aborted) {
          throw options.signal.reason;
        }
        // 先建好新集合再加入场景，最后移除旧集合，避免替换过程中出现空白帧。
        const next = buildCollection(normalized, this.currentStyle);
        try {
          this.viewer.scene.primitives.add(next);
        } catch (cause: unknown) {
          next.destroy();
          throw cause;
        }
        const nextLabels = buildLabels(normalized, this.currentStyle);
        if (nextLabels) {
          try {
            this.viewer.scene.primitives.add(nextLabels);
          } catch (cause: unknown) {
            nextLabels.destroy();
            this.removeCollection(next);
            throw cause;
          }
        }
        const previous = this.currentCollection;
        const previousLabels = this.currentLabels;
        this.currentCollection = next;
        this.currentLabels = nextLabels;
        this.currentPoints = normalized;
        this.currentCollection.show = this.visible;
        if (nextLabels) {
          nextLabels.show = this.visible;
        }
        this.currentCount = normalized.length;
        this.removeCollection(previous);
        if (previousLabels) {
          this.removeCollection(previousLabels);
        }
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
            : layerError(this.id, 'failed to replace points.', 'setData');
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

  private removeCollection(collection: PointPrimitiveCollection | LabelCollection): void {
    const removed = this.viewer.scene.primitives.remove(collection);
    if (!removed) {
      collection.destroy();
    }
  }
}

/** @internal */
export function createPointsLayer(
  viewer: Viewer,
  spec: PointsLayerSpec,
  context: LayerFactoryContext,
): Promise<PointsLayerHandle> {
  let collection: PointPrimitiveCollection | undefined;
  let added = false;
  try {
    if (context.signal.aborted) {
      throw operationAborted(spec.id, 'add', context.signal.reason);
    }
    const styleSource: PointsLayerStyle = {
      ...(spec.color === undefined ? {} : { color: spec.color }),
      ...(spec.pixelSize === undefined ? {} : { pixelSize: spec.pixelSize }),
      ...(spec.outlineWidth === undefined ? {} : { outlineWidth: spec.outlineWidth }),
      ...(spec.outlineColor === undefined ? {} : { outlineColor: spec.outlineColor }),
      ...(spec.labels === undefined ? {} : { labels: spec.labels }),
    };
    const style = normalizeStyle(spec.id, styleSource, 'add');
    const points = normalizePoints(spec.id, spec.points, 'add');
    const visible = spec.visible ?? true;
    collection = buildCollection(points, style);
    collection.show = visible;
    viewer.scene.primitives.add(collection);
    added = true;
    const labels = buildLabels(points, style);
    if (labels) {
      labels.show = visible;
      viewer.scene.primitives.add(labels);
    }
    // 建点是同步过程，工厂契约要求返回 Promise，这里显式包一层。
    return Promise.resolve(
      new CesiumPointsLayerHandle(
        viewer,
        spec.id,
        collection,
        labels,
        points,
        points.length,
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
    throw layerError(spec.id, 'failed to create point primitives.', 'add');
  }
}
