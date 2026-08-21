import { buildModuleUrl, SceneMode, Viewer } from 'cesium';

import type { MapEngineAdapter } from '../core/contracts.js';
import type { BasemapController, CameraController, TerrainController } from '../core/controls.js';
import { GisError } from '../core/errors.js';
import type { LayerManager } from '../layers/contracts.js';
import { LayerRuntime } from '../layers/layer-runtime.js';
import type { NormalizedCreateMapOptions } from './create-map.js';
import { createCesiumLayer } from './layers/create-cesium-layer.js';
import { CesiumBasemapController } from './basemap-controller.js';
import { CesiumCameraController } from './camera-controller.js';
import { CesiumTerrainController } from './terrain-controller.js';
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

  private readonly layerRuntime: LayerRuntime;
  private readonly cameraRuntime: CesiumCameraController;
  private readonly basemapRuntime: CesiumBasemapController;
  private readonly terrainRuntime: CesiumTerrainController;

  constructor(options: NormalizedCreateMapOptions) {
    const reservation = reserveCesiumBaseUrl(options.cesiumBaseUrl);
    let viewer: Viewer | undefined;
    let cameraRuntime: CesiumCameraController | undefined;
    let basemapRuntime: CesiumBasemapController | undefined;
    let terrainRuntime: CesiumTerrainController | undefined;
    try {
      viewer = new Viewer(options.container, {
        ...options.widgets,
        baseLayer: false,
        sceneMode: options.scene.mode === '2d' ? SceneMode.SCENE2D : SceneMode.SCENE3D,
      });
      const viewerInstance = viewer;
      cameraRuntime = new CesiumCameraController(viewerInstance.camera);
      basemapRuntime = new CesiumBasemapController(viewerInstance);
      terrainRuntime = new CesiumTerrainController(viewerInstance);
      const layerRuntime = new LayerRuntime((spec, context) => {
        return createCesiumLayer(viewerInstance, spec, context);
      });
      if (options.basemap) {
        basemapRuntime.set(options.basemap);
      }

      commitCesiumBaseUrl(reservation);
      this.raw = Object.freeze({ viewer: viewerInstance });
      this.cameraRuntime = cameraRuntime;
      this.basemapRuntime = basemapRuntime;
      this.terrainRuntime = terrainRuntime;
      this.camera = cameraRuntime;
      this.basemap = basemapRuntime;
      this.terrain = terrainRuntime;
      this.layerRuntime = layerRuntime;
      this.layers = layerRuntime;
    } catch (error: unknown) {
      try {
        cameraRuntime?.destroy();
      } catch {
        // Preserve the original construction error.
      }
      try {
        basemapRuntime?.destroy();
      } catch {
        // Preserve the original construction error.
      }
      try {
        terrainRuntime?.destroy();
      } catch {
        // Preserve the original construction error.
      }
      try {
        viewer?.destroy();
      } catch {
        // Preserve the original construction error.
      }
      try {
        rollbackCesiumBaseUrl(reservation);
      } catch {
        // Preserve the original construction error; rollback releases the lock in finally.
      }
      throw error;
    }
  }

  resize(): void {
    this.raw.viewer.resize();
  }

  async destroy(): Promise<void> {
    await this.layerRuntime.destroy();
    this.cameraRuntime.destroy();
    this.basemapRuntime.destroy();
    this.terrainRuntime.destroy();
    this.raw.viewer.destroy();
  }
}
