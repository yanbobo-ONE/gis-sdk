import { buildModuleUrl, SceneMode, Viewer } from 'cesium';

import type { MapEngineAdapter } from '../core/contracts.js';
import type { NormalizedCreateMapOptions } from './create-map.js';
import type { CesiumRawContext } from './types.js';

interface BuildModuleUrlWithBaseUrl {
  setBaseUrl(value: string): void;
}

const moduleUrl = buildModuleUrl as typeof buildModuleUrl & BuildModuleUrlWithBaseUrl;

export class CesiumMapAdapter implements MapEngineAdapter<CesiumRawContext> {
  readonly raw: Readonly<CesiumRawContext>;

  constructor(options: NormalizedCreateMapOptions) {
    if (options.cesiumBaseUrl) {
      moduleUrl.setBaseUrl(options.cesiumBaseUrl);
    }

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
