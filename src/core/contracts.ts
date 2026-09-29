import type { GisError } from './errors.js';
import type { EventHub } from './event-hub.js';
import type { LayerManager } from '../layers/contracts.js';
import type {
  BasemapController,
  CameraController,
  CaptureOptions,
  CoordinateTransform,
  FrameCapture,
  PickingController,
  SceneController,
  TerrainController,
} from './controls.js';
import type { QualityController } from './quality.js';

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
  /** 类型化相机控制器。 */
  readonly camera: CameraController;
  /** 当前地图拥有的单底图控制器。 */
  readonly basemap: BasemapController;
  /** 类型化地形控制器。 */
  readonly terrain: TerrainController;
  /** 类型化坐标转换。 */
  readonly coordinates: CoordinateTransform;
  /** 类型化渲染质量控制。 */
  readonly quality: QualityController;
  /** 类型化拾取控制器。 */
  readonly picking: PickingController;
  /** 类型化场景模式控制器。 */
  readonly scene: SceneController;
  /** 高级场景使用的引擎原生上下文。 */
  readonly raw: Readonly<TRaw>;
  /**
   * 通知底层引擎重新计算画布尺寸。
   *
   * @throws {@link GisError} 地图正在销毁或已经销毁时抛出 `MAP_DISPOSED`。
   */
  resize(): void;
  /**
   * 抓取当前画面。
   *
   * 内部会请求一次渲染并在渲染完成的同一帧拷贝绘图缓冲区，因此不需要开启
   * `preserveDrawingBuffer`；画面为空或超时（默认 400ms）时返回 `undefined`。
   */
  capture(options?: CaptureOptions): Promise<FrameCapture | undefined>;
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
  readonly camera: CameraController;
  readonly basemap: BasemapController;
  readonly terrain: TerrainController;
  readonly coordinates: CoordinateTransform;
  readonly quality: QualityController;
  readonly picking: PickingController;
  readonly scene: SceneController;
  /** 引擎内部异步失败的上报入口；`MapRuntime` 在构造时接入 `map:error`。 */
  setErrorReporter?(reporter: (error: GisError) => void): void;
  resize(): void;
  capture(options?: CaptureOptions): Promise<FrameCapture | undefined>;
  destroy(): void | Promise<void>;
}
