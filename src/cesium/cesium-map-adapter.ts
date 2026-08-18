import { buildModuleUrl, SceneMode, Viewer } from 'cesium';

import type { MapEngineAdapter } from '../core/contracts.js';
import { GisError } from '../core/errors.js';
import type { NormalizedCreateMapOptions } from './create-map.js';
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
  readonly previousBaseUrl: string | undefined;
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
  const previousBaseUrl = cesiumBaseUrl ? tryGetCesiumBaseUrl() : undefined;
  if (cesiumBaseUrl) {
    moduleUrl.setBaseUrl(cesiumBaseUrl);
  }

  state.phase = 'configuring';
  state.configuredBaseUrl = cesiumBaseUrl;
  state.reservationToken = token;
  return { state, token, previousBaseUrl };
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

  if (reservation.state.configuredBaseUrl && !reservation.previousBaseUrl) {
    // Cesium accepted the new value but exposed no restorable previous value.
    reservation.state.phase = 'locked';
    reservation.state.reservationToken = undefined;
    return;
  }

  try {
    if (reservation.previousBaseUrl) {
      moduleUrl.setBaseUrl(reservation.previousBaseUrl);
    }
  } finally {
    reservation.state.phase = 'unlocked';
    reservation.state.configuredBaseUrl = undefined;
    reservation.state.reservationToken = undefined;
  }
}

export class CesiumMapAdapter implements MapEngineAdapter<CesiumRawContext> {
  readonly raw: Readonly<CesiumRawContext>;

  constructor(options: NormalizedCreateMapOptions) {
    const reservation = reserveCesiumBaseUrl(options.cesiumBaseUrl);
    let viewer: Viewer;
    try {
      viewer = new Viewer(options.container, {
        ...options.widgets,
        baseLayer: false,
        sceneMode: options.scene.mode === '2d' ? SceneMode.SCENE2D : SceneMode.SCENE3D,
      });
    } catch (error: unknown) {
      try {
        rollbackCesiumBaseUrl(reservation);
      } catch {
        // Preserve the Viewer construction error; the shared lock is released in rollback's finally.
      }
      throw error;
    }
    commitCesiumBaseUrl(reservation);

    this.raw = Object.freeze({ viewer });
  }

  resize(): void {
    this.raw.viewer.resize();
  }

  destroy(): void {
    this.raw.viewer.destroy();
  }
}
