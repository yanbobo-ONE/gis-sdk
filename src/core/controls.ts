import type { Unsubscribe } from './event-hub.js';

/** 经纬度位置，单位为度和米。 */
export interface GeoPosition {
  /** 经度，范围 -180 到 180。 */
  readonly longitude: number;
  /** 纬度，范围 -90 到 90。 */
  readonly latitude: number;
  /** 椭球高，单位为米，默认 0。 */
  readonly height?: number;
}

/** 地心直角坐标（ECEF），单位为米。 */
export interface WorldCoordinates {
  /** X 轴分量，单位为米。 */
  readonly x: number;
  /** Y 轴分量，单位为米。 */
  readonly y: number;
  /** Z 轴分量，单位为米。 */
  readonly z: number;
}

/** 窗口像素坐标，原点位于画布左上角。 */
export interface WindowCoordinates {
  /** 横坐标，单位为像素。 */
  readonly x: number;
  /** 纵坐标，单位为像素。 */
  readonly y: number;
}

/**
 * 类型化坐标转换。
 *
 * 与朴素实现不同，这里用 `undefined` 表达"没有结果"：投影到屏幕外和屏幕拾取未命中地球
 * 都不会返回 `0, 0`，避免调用方把无效坐标当成有效像素使用。输入本身非法（非有限数或
 * 超出经纬度范围）会抛出 `INVALID_COORDINATES`。
 */
export interface CoordinateTransform {
  /** WGS84 经纬高转地心直角坐标。 */
  toWorld(position: GeoPosition): WorldCoordinates;
  /** 地心直角坐标转 WGS84 经纬高。 */
  toGeoPosition(world: WorldCoordinates): GeoPosition;
  /** 投影到窗口像素坐标；点在当前视锥外或被地球遮挡时返回 `undefined`。 */
  toWindow(position: GeoPosition): WindowCoordinates | undefined;
  /** 从窗口像素拾取地球表面的经纬高；射线未命中地球时返回 `undefined`。 */
  pickGeoPosition(point: WindowCoordinates): GeoPosition | undefined;
}

/** 相机视角。角度字段均以度为单位。 */
export interface CameraView extends GeoPosition {
  /** 朝向，0 度为正北，顺时针增加。 */
  readonly heading?: number;
  /** 俯仰角。 */
  readonly pitch?: number;
  /** 滚转角。 */
  readonly roll?: number;
}

/** 带飞行时长的相机视角。 */
export interface CameraFlight extends CameraView {
  /** 飞行时长，单位为秒；省略时由 Cesium 计算。 */
  readonly duration?: number;
}

/** SDK 支持的地图场景模式。 */
export type MapSceneMode = '2d' | '3d';

/** 类型化场景模式控制器。 */
export interface SceneController {
  /**
   * 当前场景模式。
   *
   * 形变过程中返回**目标模式**，而不是"正在形变"这一中间态。
   */
  readonly mode: MapSceneMode;
  /** 是否有形变在途。 */
  readonly morphing: boolean;
  /**
   * 切换 2D / 3D 场景。
   *
   * @param mode - 目标模式。
   * @param duration - 形变时长，单位为秒；省略时由 Cesium 决定（默认 2 秒）。
   * @returns 形变完成时结算；被新的切换取代时以 `SCENE_MORPH_SUPERSEDED` 拒绝。
   */
  setMode(mode: MapSceneMode, duration?: number): Promise<void>;
}

/** 画布快照；`canvas` 是设备像素分辨率的离屏副本，可直接导出或绘制。 */
export interface FrameCapture {
  /** 离屏画布副本。 */
  readonly canvas: HTMLCanvasElement;
  /** 画布像素宽度。 */
  readonly width: number;
  /** 画布像素高度。 */
  readonly height: number;
}

/** 画布快照的等待配置。 */
export interface CaptureOptions {
  /** 等待渲染的毫秒上限，默认 400。 */
  readonly timeoutMs?: number;
  /** 渲染尝试次数，默认 2；容器尺寸刚变化时首帧可能取不到像素。 */
  readonly attempts?: number;
}

/** 拾取事件的种类。 */
export type PickingEventKind = 'click' | 'hover';

/**
 * SDK 写入 Cesium 图元 `id` 字段的拾取标记。
 *
 * `id` 在 Cesium 里就是给拾取用的语义字段，因此 SDK 拥有单个可拾取对象的图层
 * （点位图层、静态模型）会写入该标记；拾取控制器据此还原图层与对象。
 */
export interface PickingMarker {
  /** 图层 id。 */
  readonly layerId: string;
  /** 图层内对象 id；只有一个对象的图层省略。 */
  readonly objectId?: string;
}

/** 一次拾取的命中信息。 */
export interface PickingHit {
  /** 命中对象所属的 SDK 图层 id；命中非 SDK 对象时为 `undefined`。 */
  readonly layerId: string | undefined;
  /** SDK 图层内的对象 id；没有或不是 SDK 对象时为 `undefined`。 */
  readonly objectId: string | undefined;
  /** 命中类别：SDK 图层、地球表面，或无法识别的原生对象。 */
  readonly kind: 'layer' | 'globe' | 'unknown';
}

/** 一次拾取事件。 */
export interface PickingEvent {
  /** 画布内的屏幕坐标，单位为像素。 */
  readonly screen: WindowCoordinates;
  /** 命中信息；什么也没命中时为 `undefined`。 */
  readonly hit: PickingHit | undefined;
  /** 屏幕位置对应的 WGS84 经纬高；未命中地球时为 `undefined`。 */
  readonly position: GeoPosition | undefined;
  /** 原生拾取结果，供识别 SDK 未标记的对象。 */
  readonly raw: unknown;
}

