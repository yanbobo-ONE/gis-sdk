import type { Viewer } from 'cesium';

import type { GisMap } from '../core/contracts.js';
import type { TerrainSpec, XyzBasemapSpec } from '../core/controls.js';
import type { QualityProfileId, RenderQuality } from '../core/quality.js';

export type { XyzBasemapSpec } from '../core/controls.js';

/** Cesium 场景模式的稳定 SDK 表达。 */
export type CesiumSceneMode = '2d' | '3d';

/** 可按需开启的 Cesium Viewer 控件。所有控件默认关闭。 */
export interface CesiumWidgetOptions {
  /** 动画时间控制器，默认关闭。 */
  readonly animation?: boolean;
  /** 底图选择器，默认关闭。 */
  readonly baseLayerPicker?: boolean;
  /** 全屏按钮，默认关闭。 */
  readonly fullscreenButton?: boolean;
  /** 地名搜索控件，默认关闭。 */
  readonly geocoder?: boolean;
  /** 回到初始视角按钮，默认关闭。 */
  readonly homeButton?: boolean;
  /** 要素信息框，默认关闭。 */
  readonly infoBox?: boolean;
  /** 导航帮助按钮，默认关闭。 */
  readonly navigationHelpButton?: boolean;
  /** 2D/3D 场景切换器，默认关闭。 */
  readonly sceneModePicker?: boolean;
  /** 要素选择指示器，默认关闭。 */
  readonly selectionIndicator?: boolean;
  /** 时间轴，默认关闭。 */
  readonly timeline?: boolean;
}

/** 渲染质量配置。 */
export interface QualityOptions {
  /**
   * 初始质量档，默认 `'default'`。
   *
   * `default` 保持 Cesium 的默认渲染参数；`quality`、`balanced`、`low` 逐级降低分辨率
   * 与地形精度、并收紧模型并发，是 Plugin-web 生产验证过的三档。
   */
  readonly profile?: QualityProfileId;
  /**
   * 是否按帧率自动升降档，默认 `true`。
   *
   * 自动画质只会在质量档给定的参数基础上降低或回升，不会超过该档的分辨率与模型并发，
   * 也不会低于各参数的下界（分辨率 0.5、地形误差 12、模型并发 2）。
   */
  readonly adaptive?: boolean;
  /** 覆盖质量档中的分辨率缩放，范围 0.5 到 2。 */
  readonly resolutionScale?: number;
  /** 覆盖质量档中的地形最大屏幕空间误差，范围 1 到 64。 */
  readonly terrainSse?: number;
  /** 覆盖质量档中的模型并发上限，范围 1 到 32 的整数。 */
  readonly modelLoadConcurrency?: number;
}

/** 创建 Cesium 地图实例的配置。 */
export interface CreateMapOptions {
  /** Viewer 容器元素或元素 id。字符串会去除首尾空白。 */
  readonly container: string | HTMLElement;
  /** 实例 id；省略时使用 `crypto.randomUUID()`。 */
  readonly id?: string;
  /**
   * Cesium `Workers`、`Assets`、`ThirdParty` 和 `Widgets` 的公共根路径。
   *
   * 首个 Viewer 创建后全局锁定。后续实例可省略或传入相同值，不能改为其他路径。
   * 不要与宿主直接调用 `buildModuleUrl.setBaseUrl()` 的配置方式混用。
   */
  readonly cesiumBaseUrl?: string;
  /** 初始场景配置，默认 3D。 */
  readonly scene?: {
    /** 初始场景模式。 */
    readonly mode?: CesiumSceneMode;
  };
  /** 初始 XYZ 底图；省略时不加载在线影像。 */
  readonly basemap?: XyzBasemapSpec;
  /**
   * 初始地形；省略时保持 Cesium 的椭球地形，不发出任何地形请求。
   *
   * 语义与 `map.terrain.set()` 一致，只是把地形服务地址声明在创建处：
   * `{ type: 'ellipsoid' }` 同步生效且无网络请求；`{ type: 'cesium-terrain', url }`
   * 异步拉取元数据，失败时 `map.terrain.type` 保持 `'ellipsoid'`，并经
   * `map.terrain.ready` 拒绝与 `map:error` 上报，不会静默改用其他地形服务。
   *
   * 配置本身不合法（类型未知、`url` 为空、开关不是布尔）会在创建时同步抛
   * `INVALID_TERRAIN_CONFIG`，不会先建出地图再失败。
   */
  readonly terrain?: TerrainSpec;
  /** Viewer 控件开关。 */
  readonly widgets?: CesiumWidgetOptions;
  /** 渲染质量与模型并发策略；省略时使用 `default` 档并开启自动画质。 */
  readonly quality?: QualityOptions;
}

/** SDK 为高级需求保留的 Cesium 原生上下文。 */
export interface CesiumRawContext {
  /** Cesium 原生 Viewer。 */
  readonly viewer: Viewer;
}

/** 使用 Cesium 原生上下文的地图实例。 */
export type CesiumMap = GisMap<CesiumRawContext>;

/** 规范化后的质量配置。 @internal */
export interface NormalizedQualityOptions {
  /** 初始生效的质量参数。 */
  readonly quality: RenderQuality;
  /** 是否开启按帧率自动升降档。 */
  readonly qualityAdaptive: boolean;
}
