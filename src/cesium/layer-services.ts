import type { LoadLimiter } from './load-limiter.js';
import type { ModelAppearanceShaders } from './layers/model-appearance.js';

/**
 * 地图级服务，供图层工厂在创建单个图层时复用。
 *
 * 这些对象与地图实例同生命周期：模型并发上限由质量档驱动，外观策略缓存按地图隔离。
 *
 * @internal
 */
export interface CesiumLayerServices {
  /** 限制并发模型加载数量，避免一次添加大量模型时的请求风暴。 */
  readonly modelLoad: LoadLimiter;
  /** 模型外观策略到 `CustomShader` 的缓存。 */
  readonly modelAppearance: ModelAppearanceShaders;
}
