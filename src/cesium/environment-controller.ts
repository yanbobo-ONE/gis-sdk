import { Color, PostProcessStage, PostProcessStageSampleMode, SceneMode } from 'cesium';

import type {
  DepthFogEffectState,
  DepthFogOptions,
  EnvironmentController,
  EnvironmentEffectKind,
  EnvironmentEffectState,
  EnvironmentEffectStateMap,
  EnvironmentOptionsMap,
  HazeEffectState,
  HazeOptions,
  PrecipitationEffectState,
  PrecipitationOptions,
  ResolvedDepthFogOptions,
  ResolvedPrecipitationOptions,
} from '../core/environment.js';
import {
  EnvironmentTimeline,
  PRECIPITATION_INTENSITY_DENSITY,
  resolveDepthFogOptions,
  resolveHazeOptions,
  resolvePrecipitationOptions,
} from '../core/environment.js';
import { GisError } from '../core/errors.js';
import { FieldGuard } from '../core/field-guard.js';
import { depthFogFragmentShader, precipitationFragmentShader } from './environment-shaders.js';

/** 后处理阶段的固定名称，便于在 Cesium 诊断工具里识别。 */
const DEPTH_FOG_STAGE_NAME = 'GisSdkDepthFog';
const PRECIPITATION_STAGE_NAME = 'GisSdkPrecipitation';

/** 降水层数：屏幕上叠加的粒子层，层数越多越密也越耗 GPU。 */
const PRECIPITATION_LAYERS = 3;

/** 降水纹理采样比例：低于 1 时在更小的缓冲上算粒子，省填充率。 */
const PRECIPITATION_TEXTURE_SCALE = 0.5;

/** 后处理阶段的最小操作面；Cesium 的其它成员留在适配器内部。 */
interface StageLike {
  enabled: boolean;
  uniforms: Record<string, unknown>;
  destroy(): void;
}

/** 后处理阶段集合的最小操作面；`remove` 会连同阶段一起销毁。 */
interface PostProcessStagesLike {
  add(stage: StageLike): unknown;
  remove(stage: StageLike): boolean;
}

/** 场景的最小操作面（结构兼容 Cesium `Scene`）。 */
interface SceneLike {
  readonly mode: SceneMode;
  readonly camera: { readonly positionCartographic: { readonly height: number } };
  readonly fog: unknown;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly postProcessStages: PostProcessStagesLike;
  readonly preRender: { addEventListener(listener: () => void): () => void };
  requestRender(): void;
}

/** 环境控制器需要的地图最小操作面。 */
interface EnvironmentViewerLike {
  readonly scene: SceneLike;
}

/** 默认的真实时间采样：浏览器与 Worker 都可用。 */
function defaultNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function unsupported(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'ENVIRONMENT_UNSUPPORTED',
    module: 'environment',
    operation,
  });
}

function invalidConfig(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_ENVIRONMENT_CONFIG',
    module: 'environment',
    operation,
  });
}

/**
 * Cesium 侧环境效果控制器。
 *
 * 两类效果分开实现，与参照实现一致：
 *
 * - **后处理型**（深度雾、雨、雪）：各自一个 `PostProcessStage`，参数写进 uniform，逐帧只更新
 *   相机高度、视口比例与动画时间；阶段在首次应用时创建，清除时从 `scene.postProcessStages`
 *   移除（该集合的 `remove` 会自行销毁阶段）。
 * - **场景字段型**（基础雾）：接管官方 `scene.fog` 的字段，通过 `FieldGuard` 记录原值；清除或
 *   销毁时只恢复"当前值仍等于 SDK 最后写入值"的字段，不会覆盖业务在生效期间写入的新值。
 *
 * 只使用 Cesium 的公开 API：`PostProcessStage`、`scene.postProcessStages`、`scene.fog`、
 * `scene.preRender`、`scene.requestRender()`。
 *
 * @internal
 */
