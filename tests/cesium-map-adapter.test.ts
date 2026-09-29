import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class Viewer {
    static readonly instances: Viewer[] = [];
    static constructionError: Error | undefined;
    static imageryError: Error | undefined;

    readonly resize = vi.fn();
    readonly destroy = vi.fn();
    readonly screenSpaceEventHandler = {
      setInputAction: vi.fn(),
      removeInputAction: vi.fn(),
    };
    readonly camera = {
      cancelFlight: vi.fn(),
      flyTo: vi.fn(),
      setView: vi.fn(),
      changed: { addEventListener: vi.fn(() => () => undefined) },
      position: { x: 1, y: 2, z: 3 },
      direction: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      right: { x: 0, y: 1, z: 0 },
    };
    readonly frameListeners = new Set<() => void>();
    resolutionScale = 1;
    readonly scene = {
      camera: { changed: { addEventListener: vi.fn(() => () => undefined) } },
      pick: vi.fn(),
      drillPick: vi.fn(() => []),
      globe: { maximumScreenSpaceError: 2, terrainProvider: undefined as unknown },
      preUpdate: {
        addEventListener: (listener: () => void) => {
          this.frameListeners.add(listener);
          return () => this.frameListeners.delete(listener);
        },
      },
      postRender: {
        addEventListener: (listener: () => void) => {
          this.frameListeners.add(listener);
          return () => this.frameListeners.delete(listener);
        },
      },
      requestRender: vi.fn(),
      screenSpaceCameraController: { update: vi.fn() },
    };
    readonly imageryLayers = {
      addImageryProvider: vi.fn(() => {
        if (Viewer.imageryError) {
          throw Viewer.imageryError;
        }
        return { alpha: 1, show: true };
      }),
      remove: vi.fn(() => true),
    };
    terrainProvider = { kind: 'ellipsoid' };

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
  CesiumTerrainProvider: { fromUrl: vi.fn() },
  Cartesian3: { fromDegrees: vi.fn() },
  Color: {
    WHITE: { css: 'white' },
    fromCssColorString: vi.fn((value: string) => ({ css: value })),
  },
  ColorBlendMode: { HIGHLIGHT: 'HIGHLIGHT', MIX: 'MIX' },
  ScreenSpaceEventHandler: class ScreenSpaceEventHandler {
    constructor(readonly canvas: unknown) {}
  },
  ScreenSpaceEventType: { LEFT_CLICK: 3, MOUSE_MOVE: 15 },
  defined: (value: unknown) => value !== undefined,
  EllipsoidTerrainProvider: function EllipsoidTerrainProvider() {
    return undefined;
  },
  Math: { toRadians: vi.fn((value: number) => value) },
  SceneMode: { SCENE2D: 2, SCENE3D: 3 },
  UrlTemplateImageryProvider: class UrlTemplateImageryProvider {
    constructor(readonly options: Record<string, unknown>) {}
  },
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
    quality: Object.freeze({ resolutionScale: 1, terrainSse: 2, modelLoadConcurrency: 4 }),
    qualityAdaptive: true,
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
    cesium.Viewer.imageryError = undefined;
  });

  it('configures one global base URL, delegates Viewer lifecycle, and rejects conflicts', async () => {
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const first = new CesiumMapAdapter(createOptions('map-1', 'https://a.example/cesium/', '2d'));
    const second = new CesiumMapAdapter(createOptions('map-2'));
    const third = new CesiumMapAdapter(createOptions('map-3', 'https://a.example/cesium/'));

    first.resize();
    await first.destroy();

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

  it('installs an initial XYZ basemap below managed imagery layers', async () => {
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const options = Object.freeze({
      ...createOptions('map-1'),
      basemap: Object.freeze({ type: 'xyz' as const, url: '/tiles/{z}/{x}/{y}.png' }),
    });

    const adapter = new CesiumMapAdapter(options);

    expect(adapter.basemap.type).toBe('xyz');
    expect(cesium.Viewer.instances[0]?.imageryLayers.addImageryProvider).toHaveBeenCalledWith(
      expect.objectContaining({ options: { url: '/tiles/{z}/{x}/{y}.png' } }),
      0,
    );
  });

  it('cleans up the Viewer and releases the base URL when initial basemap setup fails', async () => {
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const failure = new Error('imagery provider failed');
    cesium.Viewer.imageryError = failure;

    expect(() => {
      new CesiumMapAdapter(
        Object.freeze({
          ...createOptions('map-1', 'https://a.example/cesium/'),
          basemap: Object.freeze({ type: 'xyz' as const, url: '/tiles/{z}/{x}/{y}.png' }),
        }),
      );
    }).toThrow(failure);
    expect(cesium.Viewer.instances[0]?.destroy).toHaveBeenCalledOnce();

    cesium.Viewer.imageryError = undefined;
    const retry = new CesiumMapAdapter(createOptions('map-2', 'https://b.example/cesium/'));
    expect(retry.raw.viewer).toBe(cesium.Viewer.instances[1]);
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

  it('exposes one layer manager and destroys it before the Viewer', async () => {
    const order: string[] = [];
    const layerModule = await import('../src/layers/layer-runtime.js');
    const destroyLayers = vi
      .spyOn(layerModule.LayerRuntime.prototype, 'destroy')
      .mockImplementationOnce(() => {
        order.push('layers');
        return Promise.resolve();
      });
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const adapter = new CesiumMapAdapter(createOptions('map-1'));
    cesium.Viewer.instances[0]?.destroy.mockImplementationOnce(() => {
      order.push('viewer');
    });

    expect(adapter.layers).toBe(adapter.layers);
    await adapter.destroy();

    expect(destroyLayers).toHaveBeenCalledOnce();
    expect(order).toEqual(['layers', 'viewer']);
  });

  it('does not destroy the Viewer when layer cleanup fails and permits retry', async () => {
    const layerModule = await import('../src/layers/layer-runtime.js');
    const destroyLayers = vi
      .spyOn(layerModule.LayerRuntime.prototype, 'destroy')
      .mockRejectedValueOnce(new Error('layer cleanup failed'))
      .mockResolvedValueOnce(undefined);
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const adapter = new CesiumMapAdapter(createOptions('map-1'));

    await expect(adapter.destroy()).rejects.toThrow('layer cleanup failed');
    expect(cesium.Viewer.instances[0]?.destroy).not.toHaveBeenCalled();

    await expect(adapter.destroy()).resolves.toBeUndefined();
    expect(destroyLayers).toHaveBeenCalledTimes(2);
    expect(cesium.Viewer.instances[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('installs the camera pose guard and releases every frame listener before destroying the Viewer', async () => {
    const { CesiumMapAdapter } = await import('../src/cesium/cesium-map-adapter.js');
    const adapter = new CesiumMapAdapter(createOptions('map-1'));
    const viewer = cesium.Viewer.instances[0];
    // 相机位姿兜底与画质控制器各订阅一次 preUpdate，画质控制器再订阅一次 postRender。
    expect(viewer?.frameListeners.size).toBe(3);

    const position = viewer?.camera.position;
    if (position) {
      position.x = Number.NaN;
    }
    for (const listener of [...(viewer?.frameListeners ?? [])]) listener();
    expect(viewer?.camera.position).toEqual({ x: 1, y: 2, z: 3 });

    await adapter.destroy();
    expect(viewer?.frameListeners.size).toBe(0);
  });
});
