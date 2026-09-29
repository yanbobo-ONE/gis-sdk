import type { GeoJSON } from 'geojson';

import type { EventHub } from '../core/event-hub.js';
import type { GisError } from '../core/errors.js';

/** 当前稳定支持的图层类型。 */
export type LayerType = 'geojson' | 'wms' | 'tms' | 'wmts' | 'single-image' | 'model' | '3d-tiles';

/** 图层句柄的生命周期状态。 */
export type LayerState = 'loading' | 'ready' | 'hidden' | 'disposing' | 'disposed' | 'error';

/** 可取消异步操作的通用配置。 */
export interface OperationOptions {
  /** 取消尚未完成的加载或数据替换。 */
  readonly signal?: AbortSignal;
}

interface BaseLayerSpec {
  /** 地图实例内唯一的非空图层 id。 */
  readonly id: string;
  /** 初始是否可见，默认 `true`。 */
  readonly visible?: boolean;
}

/** GeoJSON 点标记样式。 */
export interface GeoJsonMarkerStyle {
  /** CSS 颜色字符串。 */
  readonly color?: string;
  /** 标记直径，单位为像素。 */
  readonly size?: number;
  /** Maki 图标名称。 */
  readonly symbol?: string;
}

/** SDK 稳定表达的 GeoJSON 默认样式。 */
export interface GeoJsonStyle {
  /** 点标记样式。 */
  readonly marker?: GeoJsonMarkerStyle;
  /** 线或面轮廓的 CSS 颜色。 */
  readonly stroke?: string;
  /** 线或面轮廓宽度，单位为像素。 */
  readonly strokeWidth?: number;
  /** 面填充的 CSS 颜色。 */
  readonly fill?: string;
  /** 是否贴地。 */
  readonly clampToGround?: boolean;
}

/** GeoJSON 对象或可请求的 URL。 */
export type GeoJsonSource = GeoJSON | string;

/** GeoJSON 要素图层配置。 */
export interface GeoJsonLayerSpec extends BaseLayerSpec {
  /** 判别 GeoJSON 图层。 */
  readonly type: 'geojson';
  /** 初始 GeoJSON 对象或同源/CORS 可访问的 URL。 */
  readonly data: GeoJsonSource;
  /** 加载时应用到未自带样式要素的默认样式。 */
  readonly style?: GeoJsonStyle;
}

/** WMS 自定义请求参数允许的稳定标量。 */
export type WmsParameterValue = string | number | boolean;

/** WMS 比较过滤器支持的操作符。 */
export type WmsComparisonOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'like';

/** 类型化 WMS CQL 过滤表达式。 */
export type WmsFilter =
  | {
      /** 比较操作。 */
      readonly op: WmsComparisonOperator;
      /** 只允许字母、数字、下划线和点的服务端属性名。 */
      readonly property: string;
      /** 会被安全序列化的比较值。 */
      readonly value: WmsParameterValue;
    }
  | {
      /** 判断属性为空。 */
      readonly op: 'is-null';
      /** 服务端属性名。 */
      readonly property: string;
    }
  | {
      /** 对子表达式取反。 */
      readonly op: 'not';
      /** 被取反的子表达式。 */
      readonly filter: WmsFilter;
    }
  | {
      /** 使用 AND 或 OR 组合至少两个子表达式。 */
      readonly op: 'and' | 'or';
      /** 待组合的子表达式。 */
      readonly filters: readonly WmsFilter[];
    };

/** GeoServer 等标准 WMS 影像图层配置。 */
export interface WmsLayerSpec extends BaseLayerSpec {
  /** 判别 WMS 图层。 */
  readonly type: 'wms';
  /** WMS GetMap 服务地址。 */
  readonly url: string;
  /** 一个图层名、逗号分隔字符串或图层名数组。 */
  readonly layers: string | readonly string[];
  /** 初始透明度，取值范围为 0 到 1，默认 1。 */
  readonly opacity?: number;
  /** GeoServer/WMS 样式名。 */
  readonly style?: string;
  /** 通过类型化构造器创建的 CQL 过滤条件。 */
  readonly filter?: WmsFilter;
  /** 附加 GetMap 参数；不能包含 `layers`、`styles` 或 `cql_filter`。 */
  readonly parameters?: Readonly<Record<string, WmsParameterValue>>;
}