export class CesiumEnvironmentController implements EnvironmentController {
  private readonly states = new Map<EnvironmentEffectKind, EnvironmentEffectState>();
  private readonly timeline = new EnvironmentTimeline();
  private readonly hazeGuard: FieldGuard;
  private readonly removeFrameListener: (() => void) | undefined;
  private depthFogStage: StageLike | undefined;
  private precipitationStage: StageLike | undefined;
  private disposed = false;

  constructor(
    private readonly viewer: EnvironmentViewerLike,
    private readonly now: () => number = defaultNow,
  ) {
    const fog: unknown = this.viewer.scene.fog;
    this.hazeGuard = new FieldGuard(
      fog && typeof fog === 'object' ? (fog as Record<string, unknown>) : undefined,
    );
    this.removeFrameListener = this.viewer.scene.preRender.addEventListener(() => {
      this.tick();
    });
  }

  get active(): readonly EnvironmentEffectState[] {
    return [...this.states.values()];
  }

  set<K extends EnvironmentEffectKind>(
    kind: K,
    options?: EnvironmentOptionsMap[K],
  ): EnvironmentEffectStateMap[K] {
    this.assertActive('set');
    // 参数按种类分派到各自的校验器；运行期校验才是唯一来源，因此这里按分支收敛类型。
    const input: unknown = options;
    switch (kind) {
      case 'depthFog':
        return this.applyDepthFog(
          resolveDepthFogOptions(input as DepthFogOptions),
        ) as EnvironmentEffectStateMap[K];
      case 'haze':
        return this.applyHaze(resolveHazeOptions(input as HazeOptions)) as EnvironmentEffectStateMap[K];
      case 'rain':
      case 'snow':
        return this.applyPrecipitation(
          kind,
          resolvePrecipitationOptions(input as PrecipitationOptions),
        ) as EnvironmentEffectStateMap[K];
      default:
        throw invalidConfig(`Unsupported environment effect: ${String(kind)}.`, 'set');
    }
  }

  setEnabled(kind: EnvironmentEffectKind, enabled: boolean): EnvironmentEffectState | undefined {
    this.assertActive('setEnabled');
    const current = this.states.get(kind);
    if (!current) {
      return undefined;
    }
    if (current.kind === 'haze') {
      this.hazeGuard.set('enabled', enabled);
      this.viewer.scene.requestRender();
      const next: HazeEffectState = { ...current, enabled };
      this.states.set(kind, next);
      return next;
    }
    if (current.kind === 'depthFog') {
      const stage = this.depthFogStage;
      if (stage) {
        stage.enabled = enabled;
      }
      this.writeDepthFogStrength(enabled);
      const next: DepthFogEffectState = { ...current, enabled };
      this.states.set(kind, next);
      return next;
    }
    const stage = this.precipitationStage;
    if (stage) {
      stage.enabled = enabled;
      stage.uniforms.uOpacity = enabled ? 1 : 0;
    }
    const next: PrecipitationEffectState = { ...current, enabled };
    this.states.set(kind, next);
    return next;
  }

  clear(kind: EnvironmentEffectKind): void {
    this.assertActive('clear');
    if (!this.states.delete(kind)) {
      return;
    }
    if (kind === 'haze') {
      this.hazeGuard.restore();
      this.viewer.scene.requestRender();
      return;
    }
    if (kind === 'depthFog') {
      const stage = this.depthFogStage;
      this.depthFogStage = undefined;
      if (stage) {
        this.removeStage(stage);
      }
      return;
    }
    // 雨与雪共用一个阶段：清除其中一个就撤掉整个阶段。
    if (!this.states.has('rain') && !this.states.has('snow')) {
      const stage = this.precipitationStage;
      this.precipitationStage = undefined;
      if (stage) {
        this.removeStage(stage);
      }
    }
  }

  clearAll(): void {
    this.assertActive('clearAll');
    for (const kind of [...this.states.keys()]) {
      this.clear(kind);
    }
  }

