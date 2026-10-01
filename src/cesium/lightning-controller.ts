import { Cartesian3, Color, Material, PolylineCollection, PostProcessStage } from 'cesium';
import type { Polyline } from 'cesium';

import type {
  LightningStrikeOptions,
  LightningStyleOptions,
  MapLightningController,
} from '../core/controls.js';
import { GisError } from '../core/errors.js';
import {
  generateLightningBolt,
  LightningFlashChannel,
  lightningEnvelope,
} from '../core/lightning.js';
import type { LightningPath } from '../core/lightning.js';

/** 闪击默认时长，单位为毫秒。 */
const DEFAULT_DURATION_MS = 900;

/** 主峰之后的默认脉冲次数。 */
const DEFAULT_PULSES = 2;

/** 同时保留的闪击上限。 */
const DEFAULT_MAX_ACTIVE = 8;

/** 低于该亮度不显示折线，省掉一次几乎不可见的绘制。 */
const VISIBLE_LEVEL = 0.02;

/** 屏幕闪光上限：附加反馈，不是主光效。 */
const SCREEN_FLASH_WEIGHT = 0.28;

const SCREEN_FLASH_SHADER = `
uniform sampler2D colorTexture;
uniform float uFlash;

in vec2 v_textureCoordinates;

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  color.rgb = mix(color.rgb, vec3(1.0), clamp(uFlash, 0.0, 1.0) * ${String(SCREEN_FLASH_WEIGHT)});
  out_FragColor = color;
}
`;

/** 后处理阶段的最小形状；引擎不提供时整个屏幕闪光降级为关闭。 */
interface StageLike {
  enabled: boolean;
  readonly uniforms: Record<string, unknown>;
}

/** 可注入的时钟来源；测试用假时钟推进闪击。 */
export type LightningNow = () => number;

/** 闪电渲染需要的 Viewer 部分；测试用假实现即可。 */
export interface LightningViewer {
  readonly scene: {
    readonly primitives: {
      add(collection: PolylineCollection): PolylineCollection;
      remove(collection: PolylineCollection): boolean;
    };
    readonly postProcessStages: { add(stage: unknown): unknown };
    readonly preRender: { addEventListener(listener: () => void): () => void };
  };
}

interface ActiveStrike {
  readonly id: string;
  readonly polylines: readonly Polyline[];
  /**
   * 每次闪击共用一份材质：`PolylineCollection` 按材质分组命令，共享材质既少一次 draw，
   * 也让所有分支走同一条亮度曲线；逐帧只改 `uniforms`。
   */
  readonly material: Material;
  readonly uniforms: { glowPower?: number; color?: Color };
  readonly durationMs: number;
  readonly pulses: number;
  readonly intensity: number;
  elapsedMs: number;
}

function invalidLightning(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'lightning',
    operation,
  });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 经纬高序列摊平成 `fromDegreesArrayHeights` 需要的三元组数组。 */
function flattenPath(path: LightningPath): number[] {
  const values: number[] = [];
  for (const point of path.points) {
    values.push(point.longitude, point.latitude, point.height ?? 0);
  }
  return values;
}

/**
 * Cesium 侧空间闪电控制器。
 *
 * 用公开 API 渲染：主干与分支各是一条 `Polyline`（`PolylineCollection` 承载），每次闪击共用一份
 * `Material.fromType('PolylineGlow')`——`PolylineCollection` 直接读 `material.shaderSource`，只接受
 * 真正的 `Material`（传 `MaterialProperty` 会在渲染循环里抛错并停渲染），因此这里逐帧改写
 * `material.uniforms` 的 `glowPower` 与颜色 alpha。屏幕闪光是一个 `PostProcessStage`，uniform 由
 * 亮度通道写入。几何在触发时生成一次，之后只改材质参数，因此每帧成本与顶点数无关。
 *
 * @internal
 */
