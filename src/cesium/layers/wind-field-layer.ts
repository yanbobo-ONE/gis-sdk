import { Cartesian3, Color, Material, PolylineCollection } from 'cesium';
import type { Polyline, Viewer } from 'cesium';

import { GisError } from '../../core/errors.js';
import type { EventHub } from '../../core/event-hub.js';
import {
  advectWindParticles,
  buildWindField,
  createWindParticles,
  MAX_WIND_PARTICLES,
  sampleWind,
} from '../../core/wind-field.js';
import type { WindField, WindFieldInput, WindParticle } from '../../core/wind-field.js';
import type {
  LayerEventMap,
  LayerState,
  WindFieldLayerHandle,
  WindFieldLayerSpec,
  WindFieldStyleOptions,
} from '../../layers/contracts.js';
import { LayerHandleRuntime } from '../../layers/layer-handle-runtime.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';

/** 默认粒子数与配色（按风速从低到高）。 */
const DEFAULT_PARTICLES = 1_500;
const DEFAULT_LIFETIME_SECONDS = 12;
const DEFAULT_WIDTH = 2;
const DEFAULT_COLORS = ['#38bdf8', '#7dd3fc', '#e0f2fe'] as const;

/** 单帧推进上限：标签页切回前台时不要用巨大的 delta 把粒子一次性甩飞。 */
const MAX_STEP_SECONDS = 0.2;

/** 拖尾低于该长度不渲染，避免静止粒子画出一个个点。 */
const MIN_TRAIL_METERS = 1;
const METERS_PER_DEGREE_LATITUDE = (2 * Math.PI * 6_371_008.8) / 360;

function layerError(
  message: string,
  code: 'INVALID_LAYER_CONFIG' | 'INVALID_LAYER_OPACITY' | 'LAYER_BUSY' | 'LAYER_LOAD_FAILED',
  operation: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): GisError {
  return new GisError(message, { code, module: 'layer', operation, ...options });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 校验后的样式。 */
interface ResolvedWindStyle {
  readonly particles: number;
  readonly speedScale: number;
  readonly lifetimeSeconds: number;
  readonly heightMeters: number | undefined;
  readonly stepSeconds: number | undefined;
  readonly width: number;
  readonly colors: readonly Color[];
  readonly opacity: number;
  readonly seed: number;
}

function resolveColors(value: unknown, operation: string): readonly Color[] {
  if (value === undefined) {
    return DEFAULT_COLORS.map((color) => Color.fromCssColorString(color));
  }
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) {
    throw layerError('Wind colors need 2 to 6 entries.', 'INVALID_LAYER_CONFIG', operation);
  }
  const colors: Color[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw layerError(
        'Wind colors must be non-empty CSS color strings.',
        'INVALID_LAYER_CONFIG',
        operation,
      );
    }
    colors.push(Color.fromCssColorString(entry.trim()));
  }
  return colors;
}

