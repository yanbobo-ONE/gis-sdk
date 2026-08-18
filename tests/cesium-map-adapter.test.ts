import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class Viewer {
    static readonly instances: Viewer[] = [];
    static constructionError: Error | undefined;

    readonly resize = vi.fn();
    readonly destroy = vi.fn();

    constructor(
      readonly container: string | HTMLElement,
      readonly options: Record<string, unknown>,
    ) {
      if (Viewer.constructionError) {
        throw Viewer.constructionError;
      }
      Viewer.instances.push(this);
    }
  }

  let currentBaseUrl = 'https://auto.example/cesium/';
  const setBaseUrl = vi.fn((value: string) => {
    currentBaseUrl = value;
  });
  const buildModuleUrl = Object.assign(
    vi.fn(() => currentBaseUrl),
    { setBaseUrl },
  );

  return {
    buildModuleUrl,
    resetBaseUrl() {
      currentBaseUrl = 'https://auto.example/cesium/';
    },
    Viewer,
    setBaseUrl,
  };
});

vi.mock('cesium', () => ({
  buildModuleUrl: cesium.buildModuleUrl,
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
    Reflect.deleteProperty(
      cesium.buildModuleUrl,
      Symbol.for('@yanbobo/gis-sdk/cesium-base-url-state/v1'),
    );
    cesium.resetBaseUrl();
    cesium.setBaseUrl.mockClear();
    cesium.Viewer.instances.splice(0);
    cesium.Viewer.constructionError = undefined;
  });

  it('configures one global base URL, delegates Viewer lifecycle, and rejects conflicts', async () => {
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const first = new CesiumMapAdapter(createOptions('map-1', 'https://a.example/cesium/', '2d'));
    const second = new CesiumMapAdapter(createOptions('map-2'));
    const third = new CesiumMapAdapter(createOptions('map-3', 'https://a.example/cesium/'));

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
    expect(third.raw.viewer).toBe(cesium.Viewer.instances[2]);

    expect(() => {
      new CesiumMapAdapter(createOptions('map-4', 'https://b.example/cesium/'));
    }).toThrow(
      expect.objectContaining({
        code: 'CESIUM_BASE_URL_CONFLICT',
        module: 'cesium',
        operation: 'configureBaseUrl',
      }),
    );
    expect(cesium.Viewer.instances).toHaveLength(3);
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

  it('preserves a host-configured base URL when the SDK option is omitted', async () => {
    cesium.setBaseUrl('https://host.example/cesium/');
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');

    new CesiumMapAdapter(createOptions('map-1'));

    expect(cesium.setBaseUrl).toHaveBeenCalledTimes(1);
    expect(cesium.setBaseUrl).toHaveBeenCalledWith('https://host.example/cesium/');
  });

  it('rolls back a reserved base URL when Viewer construction fails', async () => {
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const failure = new Error('Viewer construction failed');
    cesium.Viewer.constructionError = failure;

    expect(() => {
      new CesiumMapAdapter(createOptions('map-1', 'https://a.example/cesium/'));
    }).toThrow(failure);
    expect(cesium.setBaseUrl).toHaveBeenNthCalledWith(1, 'https://a.example/cesium/');
    expect(cesium.setBaseUrl).toHaveBeenNthCalledWith(2, 'https://auto.example/cesium/');

    cesium.Viewer.constructionError = undefined;
    expect(
      new CesiumMapAdapter(createOptions('map-2', 'https://b.example/cesium/')).raw.viewer,
    ).toBe(cesium.Viewer.instances[0]);
  });

  it('sets an explicit base URL when Cesium cannot resolve its previous base', async () => {
    cesium.buildModuleUrl.mockImplementationOnce(() => {
      throw new Error('Unable to determine Cesium base URL automatically');
    });
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');

    expect(
      new CesiumMapAdapter(createOptions('map-1', 'https://sdk.example/cesium/')).raw.viewer,
    ).toBe(cesium.Viewer.instances[0]);
    expect(cesium.setBaseUrl).toHaveBeenCalledWith('https://sdk.example/cesium/');
  });

  it('allows a different explicit base after an unknown previous base cannot be restored', async () => {
    cesium.buildModuleUrl.mockImplementationOnce(() => {
      throw new Error('Unable to determine Cesium base URL automatically');
    });
    cesium.Viewer.constructionError = new Error('Viewer construction failed');
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');

    expect(() => {
      new CesiumMapAdapter(createOptions('map-1', 'https://sdk.example/cesium/'));
    }).toThrow('Viewer construction failed');

    cesium.Viewer.constructionError = undefined;
    expect(
      new CesiumMapAdapter(createOptions('map-2', 'https://other.example/cesium/')).raw.viewer,
    ).toBe(cesium.Viewer.instances[0]);
    expect(cesium.setBaseUrl).toHaveBeenLastCalledWith('https://other.example/cesium/');
  });

  it('inherits a residual explicit base when a retry omits the option', async () => {
    cesium.buildModuleUrl.mockImplementationOnce(() => {
      throw new Error('Unable to determine Cesium base URL automatically');
    });
    cesium.Viewer.constructionError = new Error('Viewer construction failed');
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');

    expect(() => {
      new CesiumMapAdapter(createOptions('map-1', 'https://sdk.example/cesium/'));
    }).toThrow('Viewer construction failed');

    cesium.Viewer.constructionError = undefined;
    expect(new CesiumMapAdapter(createOptions('map-2')).raw.viewer).toBe(
      cesium.Viewer.instances[0],
    );
    expect(cesium.setBaseUrl).toHaveBeenCalledTimes(1);
  });

  it('shares the base URL lock across SDK module instances', async () => {
    const firstModule = await import('../src/cesium/cesium-map-adapter.js');
    new firstModule.CesiumMapAdapter(createOptions('map-1', 'https://a.example/cesium/'));

    vi.resetModules();
    const secondModule = await import('../src/cesium/cesium-map-adapter.js');
    expect(() => {
      new secondModule.CesiumMapAdapter(createOptions('map-2', 'https://b.example/cesium/'));
    }).toThrow(
      expect.objectContaining({
        code: 'CESIUM_BASE_URL_CONFLICT',
      }),
    );
    expect(cesium.Viewer.instances).toHaveLength(1);
  });
});
