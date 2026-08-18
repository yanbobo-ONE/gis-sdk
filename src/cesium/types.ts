import type { Viewer } from 'cesium';

import type { GisMap } from '../core/contracts.js';

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
   */
  readonly cesiumBaseUrl?: string;
  /** 初始场景配置，默认 3D。 */
  readonly scene?: {
    /** 初始场景模式。 */
    readonly mode?: CesiumSceneMode;
  };
  /** Viewer 控件开关。 */
  readonly widgets?: CesiumWidgetOptions;
}

/** SDK 为高级需求保留的 Cesium 原生上下文。 */
export interface CesiumRawContext {
  /** Cesium 原生 Viewer。 */
  readonly viewer: Viewer;
}

/** 使用 Cesium 原生上下文的地图实例。 */
export type CesiumMap = GisMap<CesiumRawContext>;
