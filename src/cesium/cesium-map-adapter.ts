import { buildModuleUrl, SceneMode, Viewer } from 'cesium';

import type { MapEngineAdapter } from '../core/contracts.js';
import type {
  BasemapController,
  CameraController,
  CaptureOptions,
  CoordinateTransform,
  FrameCapture,
  MapDrawingController,
  PickingController,
  SceneController,
  TerrainController,
} from '../core/controls.js';
import { rethrowAfterCleanup } from '../core/dispose-resources.js';
import { GisError } from '../core/errors.js';
import type { QualityController } from '../core/quality.js';
import type { LayerManager } from '../layers/contracts.js';
import { LayerRuntime } from '../layers/layer-runtime.js';
import type { NormalizedCreateMapOptions } from './create-map.js';
import { createCesiumLayer } from './layers/create-cesium-layer.js';
import { CesiumBasemapController } from './basemap-controller.js';
import { CesiumCameraController } from './camera-controller.js';
import { guardCameraPose, guardDegenerateCameraRotation } from './camera-guards.js';
import type { CameraPoseGuard } from './camera-guards.js';
import { CesiumCoordinateTransform } from './coordinates.js';
import { captureViewerFrame } from './frame-capture.js';
import { CesiumDrawingController } from './drawing-controller.js';
import { CesiumSceneController } from './scene-controller.js';
import { ModelAppearanceShaders } from './layers/model-appearance.js';
import { LoadLimiter } from './load-limiter.js';
import { CesiumPickingController } from './picking-controller.js';
import { CesiumQualityController } from './quality-controller.js';
import { CesiumTerrainController } from './terrain-controller.js';
import { CesiumTerrainSampler } from './terrain-sampling.js';
import type { CesiumRawContext } from './types.js';

interface BuildModuleUrlWithBaseUrl {
  setBaseUrl(value: string): void;
  [key: symbol]: unknown;
}

const moduleUrl = buildModuleUrl as typeof buildModuleUrl & BuildModuleUrlWithBaseUrl;
const baseUrlStateKey = Symbol.for('@yanbobo/gis-sdk/cesium-base-url-state/v1');

interface BaseUrlState {
  phase: 'unlocked' | 'configuring' | 'locked';
  configuredBaseUrl: string | undefined;
  reservationToken: symbol | undefined;
}

interface BaseUrlReservation {
  readonly state: BaseUrlState;
  readonly token: symbol;
  readonly configuredBaseUrl: string | undefined;
  readonly previousBaseUrl: string | undefined;
  readonly didSetBaseUrl: boolean;
}

function getBaseUrlState(): BaseUrlState {
  const existingState = moduleUrl[baseUrlStateKey] as BaseUrlState | undefined;
  if (existingState) {
    return existingState;
  }

  const state: BaseUrlState = {
    phase: 'unlocked',
    configuredBaseUrl: undefined,
    reservationToken: undefined,
  };
  moduleUrl[baseUrlStateKey] = state;
  return state;
}

function baseUrlConflict(existingBaseUrl: string | undefined): GisError {
  const existingConfiguration = existingBaseUrl ? `"${existingBaseUrl}"` : 'automatic resolution';
  return new GisError(`Cesium base URL is already locked to ${existingConfiguration}.`, {
    code: 'CESIUM_BASE_URL_CONFLICT',
    module: 'cesium',
    operation: 'configureBaseUrl',
  });
}

function tryGetCesiumBaseUrl(): string | undefined {
  try {
    return buildModuleUrl('');
  } catch {
    return undefined;
  }
}

