import { Cartesian3, Color, ColorBlendMode, HeadingPitchRoll, Model, Transforms } from 'cesium';
import type { CustomShader, Matrix4, Viewer } from 'cesium';

import type { PickingMarker } from '../../core/controls.js';
import { GisError } from '../../core/errors.js';
import type { EventHub } from '../../core/event-hub.js';
import type {
  LayerEventMap,
  LayerState,
  ModelAppearanceOptions,
  ModelLayerHandle,
  ModelLayerSpec,
  ModelOrientation,
  ModelPosition,
  ModelTransform,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import type { CesiumLayerServices } from '../layer-services.js';
import type { ModelAppearanceShaders } from './model-appearance.js';

/** Cesium 在未指定颜色混合时使用的原始外观。 */
const ORIGINAL_APPEARANCE = {
  color: Color.WHITE,
  colorBlendMode: ColorBlendMode.HIGHLIGHT,
  colorBlendAmount: 0.5,
} as const;

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
  if (signal.aborted) return Promise.reject(abortReason(signal.reason));
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

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function layerError(
  id: string,
  message: string,
  operation: string,
  code: 'INVALID_LAYER_CONFIG' | 'INVALID_LAYER_COLOR' = 'INVALID_LAYER_CONFIG',
): GisError {
  return new GisError(`Model layer "${id}" ${message}`, {
    code,
    module: 'layer',
    operation,
  });
}

function normalizePosition(
  id: string,
  position: ModelPosition | undefined,
  operation: string,
): { readonly longitude: number; readonly latitude: number; readonly height: number } {
  const { longitude, latitude, height = 0 } = position ?? {};
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
      'position must contain valid WGS84 longitude, latitude, and height.',
      operation,
    );
  }
  return { longitude, latitude, height };
}

function normalizeOrientation(
  id: string,
  orientation: ModelOrientation | undefined,
  operation: string,
): { readonly heading: number; readonly pitch: number; readonly roll: number } {
  const { heading = 0, pitch = 0, roll = 0 } = orientation ?? {};
  if (!finite(heading) || !finite(pitch) || !finite(roll)) {
    throw layerError(id, 'orientation must contain finite degree values.', operation);
  }
  return { heading, pitch, roll };
}

function normalizeHeadingOffset(
  id: string,
  headingOffset: number | undefined,
  operation: string,
): number {
  if (headingOffset !== undefined && !finite(headingOffset)) {
    throw layerError(id, 'headingOffset must be a finite degree value.', operation);
  }
  return headingOffset ?? 0;
}

function normalizeScale(
  id: string,
  scale: number | undefined,
  operation: string,
): number | undefined {
  if (scale !== undefined && (!finite(scale) || scale <= 0)) {
    throw layerError(id, 'scale must be a positive finite number.', operation);
  }
  return scale;
}

/**
 * 由位置、姿态与朝向补偿构造模型矩阵。
 *
 * `headingOffset` 是模型资源自身的朝向差异，与业务姿态的 heading 相加后进入矩阵，
 * 因此业务姿态本身不被改写。
 */
function modelMatrixFor(
  position: { readonly longitude: number; readonly latitude: number; readonly height: number },
  orientation: { readonly heading: number; readonly pitch: number; readonly roll: number },
  headingOffset: number,
): Matrix4 {
  const point = Cartesian3.fromDegrees(position.longitude, position.latitude, position.height);
  const headingPitchRoll = HeadingPitchRoll.fromDegrees(
    orientation.heading + headingOffset,
    orientation.pitch,
    orientation.roll,
  );
  return Transforms.headingPitchRollToFixedFrame(point, headingPitchRoll);
}

function parseColor(id: string, value: unknown, operation: string): Color {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const color = normalized ? Color.fromCssColorString(normalized) : undefined;
  if (!color) {
    throw layerError(
      id,
      'color must be a CSS color string, for example "#ff8800" or "rgba(255, 136, 0, 0.8)".',
      operation,
      'INVALID_LAYER_COLOR',
    );
  }
  return color;
}

