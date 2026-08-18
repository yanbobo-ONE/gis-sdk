import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class Viewer {
    static readonly instances: Viewer[] = [];

    readonly resize = vi.fn();
    readonly destroy = vi.fn();

    constructor(
      readonly container: string | HTMLElement,
      readonly options: Record<string, unknown>,
    ) {
      Viewer.instances.push(this);
    }
  }

  return {
    Viewer,
    setBaseUrl: vi.fn(),
  };
});

vi.mock('cesium', () => ({
  buildModuleUrl: Object.assign(vi.fn(), { setBaseUrl: cesium.setBaseUrl }),
  SceneMode: { SCENE2D: 2, SCENE3D: 3 },
  Viewer: cesium.Viewer,
}));

import type { NormalizedCreateMapOptions } from '../src/cesium/create-map.js';

const widgets = Object.freeze({
  animation: false,
  baseLayerPicker: false,
  fullscreenButton: false,
  geocoder: false,
  homeButton: false,
  infoBox: false,
  navigationHelpButton: false,
  sceneModePicker: false,
  selectionIndicator: false,
  timeline: false,
});

function createOptions(
  id: string,
  cesiumBaseUrl?: string,
  mode: '2d' | '3d' = '3d',
): NormalizedCreateMapOptions {
  const options = {
    container: id,
    id,
    scene: Object.freeze({ mode }),
    widgets,
  };

  return Object.freeze(cesiumBaseUrl ? { ...options, cesiumBaseUrl } : options);
}

describe('CesiumMapAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    cesium.setBaseUrl.mockClear();
    cesium.Viewer.instances.splice(0);
  });

  it('configures one global base URL, delegates Viewer lifecycle, and rejects conflicts', async () => {
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const first = new CesiumMapAdapter(createOptions('map-1', 'https://a.example/cesium/', '2d'));
    const second = new CesiumMapAdapter(createOptions('map-2', 'https://a.example/cesium/'));

    first.resize();
    first.destroy();

    expect(cesium.setBaseUrl).toHaveBeenCalledOnce();
    expect(cesium.setBaseUrl).toHaveBeenCalledWith('https://a.example/cesium/');
    expect(first.raw.viewer).toBe(cesium.Viewer.instances[0]);
    expect(cesium.Viewer.instances[0]?.options).toMatchObject({
      ...widgets,
      baseLayer: false,
      sceneMode: 2,
    });
    expect(cesium.Viewer.instances[0]?.resize).toHaveBeenCalledOnce();
    expect(cesium.Viewer.instances[0]?.destroy).toHaveBeenCalledOnce();
    expect(second.raw.viewer).toBe(cesium.Viewer.instances[1]);

    expect(() => {
      new CesiumMapAdapter(createOptions('map-3', 'https://b.example/cesium/'));
    }).toThrow(
      expect.objectContaining({
        code: 'CESIUM_BASE_URL_CONFLICT',
        module: 'cesium',
        operation: 'configureBaseUrl',
      }),
    );
    expect(cesium.Viewer.instances).toHaveLength(2);
  });

  it('locks automatic base URL resolution when the first Viewer is created', async () => {
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    new CesiumMapAdapter(createOptions('map-1'));

    expect(cesium.setBaseUrl).not.toHaveBeenCalled();
    expect(() => {
      new CesiumMapAdapter(createOptions('map-2', 'https://a.example/cesium/'));
    }).toThrow(
      expect.objectContaining({
        code: 'CESIUM_BASE_URL_CONFLICT',
        operation: 'configureBaseUrl',
      }),
    );
    expect(cesium.Viewer.instances).toHaveLength(1);
  });
});