/** TMS 瓦片影像图层配置。 */
export interface TmsLayerSpec extends BaseLayerSpec {
  /** 判别 TMS 图层。 */
  readonly type: 'tms';
  /** TMS 瓦片目录或 `tilemapresource.xml` 所在地址。 */
  readonly url: string;
  /** 初始透明度，取值范围为 0 到 1，默认 1。 */
  readonly opacity?: number;
  /** 瓦片图片扩展名，默认由 Cesium 使用 `png`。 */
  readonly fileExtension?: string;
  /** 最小层级，默认 0。 */
  readonly minimumLevel?: number;
  /** 最大层级；省略表示不限制。 */
  readonly maximumLevel?: number;
  /** 瓦片像素宽度，默认 256。 */
  readonly tileWidth?: number;
  /** 瓦片像素高度，默认 256。 */
  readonly tileHeight?: number;
  /** 是否兼容旧版 gdal2tiles 的 X/Y 翻转。 */
  readonly flipXY?: boolean;
}

/** WMTS 瓦片影像图层配置。 */
export interface WmtsLayerSpec extends BaseLayerSpec {
  /** 判别 WMTS 图层。 */
  readonly type: 'wmts';
  /** WMTS GetTile 地址或 REST 模板。 */
  readonly url: string;
  /** 初始透明度，取值范围为 0 到 1，默认 1。 */
  readonly opacity?: number;
  /** WMTS 图层标识。 */
  readonly layer: string;
  /** WMTS 样式标识。 */
  readonly style: string;
  /** WMTS TileMatrixSet 标识。 */
  readonly tileMatrixSetID: string;
  /** 返回瓦片的 MIME 类型，默认由 Cesium 使用 `image/jpeg`。 */
  readonly format?: string;
  /** 是否启用 GetFeatureInfo 拾取，省略时由 Cesium 决定。 */
  readonly enablePickFeatures?: boolean;
  /** 最小层级，默认 0。 */
  readonly minimumLevel?: number;
  /** 最大层级；省略表示不限制。 */
  readonly maximumLevel?: number;
  /** 每个层级对应的 TileMatrix 标识。 */
  readonly tileMatrixLabels?: readonly string[];
  /** REST 模板中的子域名集合。 */
  readonly subdomains?: string | readonly string[];
}

/** 单图影像覆盖范围，使用 WGS84 经度/纬度度数。 */
export interface SingleImageRectangle {
  /** 西边界经度，范围 -180 到 180。 */
  readonly west: number;
  /** 南边界纬度，范围 -90 到 90。 */
  readonly south: number;
  /** 东边界经度，范围 -180 到 180，必须大于 west。 */
  readonly east: number;
  /** 北边界纬度，范围 -90 到 90，必须大于 south。 */
  readonly north: number;
}

/** 单张地理配准影像图层配置。 */
export interface SingleImageLayerSpec extends BaseLayerSpec {
  /** 判别单图影像图层。 */
  readonly type: 'single-image';
  /** 可被浏览器访问的单张影像 URL。 */
  readonly url: string;
  /** 初始透明度，取值范围为 0 到 1，默认 1。 */
  readonly opacity?: number;
  /** 图像实际覆盖范围；省略时覆盖整个地球。 */
  readonly rectangle?: SingleImageRectangle;
}

/** 静态模型的位置，使用 WGS84 经度/纬度度数与相对椭球高度（米）。 */
export interface ModelPosition {
  /** 经度，范围 -180 到 180。 */
  readonly longitude: number;
  /** 纬度，范围 -90 到 90。 */
  readonly latitude: number;
  /** 相对 WGS84 椭球的高度，单位米。 */
  readonly height?: number;
}