function reserveCesiumBaseUrl(cesiumBaseUrl: string | undefined): BaseUrlReservation | undefined {
  const state = getBaseUrlState();

  if (state.phase === 'configuring') {
    throw baseUrlConflict(state.configuredBaseUrl);
  }

  if (state.phase === 'locked') {
    if (cesiumBaseUrl && state.configuredBaseUrl !== cesiumBaseUrl) {
      throw baseUrlConflict(state.configuredBaseUrl);
    }
    return undefined;
  }

  const token = Symbol();
  const previousBaseUrl = cesiumBaseUrl
    ? (tryGetCesiumBaseUrl() ?? state.configuredBaseUrl)
    : state.configuredBaseUrl;
  const configuredBaseUrl = cesiumBaseUrl ?? state.configuredBaseUrl;
  if (cesiumBaseUrl) {
    moduleUrl.setBaseUrl(cesiumBaseUrl);
  }

  state.phase = 'configuring';
  state.configuredBaseUrl = configuredBaseUrl;
  state.reservationToken = token;
  return {
    state,
    token,
    configuredBaseUrl,
    previousBaseUrl,
    didSetBaseUrl: Boolean(cesiumBaseUrl),
  };
}

function commitCesiumBaseUrl(reservation: BaseUrlReservation | undefined): void {
  if (reservation && reservation.state.reservationToken === reservation.token) {
    reservation.state.phase = 'locked';
    reservation.state.reservationToken = undefined;
  }
}

function rollbackCesiumBaseUrl(reservation: BaseUrlReservation | undefined): void {
  if (!reservation || reservation.state.reservationToken !== reservation.token) {
    return;
  }

  let residualBaseUrl = reservation.configuredBaseUrl;
  try {
    if (reservation.didSetBaseUrl && reservation.previousBaseUrl) {
      moduleUrl.setBaseUrl(reservation.previousBaseUrl);
      residualBaseUrl = reservation.previousBaseUrl;
    }
  } finally {
    reservation.state.phase = 'unlocked';
    reservation.state.configuredBaseUrl = residualBaseUrl;
    reservation.state.reservationToken = undefined;
  }
}

export class CesiumMapAdapter implements MapEngineAdapter<CesiumRawContext> {
  readonly raw: Readonly<CesiumRawContext>;
  readonly layers: LayerManager;
  readonly camera: CameraController;
  readonly basemap: BasemapController;
  readonly terrain: TerrainController;
  readonly coordinates: CoordinateTransform;
  readonly quality: QualityController;
  readonly picking: PickingController;
  readonly scene: SceneController;
  readonly drawing: MapDrawingController;

  private readonly layerRuntime: LayerRuntime;
  private readonly cameraRuntime: CesiumCameraController;
  private readonly basemapRuntime: CesiumBasemapController;
  private readonly terrainRuntime: CesiumTerrainController;
  private readonly qualityRuntime: CesiumQualityController;
  private readonly pickingRuntime: CesiumPickingController;
  private readonly sceneRuntime: CesiumSceneController;
  private readonly drawingRuntime: CesiumDrawingController;
  private readonly cameraPoseGuard: CameraPoseGuard;

