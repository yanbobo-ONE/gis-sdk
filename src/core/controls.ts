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