interface NormalizedModelConfig {
  readonly url: string;
  readonly modelMatrix: Matrix4;
  readonly headingOffset: number;
  readonly scale: number | undefined;
  readonly minimumPixelSize: number | undefined;
  readonly maximumScale: number | undefined;
  readonly allowPicking: boolean;
  readonly color: Color | undefined;
}

function normalizeConfig(spec: ModelLayerSpec): NormalizedModelConfig {
  const url = typeof spec.url === 'string' ? spec.url.trim() : '';
  if (!url) {
    throw layerError(spec.id, 'requires a non-empty URL.', 'add');
  }

  const position = normalizePosition(spec.id, spec.position, 'add');
  const orientation = normalizeOrientation(spec.id, spec.orientation, 'add');
  const headingOffset = normalizeHeadingOffset(spec.id, spec.headingOffset, 'add');
  const scale = normalizeScale(spec.id, spec.scale, 'add');

  if (
    spec.minimumPixelSize !== undefined &&
    (!finite(spec.minimumPixelSize) || spec.minimumPixelSize < 0)
  ) {
    throw layerError(spec.id, 'minimumPixelSize must be a non-negative finite number.', 'add');
  }
  if (spec.maximumScale !== undefined && (!finite(spec.maximumScale) || spec.maximumScale <= 0)) {
    throw layerError(spec.id, 'maximumScale must be a positive finite number.', 'add');
  }
  const minimumPixelSize = spec.minimumPixelSize;
  const maximumScale = spec.maximumScale;
  if (minimumPixelSize !== undefined && maximumScale !== undefined && maximumScale < (scale ?? 1)) {
    throw layerError(
      spec.id,
      'maximumScale must not be below scale when minimumPixelSize is set.',
      'add',
    );
  }
  if (spec.allowPicking !== undefined && typeof spec.allowPicking !== 'boolean') {
    throw layerError(spec.id, 'allowPicking must be a boolean.', 'add');
  }

  return {
    url,
    modelMatrix: modelMatrixFor(position, orientation, headingOffset),
    headingOffset,
    scale,
    minimumPixelSize,
    maximumScale,
    allowPicking: spec.allowPicking ?? true,
    color: spec.color === undefined ? undefined : parseColor(spec.id, spec.color, 'add'),
  };
}

/** 只写入显式给定的字段，避免把 `undefined` 传给 Cesium 覆盖其默认值。 */
function modelOptions(config: NormalizedModelConfig, show: boolean) {
  return {
    url: config.url,
    modelMatrix: config.modelMatrix,
    show,
    allowPicking: config.allowPicking,
    ...(config.scale === undefined ? {} : { scale: config.scale }),
    ...(config.minimumPixelSize === undefined ? {} : { minimumPixelSize: config.minimumPixelSize }),
    ...(config.maximumScale === undefined ? {} : { maximumScale: config.maximumScale }),
    ...(config.color === undefined
      ? {}
      : { color: config.color, colorBlendMode: ColorBlendMode.MIX, colorBlendAmount: 1 }),
  };
}

function removeModel(viewer: Viewer, model: Model): void {
  const removed = viewer.scene.primitives.remove(model);
  if (!removed) model.destroy();
}

function destroyLateModel(loading: Promise<Model>): void {
  void loading
    .then((model) => {
      model.destroy();
    })
    .catch(() => undefined);
}

/** Cesium 1.144 把 `customShader` 声明为必填，运行时默认值其实是 undefined。 */
interface ModelShaderHost {
  customShader: CustomShader | undefined;
}

