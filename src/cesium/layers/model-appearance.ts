import { CustomShader, LightingModel, UniformType } from 'cesium';

import type { ModelAppearanceMode, ModelAppearanceOptions } from '../../layers/contracts.js';
import { GisError } from '../../core/errors.js';

/**
 * 提亮片段着色器：只放大漫反射。
 *
 * 不改变 alpha 与自发光，因此贴图与透明度保持模型自身表现。
 */
const BRIGHTNESS_FRAGMENT_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  material.diffuse *= uGain;
}
`;

/** 默认提亮倍率，取自 Plugin-web 的生产值。 */
const DEFAULT_GAIN = 1.3;
const MIN_GAIN = 0.2;
const MAX_GAIN = 4;

const MODES: readonly ModelAppearanceMode[] = ['original', 'brightness', 'unlit'];

function invalidAppearance(message: string, operation: string): GisError {
  return new GisError(message, { code: 'INVALID_LAYER_CONFIG', module: 'layer', operation });
}

/** 规范化外观策略：校验取值并补齐默认值。 @internal */
export function normalizeAppearance(
  options: ModelAppearanceOptions | undefined,
  operation: string,
): Required<ModelAppearanceOptions> {
  const mode = options?.mode ?? 'original';
  if (!MODES.includes(mode)) {
    throw invalidAppearance(
      `Model appearance mode "${mode}" is not supported; use original, brightness, or unlit.`,
      operation,
    );
  }
  const gain = options?.gain ?? DEFAULT_GAIN;
  if (!Number.isFinite(gain) || gain < MIN_GAIN || gain > MAX_GAIN) {
    throw invalidAppearance(
      `Model appearance gain must be a finite number between ${String(MIN_GAIN)} and ${String(MAX_GAIN)}.`,
      operation,
    );
  }
  return { mode, gain };
}

function createShader(mode: ModelAppearanceMode, gain: number): CustomShader | undefined {
  if (mode === 'original') {
    return undefined;
  }
  if (mode === 'unlit') {
    return new CustomShader({ lightingModel: LightingModel.UNLIT });
  }
  return new CustomShader({
    uniforms: { uGain: { type: UniformType.FLOAT, value: gain } },
    fragmentShaderText: BRIGHTNESS_FRAGMENT_SHADER,
  });
}

/**
 * 外观策略到 `CustomShader` 实例的缓存。
 *
 * `customShader` 是模型级属性，同一策略在同一地图内可以复用同一个实例；缓存按地图创建，
 * 不跨地图共享。
 *
 * @internal
 */
export class ModelAppearanceShaders {
  private readonly cache = new Map<string, CustomShader | undefined>();

  /** 已缓存的策略数。 */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 解析外观策略。
   *
   * `original` 返回 `undefined`，表示"不写该字段"，调用方据此还原模型原始外观。
   */
  resolve(
    options: ModelAppearanceOptions | undefined,
    operation: string,
  ): CustomShader | undefined {
    const { mode, gain } = normalizeAppearance(options, operation);
    const key = `${mode}:${mode === 'brightness' ? String(gain) : ''}`;
    if (!this.cache.has(key)) {
      this.cache.set(key, createShader(mode, gain));
    }
    return this.cache.get(key);
  }
}