  /** 释放全部效果与帧监听；销毁后继续调用会抛 `MAP_DISPOSED`。 */
  destroy(): void {
    if (this.disposed) {
      return;
    }
    for (const kind of [...this.states.keys()]) {
      this.clear(kind);
    }
    this.hazeGuard.restore();
    this.removeFrameListener?.();
    this.disposed = true;
  }

  private applyDepthFog(options: ResolvedDepthFogOptions): DepthFogEffectState {
    const stage = this.ensureDepthFogStage();
    const color: unknown = Color.fromCssColorString(options.color);
    if (!color) {
      throw invalidConfig(`Environment color "${options.color}" is not a CSS color.`, 'depthFog');
    }
    stage.uniforms.uDensity = options.density;
    stage.uniforms.uStart = options.startDistanceMeters;
    stage.uniforms.uEnd = options.endDistanceMeters;
    stage.uniforms.uColor = color;
    stage.uniforms.uHeightFalloff = options.heightFalloffMeters;
    stage.uniforms.uTopHeight = options.topHeightMeters;
    stage.uniforms.uBrightness = options.brightness;
    stage.uniforms.uCameraHeight = this.cameraHeight();
    const state: DepthFogEffectState = {
      kind: 'depthFog',
      enabled: true,
      options,
      ...this.depthFogDegraded(),
    };
    stage.enabled = true;
    this.writeDepthFogStrength(true);
    this.states.set('depthFog', state);
    return state;
  }

  private applyHaze(options: EnvironmentOptionsMap['haze']): HazeEffectState {
    const fog: unknown = this.viewer.scene.fog;
    if (!fog) {
      throw unsupported('The current scene has no fog object to apply haze to.', 'haze');
    }
    this.hazeGuard.set('enabled', true);
    if (options.density !== undefined) {
      this.hazeGuard.set('density', options.density);
    }
    if (options.heightFalloff !== undefined) {
      this.hazeGuard.set('heightFalloff', options.heightFalloff);
    }
    if (options.maxHeight !== undefined) {
      this.hazeGuard.set('maxHeight', options.maxHeight);
    }
    if (options.brightnessFloor !== undefined) {
      this.hazeGuard.set('minimumBrightness', options.brightnessFloor);
    }
    if (options.screenSpaceErrorFactor !== undefined) {
      this.hazeGuard.set('screenSpaceErrorFactor', options.screenSpaceErrorFactor);
    }
    this.viewer.scene.requestRender();
    const state: HazeEffectState = { kind: 'haze', enabled: true, options };
    this.states.set('haze', state);
    return state;
  }

  private applyPrecipitation(
    kind: 'rain' | 'snow',
    options: ResolvedPrecipitationOptions,
  ): PrecipitationEffectState {
    const stage = this.ensurePrecipitationStage();
    stage.uniforms.uSnow = kind === 'snow' ? 1 : 0;
    stage.uniforms.uDensity = options.density * PRECIPITATION_INTENSITY_DENSITY[options.intensity];
    stage.uniforms.uSpeed = options.speed;
    stage.uniforms.uWindWeight = options.windStrength;
    const radians = (options.windDirection * Math.PI) / 180;
    const windSpeed = options.windStrength * 20 * options.speed;
    stage.uniforms.uWindEnu = {
      x: Math.sin(radians) * windSpeed,
      y: Math.cos(radians) * windSpeed,
      z: 0,
    };
    stage.uniforms.uAspect = this.aspect();
    stage.uniforms.uStreakLength = options.streakLength;
    stage.uniforms.uFlakeSize = options.flakeSize;
    stage.uniforms.uBrightness = options.brightness;
    stage.uniforms.uTime = this.timeline.seconds;
    stage.uniforms.uOpacity = 1;
    stage.enabled = true;
    // 雨雪共用一个阶段，应用新的种类会替换另一个。
    this.states.delete(kind === 'rain' ? 'snow' : 'rain');
    const state: PrecipitationEffectState = { kind, enabled: true, options };
    this.states.set(kind, state);
    return state;
  }

