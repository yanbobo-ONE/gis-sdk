import type { Viewer } from 'cesium';

import type { GisMap } from '../core/contracts.js';

export type CesiumSceneMode = '2d' | '3d';

export interface CesiumWidgetOptions {
  readonly animation?: boolean;
  readonly baseLayerPicker?: boolean;
  readonly fullscreenButton?: boolean;
  readonly geocoder?: boolean;
  readonly homeButton?: boolean;
  readonly infoBox?: boolean;
  readonly navigationHelpButton?: boolean;
  readonly sceneModePicker?: boolean;
  readonly selectionIndicator?: boolean;
  readonly timeline?: boolean;
}

export interface CreateMapOptions {
  readonly container: string | HTMLElement;
  readonly id?: string;
  readonly cesiumBaseUrl?: string;
  readonly scene?: {
    readonly mode?: CesiumSceneMode;
  };
  readonly widgets?: CesiumWidgetOptions;
}

export interface CesiumRawContext {
  readonly viewer: Viewer;
}

export type CesiumMap = GisMap<CesiumRawContext>;
