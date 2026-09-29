import { GisError } from './errors.js';

/** 环境效果种类。 */
export type EnvironmentEffectKind = 'depthFog' | 'haze' | 'rain' | 'snow';

/** 降水强度档位；映射到密度倍率，是视觉标定结果而非气象量。 */
export type PrecipitationIntensity = 'light' | 'moderate' | 'heavy';

/** 深度雾参数：按距离与高度双重衰减，天空像素单独分支。 */
export interface DepthFogOptions {
  /** 密度倍率，0 到 1，默认 0.35。 */
  readonly density?: number;
  /** 起雾的相机距离（米），默认 1000。 */
  readonly startDistanceMeters?: number;
  /** 完全不透明距离（米），必须大于起雾距离，默认 120000。 */
  readonly endDistanceMeters?: number;
  /** 雾色，CSS 颜色字符串，默认 `#9fb6c8`。 */
  readonly color?: string;
  /** 高度衰减尺度（米）：每上升该米数密度显著下降，默认 4000。 */
  readonly heightFalloffMeters?: number;
  /** 雾柱顶高度（米）：相机高于该高度时天空不再被雾罩住，默认 3000。 */
  readonly topHeightMeters?: number;
  /** 画面亮度倍率，0.3 到 1.4，默认 1。 */
  readonly brightness?: number;
}

/**
 * 基础雾（官方 `scene.fog`）参数。
 *
 * 这里**只有显式声明的字段**会被写入场景，未声明的字段保持场景当前值；因此本类型没有默认值，
 * 也不可能"补齐"成完整对象。效果清除时会恢复成接管前的值（若期间没人再改过同一字段）。
 */
export interface HazeOptions {
  /** 雾密度，0 到 0.02。 */
  readonly density?: number;
  /** 高度衰减指数，0.1 到 3。 */
  readonly heightFalloff?: number;
  /** 生效的最大椭球高（米），0 表示不限制。 */
  readonly maxHeight?: number;
  /** 最低亮度，0 到 1。 */
  readonly brightnessFloor?: number;
  /** 全局屏幕空间误差系数，0 到 10。 */
  readonly screenSpaceErrorFactor?: number;
}

/** 降水（雨 / 雪）参数。 */
export interface PrecipitationOptions {
  /** 强度档位，默认 `moderate`。 */
  readonly intensity?: PrecipitationIntensity;
  /** 密度倍率，0.3 到 2.5，默认 1。 */
  readonly density?: number;
  /** 下落速度倍率，0.5 到 8，默认 1。 */
  readonly speed?: number;
  /** 风向方位角（度），0 为正北、90 为正东，默认 0。 */
  readonly windDirection?: number;
  /** 风强度，0 到 1，默认 0.25。 */
  readonly windStrength?: number;
  /** 雨丝长度，0.1 到 1；数值越大雨丝越短，默认 0.5。 */
  readonly streakLength?: number;
  /** 雪花大小，0.005 到 0.04，默认 0.02。 */
  readonly flakeSize?: number;
  /** 整体亮度，0.3 到 1.6，默认 1。 */
  readonly brightness?: number;
}

/** 每种环境效果的参数形状。 */
export interface EnvironmentOptionsMap {
  /** 深度雾参数。 */
  readonly depthFog: DepthFogOptions;
  /** 基础雾参数。 */
  readonly haze: HazeOptions;
  /** 雨参数。 */
  readonly rain: PrecipitationOptions;
  /** 雪参数。 */
  readonly snow: PrecipitationOptions;
}

/** SDK 支持的全部环境效果种类。 */
export const ENVIRONMENT_EFFECT_KINDS: readonly EnvironmentEffectKind[] = Object.freeze([
  'depthFog',
  'haze',
  'rain',
  'snow',
]);

/** 降水强度档位到密度倍率的映射；数值为视觉标定结果。 */
export const PRECIPITATION_INTENSITY_DENSITY: Readonly<Record<PrecipitationIntensity, number>> =
  Object.freeze({ light: 0.55, moderate: 1, heavy: 1.7 });

/** 深度雾默认参数，与着色器约定一致。 */
export const DEPTH_FOG_DEFAULTS: ResolvedDepthFogOptions = Object.freeze({
  density: 0.35,
  startDistanceMeters: 1_000,
  endDistanceMeters: 120_000,
  color: '#9fb6c8',
  heightFalloffMeters: 4_000,
  topHeightMeters: 3_000,
  brightness: 1,
});

