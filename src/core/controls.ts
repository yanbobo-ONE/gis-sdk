/** 经纬度位置，单位为度和米。 */
export interface GeoPosition {
  /** 经度，范围 -180 到 180。 */
  readonly longitude: number;
  /** 纬度，范围 -90 到 90。 */
  readonly latitude: number;
  /** 椭球高，单位为米，默认 0。 */
  readonly height?: number;
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

/** 地形控制器。 */
export interface TerrainController {
  /** 当前已安装地形的类型。 */
  readonly type: TerrainSpec['type'];
  /** 异步加载并在成功后切换地形。 */
  set(spec: TerrainSpec): Promise<void>;
}
