import type { GeoJSON } from 'geojson';

import type { EventHub } from '../core/event-hub.js';

/** 首期稳定支持的图层类型。 */
export type LayerType = 'geojson' | 'wms';

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

/** 首期图层配置的判别联合。 */
export type LayerSpec = GeoJsonLayerSpec | WmsLayerSpec;

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
export interface WmsLayerHandle extends LayerHandle {
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