class CesiumModelLayerHandle implements ModelLayerHandle {
  readonly type = 'model' as const;
  private readonly lifecycle: LayerHandleRuntime;
  private readonly shaderHost: ModelShaderHost;
  private appliedShader: CustomShader | undefined;
  private previousShader: CustomShader | undefined;
  private recordedShader = false;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    private readonly model: Model,
    private readonly headingOffset: number,
    private readonly shaders: ModelAppearanceShaders,
    visible: boolean,
    onDisposed: () => void,
  ) {
    this.shaderHost = model;
    this.lifecycle = new LayerHandleRuntime({
      id,
      type: this.type,
      visible,
      onSetVisible: (nextVisible) => {
        this.model.show = nextVisible;
      },
      onDispose: () => {
        removeModel(this.viewer, this.model);
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

  setTransform(transform?: ModelTransform): void {
    this.lifecycle.assertUsable('setTransform');
    const position = normalizePosition(this.id, transform?.position, 'setTransform');
    const orientation = normalizeOrientation(this.id, transform?.orientation, 'setTransform');
    this.model.modelMatrix = modelMatrixFor(position, orientation, this.headingOffset);
    const scale = normalizeScale(this.id, transform?.scale, 'setTransform');
    if (scale !== undefined) {
      this.model.scale = scale;
    }
  }

  setColor(color?: string): void {
    this.lifecycle.assertUsable('setColor');
    if (color === undefined) {
      this.model.color = ORIGINAL_APPEARANCE.color;
      this.model.colorBlendMode = ORIGINAL_APPEARANCE.colorBlendMode;
      this.model.colorBlendAmount = ORIGINAL_APPEARANCE.colorBlendAmount;
      return;
    }
    this.model.color = parseColor(this.id, color, 'setColor');
    this.model.colorBlendMode = ColorBlendMode.MIX;
    this.model.colorBlendAmount = 1;
  }

  setAppearance(options?: ModelAppearanceOptions): void {
    this.lifecycle.assertUsable('setAppearance');
    const shader = this.shaders.resolve(options, 'setAppearance');
    if (!this.recordedShader) {
      // 记录首次接管前的值，恢复时只写回本图层没改过的情况。
      this.previousShader = this.shaderHost.customShader;
      this.recordedShader = true;
    }
    if (shader === undefined) {
      if (this.shaderHost.customShader === this.appliedShader) {
        this.shaderHost.customShader = this.previousShader;
      }
      this.appliedShader = undefined;
      return;
    }
    this.shaderHost.customShader = shader;
    this.appliedShader = shader;
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }
}

/** @internal */
export async function createModelLayer(
  viewer: Viewer,
  spec: ModelLayerSpec,
  context: LayerFactoryContext,
  services: CesiumLayerServices,
): Promise<ModelLayerHandle> {
  let loading: Promise<Model> | undefined;
  let model: Model | undefined;
  let added = false;
  try {
    if (context.signal.aborted) throw operationAborted(spec.id, context.signal.reason);
    const config = normalizeConfig(spec);
    const visible = spec.visible ?? true;
    loading = services.modelLoad.run(
      () => Model.fromGltfAsync(modelOptions(config, visible)),
      context.signal,
    );
    model = await raceAbort(loading, context.signal);
    // 拾取标记：Cesium 把 Model.id 声明为 string，运行时允许任意值，这里写入图层标记以便拾取还原。
    (model as { id?: unknown }).id = { layerId: spec.id } satisfies PickingMarker;
    viewer.scene.primitives.add(model);
    added = true;
    const handle = new CesiumModelLayerHandle(
      viewer,
      spec.id,
      model,
      config.headingOffset,
      services.modelAppearance,
      visible,
      context.onDisposed,
    );
    if (spec.appearance) {
      handle.setAppearance(spec.appearance);
    }
    return handle;
  } catch (cause: unknown) {
    if (added && model) removeModel(viewer, model);
    else if (model) model.destroy();
    else if (loading && context.signal.aborted) destroyLateModel(loading);
    if (cause instanceof GisError) throw cause;
    if (context.signal.aborted) throw operationAborted(spec.id, cause);
    throw new GisError(`Failed to load model for layer "${spec.id}".`, {
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation: 'add',
      retryable: true,
      cause,
    });
  }
}