/** 类型化拾取控制器。 */
export interface PickingController {
  /** 是否启用拾取。 */
  readonly enabled: boolean;
  /** 最近一次拾取的命中信息；没有拾取过时为 `undefined`。 */
  readonly lastHit: PickingHit | undefined;
  /**
   * 订阅拾取事件，返回取消订阅函数。
   *
   * `hover` 事件按动画帧合并：一帧内多次移动只做一次场景拾取；相机移动或拖拽
   * 期间暂停悬停拾取，避免逐帧拾取拖慢渲染。
   */
  on(kind: PickingEventKind, listener: (event: PickingEvent) => void): Unsubscribe;
  /** 开关拾取；关闭后不再执行场景拾取，也不会触发事件。 */
  setEnabled(enabled: boolean): void;
}

/** 类型化相机控制器。 */
export interface CameraController {
  /** 立即设置相机视角。 */
  setView(view: CameraView): void;
  /** 平滑飞行到指定视角；飞行被取消时拒绝。 */
  flyTo(view: CameraFlight): Promise<void>;
  /** 取消 SDK 发起的当前飞行；没有进行中的飞行时无操作。 */
  cancelFlight(): void;
}

/** 当前支持的底图类型。 */
export type BasemapType = 'none' | 'xyz';

/** XYZ 瓦片底图配置。 */
export interface XyzBasemapSpec {
  /** 判别 XYZ 底图。 */
  readonly type: 'xyz';
  /** 必须包含 `{z}`、`{x}`、`{y}` 的瓦片地址模板。 */
  readonly url: string;
  /** 初始透明度，范围 0 到 1，默认 1。 */
  readonly opacity?: number;
  /** 初始可见性，默认 true。 */
  readonly visible?: boolean;
}

/** 单底图控制器。底图始终位于业务影像图层下方。 */
export interface BasemapController {
  /** 当前底图类型；未设置时为 `none`。 */
  readonly type: BasemapType;
  /** 当前底图可见性；没有底图时为 false。 */
  readonly visible: boolean;
  /** 当前底图透明度；没有底图时为 1。 */
  readonly opacity: number;
  /**
   * 底图瓦片请求失败的累计次数。
   *
   * 用于区分"没有配置底图"和"配置了但服务不可用"：瓦片错误不会刷屏事件，只累计计数，
   * 并在首次失败时通过 `map:error` 上报一次。
   */
  readonly errorCount: number;
  /** 设置或原子替换 XYZ 底图。 */
  set(spec: XyzBasemapSpec): void;
  /** 移除 SDK 拥有的当前底图。 */
  clear(): void;
  /** 设置当前底图可见性。 */
  setVisible(visible: boolean): void;
  /** 设置当前底图透明度。 */
  setOpacity(opacity: number): void;
}

/** 椭球地形配置。 */
export interface EllipsoidTerrainSpec {
  /** 使用无网络请求的椭球地形。 */
  readonly type: 'ellipsoid';
}

/** Cesium quantized-mesh 地形配置。 */
export interface CesiumTerrainSpec {
  /** 使用 Cesium Terrain 服务。 */
  readonly type: 'cesium-terrain';
  /** Terrain 服务根地址。 */
  readonly url: string;
  /** 请求服务端可用的顶点法线。 */
  readonly requestVertexNormals?: boolean;
  /** 请求服务端可用的水面遮罩。 */
  readonly requestWaterMask?: boolean;
}

/** 当前支持的地形配置。 */
export type TerrainSpec = EllipsoidTerrainSpec | CesiumTerrainSpec;

/** 地形采样输入点，只接受 WGS84 经纬度。 */
export interface TerrainSamplePoint {
  /** 经度，范围 -180 到 180。 */
  readonly longitude: number;
  /** 纬度，范围 -90 到 90。 */
  readonly latitude: number;
}

/** 单点地形采样结果。 */
export interface TerrainSample extends TerrainSamplePoint {
  /** 椭球高，单位为米；该点没有可用地形数据时为 `undefined`，不会伪造成 0。 */
  readonly height: number | undefined;
  /** `ok` 表示取到地形高度；`no-data` 表示该点没有可用数据。 */
  readonly status: 'ok' | 'no-data';
}

/** 地形采样配置。 */
export interface TerrainSampleOptions {
  /**
   * 采样策略，默认 `most-detailed`。
   *
   * 当前地形服务不提供可用层级时自动退化为 `level`。
   */
  readonly strategy?: 'most-detailed' | 'level';
  /** `level` 策略使用的层级，默认 0。 */
  readonly level?: number;
  /** 取消尚未完成的采样；已发出的批次无法撤回，但结果不会再返回。 */
  readonly signal?: AbortSignal;
}

/** 地形控制器。 */
export interface TerrainController {
  /** 当前已安装地形的类型。 */
  readonly type: TerrainSpec['type'];
  /** 异步加载并在成功后切换地形。 */
  set(spec: TerrainSpec, options?: TerrainSetOptions): Promise<void>;
  /**
   * 批量采样地形高度，结果顺序与输入一致。
   *
   * 相同位置、策略和层级会命中缓存，因此重复采样近似同一位置的代价很低。
   */
  sample(
    points: readonly TerrainSamplePoint[],
    options?: TerrainSampleOptions,
  ): Promise<readonly TerrainSample[]>;
}

/** 地形切换的超时配置。 */
export interface TerrainSetOptions {
  /**
   * 地形元数据请求的超时时间，单位为毫秒，默认 30000。
   *
   * 设为 0 表示不限制，完全沿用 Cesium 的请求行为。超时后当前地形保持不变，
   * 并抛出可重试的 `TERRAIN_LOAD_FAILED`，因此不会出现永久 `TERRAIN_BUSY` 的状态。
   */
  readonly timeoutMs?: number;
}
