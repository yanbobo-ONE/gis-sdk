import type { GisError } from './errors.js';
import type { EventHub } from './event-hub.js';
import type { LayerManager } from '../layers/contracts.js';

/** 地图实例的生命周期状态。 */
export type MapState = 'ready' | 'destroying' | 'destroyed';

/** 地图实例发出的标准事件。 */
export interface MapEventMap {
  /** 地图及底层引擎资源已完成销毁。 */
  'map:destroy': {
    /** 发出事件的地图实例 id。 */
    id: string;
  };
  /** 地图操作或事件监听器发生可观察错误。 */
  'map:error': {
    /** 发出事件的地图实例 id。 */
    id: string;
    /** 结构化 SDK 错误。 */
    error: GisError;
  };
}

/**
 * 框架无关的地图实例契约。
 *
 * @typeParam TRaw - 引擎适配器暴露的只读原生上下文。
 */
export interface GisMap<TRaw = unknown> {
  /** 实例唯一标识。 */
  readonly id: string;
  /** 当前生命周期状态。 */
  readonly state: MapState;
  /** 地图生命周期事件中心。 */
  readonly events: EventHub<MapEventMap>;
  /** 当前地图拥有的类型化图层管理器。 */
  readonly layers: LayerManager;
  /** 高级场景使用的引擎原生上下文。 */
  readonly raw: Readonly<TRaw>;
  /**
   * 通知底层引擎重新计算画布尺寸。
   *
   * @throws {@link GisError} 地图正在销毁或已经销毁时抛出 `MAP_DISPOSED`。
   */
  resize(): void;
  /**
   * 释放地图及底层引擎资源。
   *
   * 并发调用共享同一个 Promise；成功后重复调用不会再次释放资源。
   */
  destroy(): Promise<void>;
}

/** @internal */
export interface MapEngineAdapter<TRaw> {
  readonly raw: Readonly<TRaw>;
  readonly layers: LayerManager;
  resize(): void;
  destroy(): void | Promise<void>;
}