function resolveStyle(
  requested: WindFieldStyleOptions | undefined,
  previous: ResolvedWindStyle | undefined,
  operation: string,
): ResolvedWindStyle {
  const source = (requested as Partial<WindFieldStyleOptions> | undefined) ?? {};
  const particles = source.particles ?? previous?.particles ?? DEFAULT_PARTICLES;
  if (!Number.isSafeInteger(particles) || particles <= 0 || particles > MAX_WIND_PARTICLES) {
    throw layerError(
      `Wind particles must be an integer between 1 and ${String(MAX_WIND_PARTICLES)}.`,
      'INVALID_LAYER_CONFIG',
      operation,
    );
  }
  const speedScale = source.speedScale ?? previous?.speedScale ?? 1;
  if (!finiteNumber(speedScale) || speedScale <= 0) {
    throw layerError(
      'Wind speedScale must be a positive finite number.',
      'INVALID_LAYER_CONFIG',
      operation,
    );
  }
  const lifetimeSeconds =
    source.lifetimeSeconds ?? previous?.lifetimeSeconds ?? DEFAULT_LIFETIME_SECONDS;
  if (!finiteNumber(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw layerError(
      'Wind lifetimeSeconds must be a positive finite number.',
      'INVALID_LAYER_CONFIG',
      operation,
    );
  }
  const heightMeters = source.heightMeters ?? previous?.heightMeters;
  if (heightMeters !== undefined && !finiteNumber(heightMeters)) {
    throw layerError(
      'Wind heightMeters must be a finite number.',
      'INVALID_LAYER_CONFIG',
      operation,
    );
  }
  const stepSeconds = source.stepSeconds ?? previous?.stepSeconds;
  if (stepSeconds !== undefined && (!finiteNumber(stepSeconds) || stepSeconds <= 0)) {
    throw layerError(
      'Wind stepSeconds must be a positive finite number.',
      'INVALID_LAYER_CONFIG',
      operation,
    );
  }
  const width = source.width ?? previous?.width ?? DEFAULT_WIDTH;
  if (!finiteNumber(width) || width <= 0) {
    throw layerError(
      'Wind width must be a positive finite number.',
      'INVALID_LAYER_CONFIG',
      operation,
    );
  }
  const opacity = source.opacity ?? previous?.opacity ?? 1;
  if (!finiteNumber(opacity) || opacity < 0 || opacity > 1) {
    throw layerError('Wind opacity must be between 0 and 1.', 'INVALID_LAYER_OPACITY', operation);
  }
  const colors =
    source.colors === undefined
      ? (previous?.colors ?? resolveColors(undefined, operation))
      : resolveColors(source.colors, operation);
  const seed = source.seed ?? previous?.seed ?? 1;
  if (!finiteNumber(seed)) {
    throw layerError('Wind seed must be a finite number.', 'INVALID_LAYER_CONFIG', operation);
  }
  return {
    particles,
    speedScale,
    lifetimeSeconds,
    heightMeters,
    stepSeconds,
    width,
    colors,
    opacity,
    seed,
  };
}

/** 一颗粒子的折线状态：两点拖尾 + 缓存的 Cartesian3（避免逐帧分配）。 */
interface ParticleLine {
  readonly polyline: Polyline;
  readonly tail: Cartesian3;
  readonly head: Cartesian3;
  readonly positions: Cartesian3[];
  particle: WindParticle;
  bucket: number;
}

class CesiumWindFieldLayerHandle implements WindFieldLayerHandle {
  readonly type = 'wind-field' as const;
  private readonly lifecycle: LayerHandleRuntime;
  private materials: readonly Material[] = [];
  private readonly collection: PolylineCollection;
  private readonly removeFrameListener: (() => void) | undefined;
  private field: WindField;
  private style: ResolvedWindStyle;
  private lines: ParticleLine[] = [];
  private lastTick: number;
  private currentAverageSpeed: number | undefined;
  private pending: Promise<void> | undefined;
  private frameIndex = 0;
  private disposed = false;

  constructor(
    private readonly viewer: Viewer,
    readonly id: string,
    field: WindField,
    style: ResolvedWindStyle,
    visible: boolean,
    private readonly now: () => number,
    onDisposed: () => void,
  ) {
    this.field = field;
    this.style = style;
    this.collection = new PolylineCollection();
    this.viewer.scene.primitives.add(this.collection);
    this.lifecycle = new LayerHandleRuntime({
      id,
      type: this.type,
      visible,
      onSetVisible: (nextVisible) => {
        this.collection.show = nextVisible;
      },
      onDispose: () => {
        this.disposed = true;
        this.removeFrameListener?.();
        this.viewer.scene.primitives.remove(this.collection);
      },
      onDisposed,
    });
    this.lastTick = this.now();
    this.rebuildParticles();
    const remove = this.viewer.scene.preRender.addEventListener(() => {
      this.advance();
    });
    if (typeof remove === 'function') {
      this.removeFrameListener = remove;
    }
  }

  get events(): EventHub<LayerEventMap> {
    return this.lifecycle.events;
  }

  get state(): LayerState {
    return this.lifecycle.state;
  }

  get visible(): boolean {
    return this.lifecycle.visible;
  }

  get particleCount(): number {
    return this.lines.length;
  }

  get averageSpeed(): number | undefined {
    return this.currentAverageSpeed;
  }

  get errorCount(): number {
    return this.lifecycle.errorCount;
  }

  setVisible(visible: boolean): void {
    this.lifecycle.setVisible(visible);
  }

  setData(field: WindFieldInput): Promise<void> {
    this.lifecycle.assertUsable('setData');
    let next: WindField;
    try {
      next = buildWindField(field);
    } catch (cause: unknown) {
      return Promise.reject(this.wrapConfigError(cause, 'setData'));
    }
    return this.replace(next, this.style, 'setData');
  }

  setStyle(style: WindFieldStyleOptions): Promise<void> {
    this.lifecycle.assertUsable('setStyle');
    let next: ResolvedWindStyle;
    try {
      next = resolveStyle(style, this.style, 'setStyle');
    } catch (cause: unknown) {
      return Promise.reject(cause instanceof Error ? cause : new Error('Invalid wind style.'));
    }
    return this.replace(this.field, next, 'setStyle');
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  /** 重建几何与粒子：先校验、再替换，失败时保留原来的风场继续跑。 */
  private replace(field: WindField, style: ResolvedWindStyle, operation: string): Promise<void> {
    if (this.pending) {
      return Promise.reject(
        layerError(`Layer "${this.id}" is already replacing its data.`, 'LAYER_BUSY', operation, {
          retryable: true,
        }),
      );
    }
    const tracked = Promise.resolve().then(() => {
      this.lifecycle.assertUsable(operation);
      this.clearLines();
      this.field = field;
      this.style = style;
      this.rebuildParticles();
    });
    const guarded = tracked.finally(() => {
      if (this.pending === guarded) {
        this.pending = undefined;
      }
    });
    this.pending = guarded;
    return guarded;
  }

  private wrapConfigError(cause: unknown, operation: string): GisError {
    if (cause instanceof GisError) {
      return layerError(
        `Wind field layer "${this.id}" ${cause.message}`,
        'INVALID_LAYER_CONFIG',
        operation,
        {
          cause,
        },
      );
    }
    return layerError(`Failed to update wind field layer.`, 'INVALID_LAYER_CONFIG', operation, {
      cause,
    });
  }

  private clearLines(): void {
    for (const line of this.lines) {
      this.collection.remove(line.polyline);
    }
    this.lines = [];
    this.currentAverageSpeed = undefined;
  }

  /** 按当前样式播撒粒子并建折线；颜色按风速分档，材质共享同一批实例。 */
  private rebuildParticles(): void {
    const particles = createWindParticles(this.field, {
      count: this.style.particles,
      seed: this.style.seed,
      ...(this.style.heightMeters === undefined ? {} : { heightMeters: this.style.heightMeters }),
      lifetimeSeconds: this.style.lifetimeSeconds,
    });
    // PolylineCollection 只接受真正的 Material（它直接读 material.shaderSource），
    // 因此每个风速档建一份内置辉光材质，逐条折线复用。
    this.materials = this.style.colors.map((color) =>
      Material.fromType('PolylineGlow', { color, glowPower: 0.25, taperPower: 1 }),
    );

    this.lines = particles.map((particle) => {
      const bucket = this.bucketOf(0);
      const material = this.materials[bucket];
      const tail = Cartesian3.fromDegrees(particle.longitude, particle.latitude, particle.height);
      const head = Cartesian3.fromDegrees(particle.longitude, particle.latitude, particle.height);
      const positions = [tail, head];
      const polyline = this.collection.add({
        positions,
        width: this.style.width,
        ...(material === undefined ? {} : { material }),
        show: false,
      });
      return { polyline, tail, head, positions, particle, bucket };
    });
  }

  /** 风速分档：0 到 colors.length - 1。 */
  private bucketOf(speed: number): number {
    const count = this.style.colors.length;
    const max = this.field.maxSpeed > 0 ? this.field.maxSpeed : 1;
    const ratio = Math.min(1, Math.max(0, speed / max));
    return Math.min(count - 1, Math.floor(ratio * count));
  }

  /** 逐帧推进：采样、平流、更新拖尾；隐藏或释放后不再空转。 */
  private advance(): void {
    if (this.disposed || !this.lifecycle.visible || this.lines.length === 0) {
      return;
    }
    const tick = this.now();
    const rawDelta = Math.max(0, (tick - this.lastTick) / 1_000);
    this.lastTick = tick;
    const deltaSeconds = Math.min(MAX_STEP_SECONDS, this.style.stepSeconds ?? rawDelta);
    if (deltaSeconds <= 0) {
      return;
    }

    this.frameIndex += 1;
    const next = advectWindParticles(
      this.field,
      this.lines.map((line) => line.particle),
      {
        deltaSeconds,
        speedScale: this.style.speedScale,
        lifetimeSeconds: this.style.lifetimeSeconds,
        seed: this.style.seed + this.frameIndex,
        ...(this.style.heightMeters === undefined ? {} : { heightMeters: this.style.heightMeters }),
      },
    );

    let speedSum = 0;
    let speedCount = 0;
    this.lines.forEach((line, index) => {
      const particle = next[index];
      if (!particle) {
        return;
      }
      const previous = line.particle;
      line.particle = particle;
      // 拖尾画"上一位置 → 当前位置"：重掷（年龄归零）时不画线，避免瞬移的长线。
      const respawned = particle.ageSeconds < previous.ageSeconds;
      const movedMeters = Math.hypot(
        (particle.longitude - previous.longitude) *
          METERS_PER_DEGREE_LATITUDE *
          Math.max(0.01, Math.cos((particle.latitude * Math.PI) / 180)),
        (particle.latitude - previous.latitude) * METERS_PER_DEGREE_LATITUDE,
      );
      if (respawned || movedMeters < MIN_TRAIL_METERS) {
        line.polyline.show = false;
        return;
      }
      Cartesian3.fromDegrees(
        previous.longitude,
        previous.latitude,
        previous.height,
        undefined,
        line.tail,
      );
      Cartesian3.fromDegrees(
        particle.longitude,
        particle.latitude,
        particle.height,
        undefined,
        line.head,
      );
      // 重新赋值 positions：折线集合靠这个 setter 标脏并重写顶点缓冲。
      line.polyline.positions = line.positions;
      line.polyline.show = true;

      const sample = sampleWind(this.field, particle);
      if (sample) {
        speedSum += sample.speed;
        speedCount += 1;
        const bucket = this.bucketOf(sample.speed);
        if (bucket !== line.bucket) {
          line.bucket = bucket;
          const material = this.materials[bucket];
          if (material) {
            line.polyline.material = material;
          }
        }
      }
    });

    this.currentAverageSpeed = speedCount > 0 ? speedSum / speedCount : undefined;
  }
}

/** @internal */
export function createWindFieldLayer(
  viewer: Viewer,
  spec: WindFieldLayerSpec,
  context: LayerFactoryContext,
  now: () => number = () => Date.now(),
): Promise<WindFieldLayerHandle> {
  try {
    const requested = spec as { readonly field?: WindFieldInput } | undefined;
    if (!requested?.field) {
      throw layerError(
        `Wind field layer "${spec.id}" needs a field.`,
        'INVALID_LAYER_CONFIG',
        'add',
      );
    }
    const field = buildWindField(requested.field);
    const style = resolveStyle(spec, undefined, 'add');
    return Promise.resolve(
      new CesiumWindFieldLayerHandle(
        viewer,
        spec.id,
        field,
        style,
        spec.visible ?? true,
        now,
        context.onDisposed,
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof GisError) {
      // 已经是图层族的错误码（INVALID_LAYER_* / LAYER_*）就原样抛出，
      // 别把 INVALID_LAYER_OPACITY 这类具体原因吞成笼统的 INVALID_LAYER_CONFIG。
      if (cause.code.startsWith('INVALID_LAYER_') || cause.code.startsWith('LAYER_')) {
        return Promise.reject(cause);
      }
      return Promise.reject(
        layerError(
          `Wind field layer "${spec.id}" ${cause.message}`,
          'INVALID_LAYER_CONFIG',
          'add',
          {
            cause,
          },
        ),
      );
    }
    return Promise.reject(
      layerError(`Failed to add wind field layer "${spec.id}".`, 'LAYER_LOAD_FAILED', 'add', {
        retryable: true,
        cause,
      }),
    );
  }
}