/** 静态模型的航向、俯仰与横滚，单位为度。 */
export interface ModelOrientation {
  /** 航向角，单位为度，默认 0。 */
  readonly heading?: number;
  /** 俯仰角，单位为度，默认 0。 */
  readonly pitch?: number;
  /** 横滚角，单位为度，默认 0。 */
  readonly roll?: number;
}

/** 不重新加载模型即可应用的位置、朝向与缩放。 */
export interface ModelTransform {
  /** 模型锚点位置。 */
  readonly position: ModelPosition;
  /** 航向、俯仰、横滚角，单位为度，均默认 0。 */
  readonly orientation?: ModelOrientation;
  /** 缩放比例，默认 1。 */
  readonly scale?: number;
}

/** 静态 glTF / GLB 模型图层配置。 */
export interface ModelLayerSpec extends BaseLayerSpec {
  /** 判别静态模型图层。 */
  readonly type: 'model';
  /** `.gltf` 或 `.glb` 文件的可访问 URL。 */
  readonly url: string;
  /** 模型锚点位置。 */
  readonly position: ModelPosition;
  /** 航向、俯仰、横滚角，单位为度，均默认 0。 */
  readonly orientation?: ModelOrientation;
  /** 初始缩放比例，默认 1。 */
  readonly scale?: number;
  /** 最小屏幕像素尺寸；省略时由 Cesium 按真实尺寸渲染。 */
  readonly minimumPixelSize?: number;
  /** `minimumPixelSize` 生效时允许的最大缩放比例。 */
  readonly maximumScale?: number;
  /** 是否允许 Cesium 拾取模型，默认 `true`。 */
  readonly allowPicking?: boolean;
  /** 叠加到模型材质上的 CSS 颜色；省略时保留模型原始外观。 */
  readonly color?: string;
}

/** Cesium 3D Tiles 图层配置。 */
export interface Tiles3dLayerSpec extends BaseLayerSpec {
  /** 判别 3D Tiles 图层。 */
  readonly type: '3d-tiles';
  /** `tileset.json` 或兼容 3D Tiles 服务地址。 */
  readonly url: string;
  /** 最大屏幕空间误差，单位为像素；较小值提高细节与资源消耗。 */
  readonly maximumScreenSpaceError?: number;
  /** 是否启用 Cesium 的层级跳跃加载优化。 */
  readonly skipLevelOfDetail?: boolean;
}

/** 图层配置的判别联合。 */
export type LayerSpec =
  | GeoJsonLayerSpec
  | WmsLayerSpec
  | TmsLayerSpec
  | WmtsLayerSpec
  | SingleImageLayerSpec
  | ModelLayerSpec
  | Tiles3dLayerSpec;

/** 图层自身可订阅的生命周期事件。 */
export interface LayerEventMap {
  /** 图层生命周期状态发生变化。 */
  'state:changed': {
    /** 发生变化的图层 id。 */
    readonly id: string;
    /** 变化前状态。 */
    readonly previous: LayerState;
    /** 变化后状态。 */
    readonly state: LayerState;
  };
  /**
   * 图层已加入场景后的异步请求失败，例如影像瓦片持续取不到数据。
   *
   * 瓦片级失败会按瓦片触发，因此同一图层只发出首个失败事件；累计次数见
   * {@link LayerHandle.errorCount}。加载阶段的失败（`add`、`setData`）仍然以 Promise
   * 拒绝的方式抛出，不通过该事件重复上报。
   */
  error: {
    /** 发生失败的图层 id。 */
    readonly id: string;
    /** 结构化的图层错误。 */
    readonly error: GisError;
  };
}

/** 所有图层都支持的最小句柄。 */
export interface LayerHandle {
  /** 地图实例内唯一的图层 id。 */
  readonly id: string;
  /** 图层类型。 */
  readonly type: LayerType;
  /** 当前生命周期状态。 */
  readonly state: LayerState;
  /** 当前是否可见。 */
  readonly visible: boolean;
  /** 图层生命周期事件。 */
  readonly events: EventHub<LayerEventMap>;
  /**
   * 加入场景后异步请求失败的累计次数。
   *
   * 用来判断"图层在但服务不可用"：为 0 表示没有观察到远端失败。
   */
  readonly errorCount: number;
  /** 切换图层显隐；不会重新创建底层 Cesium 对象。 */
  setVisible(visible: boolean): void;
  /** 幂等释放图层拥有的 Cesium 对象和异步任务。 */
  dispose(): Promise<void>;
}

