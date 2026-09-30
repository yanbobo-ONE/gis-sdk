import type { DrawMode } from './drawing.js';
import type { CameraViewSnapshot, MapSceneMode } from './controls.js';
import type { EnvironmentEffectState } from './environment.js';
import type { MapState } from './contracts.js';
import type { QualitySnapshot } from './quality.js';
import type { GeoBBox } from '../spatial/types.js';
import type { LayerInfo } from '../layers/contracts.js';

/**
 * 引擎侧诊断读数。
 *
 * 适配器只上报引擎独有的读数；跨引擎的部分（图层、质量、场景等）由 `MapRuntime` 汇总。
 */
export interface EngineDiagnostics {
  /** 相机位姿安全网累计恢复次数；引擎没有该保护时为 0。 */
  readonly cameraRecoveryCount: number;
}

/** 单个图层的诊断读数。 */
export interface LayerDiagnostics extends LayerInfo {
  /**
   * 累计观察到的远端失败次数。
   *
   * 与 `layer.errorCount` 一致：为 0 表示没有观察到远端失败；加载中的图层不计入。
   */
  readonly errorCount: number;
}

/** 相机诊断读数。 */
export interface CameraDiagnostics {
  /**
   * 当前相机位姿快照。
   *
   * 位姿不可读（例如相机落在地心）时为 `undefined`——诊断快照本身**不抛错**。
   */
  readonly view: CameraViewSnapshot | undefined;
  /** 当前视口经纬四至；相机看不到椭球或覆盖全球时为 `undefined`。 */
  readonly viewRectangle: GeoBBox | undefined;
  /** 相机位姿安全网累计把被写坏的位姿恢复了几次。 */
  readonly recoveryCount: number;
}

/** 底图诊断读数。 */
export interface BasemapDiagnostics {
  /** 当前底图类型。 */
  readonly type: string;
  /** 当前是否可见。 */
  readonly visible: boolean;
  /** 当前透明度。 */
  readonly opacity: number;
  /** 累计观察到的远端失败次数。 */
  readonly errorCount: number;
}

/** 地形诊断读数。 */
export interface TerrainDiagnostics {
  /** 当前已安装地形的类型。 */
  readonly type: string;
}

/** 场景诊断读数。 */
export interface SceneDiagnostics {
  /** 当前场景模式（形变过程中为目标模式）。 */
  readonly mode: MapSceneMode;
  /** 是否有形变在途。 */
  readonly morphing: boolean;
}

/** 绘制诊断读数。 */
export interface DrawingDiagnostics {
  /** 当前绘制模式；未在绘制时为 `undefined`。 */
  readonly mode: DrawMode | undefined;
  /** 已确定的顶点数。 */
  readonly vertexCount: number;
  /** 是否处于编辑会话中。 */
  readonly editing: boolean;
}

/**
 * 地图诊断快照。
 *
 * 只汇总 SDK 已经维护的读数：不新增采集、不做历史留存、不依赖引擎私有字段。
 * 生成快照**不会抛错**——读不到的字段用 `undefined` 表达，便于在故障现场安全调用。
 */
export interface MapDiagnosticsSnapshot {
  /** 地图实例 id。 */
  readonly id: string;
  /** 生命周期状态。 */
  readonly state: MapState;
  /** 相机读数。 */
  readonly camera: CameraDiagnostics;
  /** 渲染质量与帧采样读数。 */
  readonly quality: QualitySnapshot;
  /** 当前已加载图层。 */
  readonly layers: readonly LayerDiagnostics[];
  /** 底图读数。 */
  readonly basemap: BasemapDiagnostics;
  /** 地形读数。 */
  readonly terrain: TerrainDiagnostics;
  /** 场景模式读数。 */
  readonly scene: SceneDiagnostics;
  /** 当前生效的环境效果。 */
  readonly environment: readonly EnvironmentEffectState[];
  /** 绘制与编辑读数。 */
  readonly drawing: DrawingDiagnostics;
}

/**
 * 类型化诊断控制器。
 *
 * 面向"线上排查与验收自检"：一次调用拿到地图当前的关键读数，
 * 用于日志上报、面板展示或自动化断言。读数只反映调用时刻的状态。
 */
export interface DiagnosticsController {
  /** 采集一次诊断快照；永不抛错。 */
  snapshot(): MapDiagnosticsSnapshot;
}
