import { buildModuleUrl, SceneMode, Viewer } from 'cesium';

import type { MapEngineAdapter } from '../core/contracts.js';
import { GisError } from '../core/errors.js';
import type { NormalizedCreateMapOptions } from './create-map.js';
import type { CesiumRawContext } from './types.js';

interface BuildModuleUrlWithBaseUrl {
  setBaseUrl(value: string): void;
}

const moduleUrl = buildModuleUrl as typeof buildModuleUrl & BuildModuleUrlWithBaseUrl;
let configuredCesiumBaseUrl: string | undefined;
let cesiumBaseUrlLocked = false;

function configureCesiumBaseUrl(cesiumBaseUrl: string | undefined): void {
  if (!cesiumBaseUrlLocked) {
    if (cesiumBaseUrl) {
      moduleUrl.setBaseUrl(cesiumBaseUrl);
      configuredCesiumBaseUrl = cesiumBaseUrl;
    }

    cesiumBaseUrlLocked = true;
    return;
  }

  if (!cesiumBaseUrl) {
    return;
  }

  if (configuredCesiumBaseUrl !== cesiumBaseUrl) {
    const existingConfiguration = configuredCesiumBaseUrl
      ? `"${configuredCesiumBaseUrl}"`
      : 'automatic resolution';
    throw new GisError(`Cesium base URL is already locked to ${existingConfiguration}.`, {
      code: 'CESIUM_BASE_URL_CONFLICT',
      module: 'cesium',
      operation: 'configureBaseUrl',
    });
  }
}

export class CesiumMapAdapter implements MapEngineAdapter<CesiumRawContext> {
  readonly raw: Readonly<CesiumRawContext>;

  constructor(options: NormalizedCreateMapOptions) {
    configureCesiumBaseUrl(options.cesiumBaseUrl);

    const viewer = new Viewer(options.container, {
      ...options.widgets,
      baseLayer: false,
      sceneMode: options.scene.mode === '2d' ? SceneMode.SCENE2D : SceneMode.SCENE3D,
    });

    this.raw = Object.freeze({ viewer });
  }

  resize(): void {
    this.raw.viewer.resize();
  }

  destroy(): void {
    this.raw.viewer.destroy();
  }
}