/** 支持原子替换数据的 GeoJSON 图层句柄。 */
export interface GeoJsonLayerHandle extends LayerHandle {
  /** 判别 GeoJSON 句柄。 */
  readonly type: 'geojson';
  /** 原子替换数据；失败或取消时保留旧数据。 */
  setData(data: GeoJsonSource, options?: OperationOptions): Promise<void>;
}

/** 支持影像透明度、样式和服务端过滤的 WMS 图层句柄。 */
export interface WmsLayerHandle extends ImageryLayerHandle {
  /** 判别 WMS 句柄。 */
  readonly type: 'wms';
  /** 当前透明度。 */
  readonly opacity: number;
  /** 设置 0 到 1 之间的透明度。 */
  setOpacity(opacity: number): void;
  /** 替换类型化服务端过滤条件；省略时清除过滤。 */
  setFilter(filter?: WmsFilter): Promise<void>;
  /** 切换服务端样式；省略或空字符串时清除样式。 */
  setStyle(style?: string): Promise<void>;
  /** 使用当前样式和过滤条件重新创建 WMS Provider。 */
  reload(): Promise<void>;
}

/** 影像图层共享的透明度句柄能力。 */
export interface ImageryLayerHandle extends LayerHandle {
  /** 当前透明度。 */
  readonly opacity: number;
  /** 设置 0 到 1 之间的透明度。 */
  setOpacity(opacity: number): void;
}

/** 支持不重新加载模型即可更新位置、朝向、缩放与颜色的静态模型图层句柄。 */
export interface ModelLayerHandle extends LayerHandle {
  /** 判别静态模型句柄。 */
  readonly type: 'model';
  /** 就地更新锚点位置、朝向与缩放；不会重新请求模型资源。 */
  setTransform(transform: ModelTransform): void;
  /** 叠加 CSS 颜色；省略时恢复模型原始材质外观。 */
  setColor(color?: string): void;
}

/** 图层管理器返回的只读图层快照。 */
export interface LayerInfo {
  /** 图层 id。 */
  readonly id: string;
  /** 图层类型。 */
  readonly type: LayerType;
  /** 快照生成时的生命周期状态。 */
  readonly state: LayerState;
  /** 快照生成时是否可见。 */
  readonly visible: boolean;
}

/** 根据配置类型推导具备对应能力的句柄。 */
export type LayerHandleFor<TSpec extends LayerSpec> = TSpec extends GeoJsonLayerSpec
  ? GeoJsonLayerHandle
  : TSpec extends WmsLayerSpec
    ? WmsLayerHandle
    : TSpec extends TmsLayerSpec | WmtsLayerSpec | SingleImageLayerSpec
      ? ImageryLayerHandle
      : TSpec extends ModelLayerSpec
        ? ModelLayerHandle
        : TSpec extends Tiles3dLayerSpec
          ? LayerHandle
          : LayerHandle;

/** 地图实例拥有的图层管理接口。 */
export interface LayerManager {
  /** 添加图层，并根据判别字段返回具备对应能力的句柄。 */
  add<TSpec extends LayerSpec>(
    spec: TSpec,
    options?: OperationOptions,
  ): Promise<LayerHandleFor<TSpec>>;
  /** 按 id 获取已加载图层；加载中的图层不会提前暴露。 */
  get(id: string): LayerHandle | undefined;
  /** 返回当前已加载图层的只读快照。 */
  list(): readonly LayerInfo[];
  /** 取消加载中图层或释放已加载图层；不存在时返回 `false`。 */
  remove(id: string): Promise<boolean>;
  /** 取消全部加载并释放全部已加载图层。 */
  clear(): Promise<void>;
}