export class CesiumLightningController implements MapLightningController {
  private readonly collection: PolylineCollection;
  private readonly stage: StageLike | undefined;
  private readonly strikes = new Map<string, ActiveStrike>();
  private readonly channel = new LightningFlashChannel();
  private readonly removeFrameListener: (() => void) | undefined;
  private currentStyle = { coreColor: '#eaf6ff', thickness: 3, screenFlash: true };
  private lastTick: number;
  private counter = 0;
  private disposed = false;

  constructor(
    private readonly viewer: LightningViewer,
    private readonly now: LightningNow = () => Date.now(),
  ) {
    this.collection = new PolylineCollection();
    this.viewer.scene.primitives.add(this.collection);
    this.stage = this.createStage();
    this.lastTick = this.now();
    const remove = this.viewer.scene.preRender.addEventListener(() => {
      this.advance();
    });
    if (typeof remove === 'function') {
      this.removeFrameListener = remove;
    }
  }

  get activeCount(): number {
    return this.strikes.size;
  }

  get flashLevel(): number {
    return this.channel.read();
  }

  get maxActive(): number {
    return DEFAULT_MAX_ACTIVE;
  }

  strike(options: LightningStrikeOptions): string {
    this.assertActive('strike');
    const requested = (options as Partial<LightningStrikeOptions> | undefined) ?? {};
    const id =
      typeof requested.id === 'string' && requested.id.trim() !== ''
        ? requested.id.trim()
        : `lightning-${String(++this.counter)}`;
    const durationMs = requested.durationMs ?? DEFAULT_DURATION_MS;
    if (!finiteNumber(durationMs) || durationMs <= 0) {
      throw invalidLightning('Lightning durationMs must be a positive finite number.', 'strike');
    }
    const pulses = requested.pulses ?? DEFAULT_PULSES;
    if (!finiteNumber(pulses) || pulses < 0 || pulses > 3) {
      throw invalidLightning('Lightning pulses must be between 0 and 3.', 'strike');
    }
    const intensity = requested.intensity ?? 1;
    if (!finiteNumber(intensity) || intensity < 0 || intensity > 1) {
      throw invalidLightning('Lightning intensity must be between 0 and 1.', 'strike');
    }

    // 形状生成先做：参数非法时直接抛错，不会留下半建的闪击。
    const shape = generateLightningBolt(requested as LightningStrikeOptions);

    this.cancel(id);
    while (this.strikes.size >= DEFAULT_MAX_ACTIVE) {
      const oldest = this.strikes.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.disposeStrike(oldest);
    }

    // PolylineCollection 只接受真正的 Material（它直接读 material.shaderSource），
    // 不接受 MaterialProperty；因此这里建一份可逐帧改 uniform 的内置辉光材质。
    const coreColor = Color.fromCssColorString(this.currentStyle.coreColor);
    coreColor.alpha = 0;
    const material = Material.fromType('PolylineGlow', {
      color: coreColor,
      glowPower: 0,
      taperPower: 0.6,
    });
    const uniforms = material.uniforms as { glowPower?: number; color?: Color };
    const polylines: Polyline[] = [];
    for (const path of shape.paths) {
      polylines.push(
        this.collection.add({
          positions: Cartesian3.fromDegreesArrayHeights(flattenPath(path)),
          width: this.currentStyle.thickness,
          material,
          show: false,
        }),
      );
    }

    this.strikes.set(id, {
      id,
      polylines,
      material,
      uniforms,
      durationMs,
      pulses,
      intensity,
      elapsedMs: 0,
    });
    return id;
  }