/** 降水默认参数。 */
export const PRECIPITATION_DEFAULTS: ResolvedPrecipitationOptions = Object.freeze({
  intensity: 'moderate' satisfies PrecipitationIntensity,
  density: 1,
  speed: 1,
  windDirection: 0,
  windStrength: 0.25,
  streakLength: 0.5,
  flakeSize: 0.02,
  brightness: 1,
});

/** 已补齐默认值的深度雾参数。 */
export type ResolvedDepthFogOptions = Required<DepthFogOptions>;

/** 已补齐默认值的降水参数。 */
export type ResolvedPrecipitationOptions = Required<PrecipitationOptions>;

/** 深度雾效果状态。 */
export interface DepthFogEffectState {
  /** 效果种类。 */
  readonly kind: 'depthFog';
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 生效参数（默认值已补齐）。 */
  readonly options: ResolvedDepthFogOptions;
  /** 降级说明；例如二维模式不应用深度雾。 */
  readonly degraded?: string;
}

/** 基础雾效果状态。 */
export interface HazeEffectState {
  /** 效果种类。 */
  readonly kind: 'haze';
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 本次声明的字段；未声明项保持场景当前值。 */
  readonly options: HazeOptions;
  /** 降级说明。 */
  readonly degraded?: string;
}

/** 降水效果状态。 */
export interface PrecipitationEffectState {
  /** 效果种类。 */
  readonly kind: 'rain' | 'snow';
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 生效参数（默认值已补齐）。 */
  readonly options: ResolvedPrecipitationOptions;
  /** 降级说明；例如低质量档位减少了层数。 */
  readonly degraded?: string;
}

/** 效果种类到状态类型的映射。 */
export interface EnvironmentEffectStateMap {
  /** 深度雾状态。 */
  readonly depthFog: DepthFogEffectState;
  /** 基础雾状态。 */
  readonly haze: HazeEffectState;
  /** 雨状态。 */
  readonly rain: PrecipitationEffectState;
  /** 雪状态。 */
  readonly snow: PrecipitationEffectState;
}

/** 任一环境效果状态。 */
export type EnvironmentEffectState =
  | DepthFogEffectState
  | HazeEffectState
  | PrecipitationEffectState;

/**
 * 类型化环境效果控制器。
 *
 * 效果分两类：后处理型（深度雾、雨、雪）由 SDK 创建并释放自己的渲染阶段；场景字段型
 * （基础雾）接管官方 Fog 的字段，清除时恢复接管前的值。
 *
 * 雨与雪共用一个后处理阶段（着色器内按权重切换），因此两者互斥：应用其中一个会替换另一个。
 */
export interface EnvironmentController {
  /** 当前生效（已应用且未清除）的效果状态；未应用的效果不在列表中。 */
  readonly active: readonly EnvironmentEffectState[];
  /**
   * 应用或更新一个环境效果。
   *
   * @param kind - 效果种类。
   * @param options - 效果参数；省略时使用默认值。
   * @returns 应用后的效果状态。
   * @throws `INVALID_ENVIRONMENT_CONFIG` 参数非法；`ENVIRONMENT_UNSUPPORTED` 当前终端不支持该效果。
   */
  set<K extends EnvironmentEffectKind>(
    kind: K,
    options?: EnvironmentOptionsMap[K],
  ): EnvironmentEffectStateMap[K];
  /**
   * 开关一个已应用的效果。
   *
   * @param kind - 效果种类。
   * @param enabled - 是否启用。
   * @returns 更新后的状态；效果未应用时返回 `undefined`。
   */
  setEnabled(kind: EnvironmentEffectKind, enabled: boolean): EnvironmentEffectState | undefined;
  /**
   * 清除一个效果并释放其资源；基础雾会恢复成接管前的字段值。
   *
   * @param kind - 效果种类；未应用时无操作。
   */
  clear(kind: EnvironmentEffectKind): void;
  /** 清除全部环境效果。 */
  clearAll(): void;
}