  constructor(options: NormalizedCreateMapOptions) {
    const reservation = reserveCesiumBaseUrl(options.cesiumBaseUrl);
    let viewer: Viewer | undefined;
    let cameraRuntime: CesiumCameraController | undefined;
    let basemapRuntime: CesiumBasemapController | undefined;
    let terrainRuntime: CesiumTerrainController | undefined;
    let qualityRuntime: CesiumQualityController | undefined;
    let pickingRuntime: CesiumPickingController | undefined;
    let sceneRuntime: CesiumSceneController | undefined;
    let drawingRuntime: CesiumDrawingController | undefined;
    let cameraPoseGuard: CameraPoseGuard | undefined;
    try {
      viewer = new Viewer(options.container, {
        ...options.widgets,
        baseLayer: false,
        sceneMode: options.scene.mode === '2d' ? SceneMode.SCENE2D : SceneMode.SCENE3D,
      });
      const viewerInstance = viewer;
      guardDegenerateCameraRotation(viewerInstance.camera);
      cameraPoseGuard = guardCameraPose(viewerInstance.camera, viewerInstance.scene);
      cameraRuntime = new CesiumCameraController(viewerInstance.camera);
      basemapRuntime = new CesiumBasemapController(viewerInstance);
      const modelLoad = new LoadLimiter(options.quality.modelLoadConcurrency);
      terrainRuntime = new CesiumTerrainController(
        viewerInstance,
        new CesiumTerrainSampler(viewerInstance, modelLoad),
      );
      const coordinates = new CesiumCoordinateTransform(viewerInstance);
      pickingRuntime = new CesiumPickingController(viewerInstance, coordinates);
      sceneRuntime = new CesiumSceneController(viewerInstance.scene);
      drawingRuntime = new CesiumDrawingController(viewerInstance, coordinates);
      qualityRuntime = new CesiumQualityController({
        viewer: viewerInstance,
        limiter: modelLoad,
        initial: options.quality,
        adaptive: options.qualityAdaptive,
      });
      // 外观策略缓存按地图隔离，同一地图内的多个模型共享同一策略实例。
      const layerServices = { modelLoad, modelAppearance: new ModelAppearanceShaders() };
      const layerRuntime = new LayerRuntime((spec, context) => {
        return createCesiumLayer(viewerInstance, spec, context, layerServices);
      });
      if (options.basemap) {
        basemapRuntime.set(options.basemap);
      }
      qualityRuntime.start();

      commitCesiumBaseUrl(reservation);
      this.raw = Object.freeze({ viewer: viewerInstance });
      this.cameraRuntime = cameraRuntime;
      this.cameraPoseGuard = cameraPoseGuard;
      this.basemapRuntime = basemapRuntime;
      this.terrainRuntime = terrainRuntime;
      this.qualityRuntime = qualityRuntime;
      this.pickingRuntime = pickingRuntime;
      this.sceneRuntime = sceneRuntime;
      this.drawingRuntime = drawingRuntime;
      this.camera = cameraRuntime;
      this.basemap = basemapRuntime;
      this.terrain = terrainRuntime;
      this.coordinates = coordinates;
      this.quality = qualityRuntime;
      this.picking = pickingRuntime;
      this.scene = sceneRuntime;
      this.drawing = drawingRuntime;
      this.layerRuntime = layerRuntime;
      this.layers = layerRuntime;
    } catch (error: unknown) {
      rethrowAfterCleanup(error, {
        cameraPoseGuard: () => cameraPoseGuard?.dispose(),
        camera: () => cameraRuntime?.destroy(),
        basemap: () => basemapRuntime?.destroy(),
        terrain: () => terrainRuntime?.destroy(),
        quality: () => qualityRuntime?.dispose(),
        picking: () => pickingRuntime?.dispose(),
        scene: () => sceneRuntime?.destroy(),
        drawing: () => drawingRuntime?.dispose(),
        viewer: () => viewer?.destroy(),
        // 回滚失败不覆盖原始错误；rollback 在 finally 中释放锁。
        baseUrl: () => {
          rollbackCesiumBaseUrl(reservation);
        },
      });
    }
  }

  setErrorReporter(reporter: (error: GisError) => void): void {
    this.basemapRuntime.setErrorReporter(reporter);
  }

  resize(): void {
    this.raw.viewer.resize();
  }

  capture(options: CaptureOptions = {}): Promise<FrameCapture | undefined> {
    return captureViewerFrame(this.raw.viewer, options);
  }

  async destroy(): Promise<void> {
    await this.layerRuntime.destroy();
    this.cameraPoseGuard.dispose();
    this.qualityRuntime.dispose();
    this.pickingRuntime.dispose();
    this.sceneRuntime.destroy();
    this.drawingRuntime.dispose();
    this.cameraRuntime.destroy();
    this.basemapRuntime.destroy();
    this.terrainRuntime.destroy();
    this.raw.viewer.destroy();
  }
}