  cancel(id: string): boolean {
    const strike = this.strikes.get(id);
    if (!strike) {
      return false;
    }
    this.disposeStrike(id);
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.strikes.keys()]) {
      this.disposeStrike(id);
    }
    this.channel.reset();
    this.applyFlashLevel();
  }

  setStyle(options: LightningStyleOptions): void {
    this.assertActive('setStyle');
    if (options.coreColor !== undefined) {
      if (typeof options.coreColor !== 'string' || options.coreColor.trim() === '') {
        throw invalidLightning(
          'Lightning coreColor must be a non-empty CSS color string.',
          'setStyle',
        );
      }
      this.currentStyle = { ...this.currentStyle, coreColor: options.coreColor.trim() };
    }
    if (options.thickness !== undefined) {
      if (!finiteNumber(options.thickness) || options.thickness <= 0) {
        throw invalidLightning('Lightning thickness must be a positive finite number.', 'setStyle');
      }
      this.currentStyle = { ...this.currentStyle, thickness: options.thickness };
    }
    if (options.screenFlash !== undefined) {
      this.currentStyle = { ...this.currentStyle, screenFlash: options.screenFlash };
    }

    for (const strike of this.strikes.values()) {
      for (const polyline of strike.polylines) {
        polyline.width = this.currentStyle.thickness;
      }
      const color = strike.uniforms.color;
      if (color) {
        const next = Color.fromCssColorString(this.currentStyle.coreColor);
        color.red = next.red;
        color.green = next.green;
        color.blue = next.blue;
      }
    }
    this.applyFlashLevel();
  }

  /** 逐帧推进：更新每道闪击的包络与辉光，结束的闪击在此释放几何。 */
  advance(): void {
    if (this.disposed) {
      return;
    }
    const tick = this.now();
    const deltaMs = Math.max(0, tick - this.lastTick);
    this.lastTick = tick;
    this.channel.advance(deltaMs / 1000);

    let peak = 0;
    for (const id of [...this.strikes.keys()]) {
      const strike = this.strikes.get(id);
      if (!strike) {
        continue;
      }
      strike.elapsedMs += deltaMs;
      if (strike.elapsedMs >= strike.durationMs) {
        this.disposeStrike(id);
        continue;
      }
      const level =
        lightningEnvelope(strike.elapsedMs / strike.durationMs, strike.pulses) * strike.intensity;
      peak = Math.max(peak, level);
      strike.uniforms.glowPower = Math.min(1, level * 1.2);
      const color = strike.uniforms.color;
      if (color) {
        color.alpha = level;
      }
      for (const polyline of strike.polylines) {
        polyline.show = level > VISIBLE_LEVEL;
      }
    }

    if (peak > 0) {
      this.channel.publish(peak);
    }
    this.applyFlashLevel();
  }

  destroy(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeFrameListener?.();
    this.cancelAll();
    this.viewer.scene.primitives.remove(this.collection);
    if (this.stage) {
      this.stage.enabled = false;
    }
  }

  /** 把亮度通道写进屏幕闪光 uniform；关闭闪光或亮度可忽略时不启用阶段。 */
  private applyFlashLevel(): void {
    if (!this.stage) {
      return;
    }
    const level = this.channel.read();
    this.stage.uniforms.uFlash = level * SCREEN_FLASH_WEIGHT;
    this.stage.enabled = this.currentStyle.screenFlash && level > 0.001;
  }

  private disposeStrike(id: string): void {
    const strike = this.strikes.get(id);
    if (!strike) {
      return;
    }
    this.strikes.delete(id);
    for (const polyline of strike.polylines) {
      this.collection.remove(polyline);
    }
  }

  private createStage(): StageLike | undefined {
    try {
      const stage = new PostProcessStage({
        fragmentShader: SCREEN_FLASH_SHADER,
        uniforms: { uFlash: 0 },
      });
      this.viewer.scene.postProcessStages.add(stage);
      return stage;
    } catch {
      // 引擎不提供后处理（或上下文不可用）时只丢屏幕闪光，闪击本体照常渲染。
      return undefined;
    }
  }

  private assertActive(operation: string): void {
    if (this.disposed) {
      throw new GisError('Lightning controller has been disposed.', {
        code: 'MAP_DISPOSED',
        module: 'lightning',
        operation,
      });
    }
  }
}