/**
 * 环境效果动画时间线。
 *
 * 只把"两次采样之间的真实间隔"累加成一个单调增大的秒数，按真实时间驱动（与地图时钟无关，
 * 暂停地图时钟不会让降水停住）。单步增量有上限：页面切回前台、断点调试造成的大跨度间隔不会
 * 让降水瞬移。时间倒退的采样被忽略。
 *
 * 采样源由调用方注入（浏览器传 `performance.now()`），因此本类不依赖任何终端 API。
 */
export class EnvironmentTimeline {
  /** 单次推进允许的最大增量，单位为秒。 */
  static readonly MAX_STEP_SECONDS = 0.1;

  private elapsed = 0;
  private last: number | undefined;

  /**
   * @param nowMs - 起始采样值，单位毫秒；省略时以第一次 `advance()` 为起点。
   */
  constructor(nowMs?: number) {
    if (nowMs !== undefined && Number.isFinite(nowMs)) {
      this.last = nowMs;
    }
  }

  /** 已累计的环境时间，单位为秒。 */
  get seconds(): number {
    return this.elapsed;
  }

  /**
   * 用一次新的采样推进时间。
   *
   * @param nowMs - 单调递增的采样值，单位毫秒。
   * @returns 推进后的累计秒数。
   */
  advance(nowMs: number): number {
    if (!Number.isFinite(nowMs)) {
      return this.elapsed;
    }
    const last = this.last;
    this.last = nowMs;
    if (last === undefined || nowMs <= last) {
      return this.elapsed;
    }
    const deltaSeconds = Math.min((nowMs - last) / 1000, EnvironmentTimeline.MAX_STEP_SECONDS);
    this.elapsed += deltaSeconds;
    return this.elapsed;
  }

  /**
   * 重置累计时间。
   *
   * @param nowMs - 新的起点采样值；省略时下次 `advance()` 会重新起算。
   */
  reset(nowMs?: number): void {
    this.elapsed = 0;
    this.last = nowMs !== undefined && Number.isFinite(nowMs) ? nowMs : undefined;
  }
}

function invalidEnvironment(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_ENVIRONMENT_CONFIG',
    module: 'environment',
    operation,
  });
}

/** 校验一个有限数值并按范围限制。 */
function finiteInRange(
  value: number | undefined,
  name: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const resolved = value ?? fallback;
  if (resolved === undefined || !Number.isFinite(resolved)) {
    throw invalidEnvironment(`Environment option ${name} must be a finite number.`, name);
  }
  if (resolved < min || resolved > max) {
    throw invalidEnvironment(
      `Environment option ${name} must be between ${String(min)} and ${String(max)}.`,
      name,
    );
  }
  return resolved;
}

/** 校验一个可选字段：声明了就必须是有限数且在范围内。 */
function optionalInRange(value: number | undefined, name: string, min: number, max: number): void {
  if (value === undefined) {
    return;
  }
  finiteInRange(value, name, min, max);
}

/**
 * 解析深度雾参数并补齐默认值。
 *
 * @param options - 调用方参数。
 * @returns 补齐默认值后的参数。
 * @throws `INVALID_ENVIRONMENT_CONFIG` 参数非法。
 */
export function resolveDepthFogOptions(options: DepthFogOptions = {}): ResolvedDepthFogOptions {
  const density = finiteInRange(options.density, 'depthFog.density', 0, 1, DEPTH_FOG_DEFAULTS.density);
  const startDistanceMeters = finiteInRange(
    options.startDistanceMeters,
    'depthFog.startDistanceMeters',
    0,
    Number.MAX_SAFE_INTEGER,
    DEPTH_FOG_DEFAULTS.startDistanceMeters,
  );
  const endDistanceMeters = finiteInRange(
    options.endDistanceMeters,
    'depthFog.endDistanceMeters',
    0,
    Number.MAX_SAFE_INTEGER,
    DEPTH_FOG_DEFAULTS.endDistanceMeters,
  );
  if (startDistanceMeters >= endDistanceMeters) {
    throw invalidEnvironment(
      'Environment option depthFog.startDistanceMeters must be smaller than endDistanceMeters.',
      'depthFog',
    );
  }
  const color = options.color ?? DEPTH_FOG_DEFAULTS.color;
  if (typeof color !== 'string' || color.trim().length === 0) {
    throw invalidEnvironment('Environment option depthFog.color must be a CSS color string.', 'depthFog');
  }
  return {
    density,
    startDistanceMeters,
    endDistanceMeters,
    color,
    heightFalloffMeters: finiteInRange(
      options.heightFalloffMeters,
      'depthFog.heightFalloffMeters',
      1,
      1e7,
      DEPTH_FOG_DEFAULTS.heightFalloffMeters,
    ),
    topHeightMeters: finiteInRange(
      options.topHeightMeters,
      'depthFog.topHeightMeters',
      1,
      1e7,
      DEPTH_FOG_DEFAULTS.topHeightMeters,
    ),
    brightness: finiteInRange(options.brightness, 'depthFog.brightness', 0.3, 1.4, DEPTH_FOG_DEFAULTS.brightness),
  };
}

