import type { LoadLimiter } from './load-limiter.js';
import type { HeatmapRasterizer } from './layers/heatmap-layer.js';
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
  /**
   * 热力图栅格化出口；省略时用默认的 canvas 实现。
   *
   * 测试注入假实现即可在无 DOM 环境验证热力图图层，不需要真的画布。
   */
  readonly heatmapRasterizer?: HeatmapRasterizer;
}