  private ensureDepthFogStage(): StageLike {
    const existing = this.depthFogStage;
    if (existing) {
      return existing;
    }
    const stage = this.createStage({
      name: DEPTH_FOG_STAGE_NAME,
      fragmentShader: depthFogFragmentShader,
      textureScale: 1,
      uniforms: {
        uDensity: 0,
        uStart: 0,
        uEnd: 1,
        uColor: Color.WHITE,
        uHeightFalloff: 1,
        uCameraHeight: 0,
        uStrength: 0,
        uTopHeight: 1,
        uBrightness: 1,
      },
    });
    this.viewer.scene.postProcessStages.add(stage);
    this.depthFogStage = stage;
    return stage;
  }

  private ensurePrecipitationStage(): StageLike {
    const existing = this.precipitationStage;
    if (existing) {
      return existing;
    }
    const stage = this.createStage({
      name: PRECIPITATION_STAGE_NAME,
      fragmentShader: precipitationFragmentShader,
      textureScale: PRECIPITATION_TEXTURE_SCALE,
      sampleMode: PostProcessStageSampleMode.NEAREST,
      uniforms: {
        uTime: 0,
        uDensity: 0,
        uSpeed: 1,
        uSnow: 0,
        uOpacity: 0,
        uLayers: PRECIPITATION_LAYERS,
        uWindWeight: 0,
        uWindEnu: { x: 0, y: 0, z: 0 },
        uAspect: 1,
        uStreakLength: 0.5,
        uFlakeSize: 0.02,
        uBrightness: 1,
      },
    });
    this.viewer.scene.postProcessStages.add(stage);
    this.precipitationStage = stage;
    return stage;
  }

  private createStage(options: ConstructorParameters<typeof PostProcessStage>[0]): StageLike {
    return new PostProcessStage(options);
  }

  /** 移除阶段；集合未持有该阶段时自行销毁，避免泄漏。 */
  private removeStage(stage: StageLike): void {
    if (!this.viewer.scene.postProcessStages.remove(stage)) {
      stage.destroy();
    }
  }

  /** 每帧更新相机相关 uniform 与动画时间；雨雪启用时保证按需渲染模式仍在出帧。 */
  private tick(): void {
    if (this.disposed) {
      return;
    }
    const seconds = this.timeline.advance(this.now());
    const fog = this.depthFogStage;
    if (fog) {
      fog.uniforms.uCameraHeight = this.cameraHeight();
    }
    const precipitation = this.precipitationStage;
    if (precipitation) {
      precipitation.uniforms.uTime = seconds;
      precipitation.uniforms.uAspect = this.aspect();
      if (precipitation.enabled) {
        this.viewer.scene.requestRender();
      }
    }
  }

  /** 深度雾强度：启用且非二维时为 1。二维模式的深度编码不适用，直接停用。 */
  private writeDepthFogStrength(enabled: boolean): void {
    const stage = this.depthFogStage;
    if (!stage) {
      return;
    }
    const usable = enabled && this.viewer.scene.mode !== SceneMode.SCENE2D;
    stage.uniforms.uStrength = usable ? 1 : 0;
  }

  private depthFogDegraded(): { degraded?: string } {
    return this.viewer.scene.mode === SceneMode.SCENE2D
      ? { degraded: '二维模式不应用深度雾（深度编码不适用）' }
      : {};
  }

  private cameraHeight(): number {
    const height = this.viewer.scene.camera.positionCartographic.height;
    return Number.isFinite(height) ? height : 0;
  }

  private aspect(): number {
    const scene = this.viewer.scene;
    return scene.drawingBufferWidth / Math.max(1, scene.drawingBufferHeight);
  }

  private assertActive(operation: string): void {
    if (this.disposed) {
      throw new GisError('Environment controller has been destroyed.', {
        code: 'MAP_DISPOSED',
        module: 'environment',
        operation,
      });
    }
  }
}