/**
 * 校验基础雾参数。
 *
 * 不做默认值补齐：未声明的字段不会被写入场景。
 *
 * @param options - 调用方参数。
 * @returns 与输入等价的已校验参数。
 * @throws `INVALID_ENVIRONMENT_CONFIG` 参数非法。
 */
export function resolveHazeOptions(options: HazeOptions = {}): HazeOptions {
  optionalInRange(options.density, 'haze.density', 0, 0.02);
  optionalInRange(options.heightFalloff, 'haze.heightFalloff', 0.1, 3);
  optionalInRange(options.maxHeight, 'haze.maxHeight', 0, 1e7);
  optionalInRange(options.brightnessFloor, 'haze.brightnessFloor', 0, 1);
  optionalInRange(options.screenSpaceErrorFactor, 'haze.screenSpaceErrorFactor', 0, 10);
  return options;
}

/**
 * 解析降水参数并补齐默认值。
 *
 * @param options - 调用方参数。
 * @returns 补齐默认值后的参数。
 * @throws `INVALID_ENVIRONMENT_CONFIG` 参数非法。
 */
export function resolvePrecipitationOptions(
  options: PrecipitationOptions = {},
): ResolvedPrecipitationOptions {
  const declared: unknown = options.intensity ?? PRECIPITATION_DEFAULTS.intensity;
  if (declared !== 'light' && declared !== 'moderate' && declared !== 'heavy') {
    throw invalidEnvironment(
      "Environment option precipitation.intensity must be 'light', 'moderate' or 'heavy'.",
      'precipitation',
    );
  }
  const intensity: PrecipitationIntensity = declared;
  return {
    intensity,
    density: finiteInRange(options.density, 'precipitation.density', 0.3, 2.5, PRECIPITATION_DEFAULTS.density),
    speed: finiteInRange(options.speed, 'precipitation.speed', 0.5, 8, PRECIPITATION_DEFAULTS.speed),
    windDirection: finiteInRange(
      options.windDirection,
      'precipitation.windDirection',
      -360,
      360,
      PRECIPITATION_DEFAULTS.windDirection,
    ),
    windStrength: finiteInRange(
      options.windStrength,
      'precipitation.windStrength',
      0,
      1,
      PRECIPITATION_DEFAULTS.windStrength,
    ),
    streakLength: finiteInRange(
      options.streakLength,
      'precipitation.streakLength',
      0.1,
      1,
      PRECIPITATION_DEFAULTS.streakLength,
    ),
    flakeSize: finiteInRange(
      options.flakeSize,
      'precipitation.flakeSize',
      0.005,
      0.04,
      PRECIPITATION_DEFAULTS.flakeSize,
    ),
    brightness: finiteInRange(
      options.brightness,
      'precipitation.brightness',
      0.3,
      1.6,
      PRECIPITATION_DEFAULTS.brightness,
    ),
  };
}

/**
 * 按种类解析环境效果参数；非 Cesium 终端也可以用它做同样的输入校验。
 *
 * @param kind - 效果种类。
 * @param options - 调用方参数。
 * @returns 已补齐默认值（基础雾除外）的参数。
 * @throws `INVALID_ENVIRONMENT_CONFIG` 种类或参数非法。
 */
export function resolveEnvironmentOptions<K extends EnvironmentEffectKind>(
  kind: K,
  options?: EnvironmentOptionsMap[K],
): EnvironmentOptionsMap[K] {
  switch (kind) {
    case 'depthFog':
      return resolveDepthFogOptions(options);
    case 'haze':
      return resolveHazeOptions(options);
    case 'rain':
    case 'snow':
      return resolvePrecipitationOptions(options);
    default:
      throw invalidEnvironment(`Unsupported environment effect: ${String(kind)}.`, 'set');
  }
}
