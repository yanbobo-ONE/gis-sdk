import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { MapEngineAdapter } from '../src/core/contracts.js';
import type {
  BasemapController,
  CameraController,
  CoordinateTransform,
  PickingController,
  TerrainController,
} from '../src/core/controls.js';
import type { EnvironmentController } from '../src/core/environment.js';
import type { QualityController } from '../src/core/quality.js';
import { GisError } from '../src/core/errors.js';
import {
  createMapWithFactory,
  type MapAdapterFactory,
  type NormalizedCreateMapOptions,
} from '../src/cesium/create-map.js';
import type { LayerManager } from '../src/layers/contracts.js';

interface FakeRawContext {
  readonly viewer: { readonly kind: 'fake' };
}

interface FakeAdapter extends MapEngineAdapter<FakeRawContext> {
  readonly layers: LayerManager;
  resize: Mock<() => void>;
  destroy: Mock<() => void | Promise<void>>;
}

const environment = {
  active: [],
  set: vi.fn(() => undefined),
  setEnabled: vi.fn(() => undefined),
  clear: vi.fn(),
  clearAll: vi.fn(),
} as unknown as EnvironmentController;

const camera = {
  cancelFlight: vi.fn(),
  flyTo: vi.fn(() => Promise.resolve()),
  setView: vi.fn(),
  view: { longitude: 116.39, latitude: 39.9, height: 1000, heading: 0, pitch: -90, roll: 0 },
  viewRectangle: undefined,
  metersPerPixel: 120,
} satisfies CameraController;

const basemap = {
  clear: vi.fn(),
  errorCount: 0,
  opacity: 1,
  set: vi.fn(),
  setOpacity: vi.fn(),
  setVisible: vi.fn(),
  type: 'none',
  visible: false,
} satisfies BasemapController;

const terrain = {
  sample: vi.fn(() => Promise.resolve([])),
  set: vi.fn(() => Promise.resolve()),
  type: 'ellipsoid',
} satisfies TerrainController;

function createFactory() {
  let receivedOptions: NormalizedCreateMapOptions | undefined;

  const coordinates: CoordinateTransform = {
    toWorld: vi.fn((position: { longitude: number; latitude: number; height?: number }) => ({
      x: position.longitude,
      y: position.latitude,
      z: position.height ?? 0,
    })),
    toGeoPosition: vi.fn((world: { x: number; y: number; z: number }) => ({
      longitude: world.x,
      latitude: world.y,
      height: world.z,
    })),
    toWindow: vi.fn(() => ({ x: 10, y: 20 })),
    pickGeoPosition: vi.fn(() => ({ longitude: 1, latitude: 2, height: 3 })),
  };

  const picking: PickingController = {
    enabled: true,
    lastHit: undefined,
    on: vi.fn(() => () => undefined),
    setEnabled: vi.fn(),
  };

  const quality: QualityController = {
    current: { resolutionScale: 1, terrainSse: 2, modelLoadConcurrency: 4 },
    snapshot: {
      resolutionScale: 1,
      terrainSse: 2,
      modelLoadConcurrency: 4,
      fps: 0,
      frameTimeMs: 0,
      sampleCount: 0,
      degraded: false,
      adaptive: true,
    },
    adaptive: true,
    setProfile: vi.fn(),
    set: vi.fn(),
    setAdaptive: vi.fn(),
  };

  const adapter: FakeAdapter = {
    raw: { viewer: { kind: 'fake' } },
    layers: {} as LayerManager,
    camera,
    environment,
    basemap,
    terrain,
    coordinates,
    quality,
    picking,
    scene: {
      mode: '3d' as const,
      morphing: false,
      setMode: vi.fn(() => Promise.resolve()),
    },
    drawing: {
      mode: undefined,
      vertexCount: 0,
      start: vi.fn(() => true),
      finish: vi.fn(() => undefined),
      cancel: vi.fn(),
      removeLatestCompleted: vi.fn(),
      clearCompleted: vi.fn(),
      edit: vi.fn(() => true),
      editing: undefined,
      insertVertex: vi.fn(() => undefined),
      removeVertex: vi.fn(() => undefined),
      commitEdit: vi.fn(() => undefined),
      cancelEdit: vi.fn(),
      setSnap: vi.fn(),
      snap: { enabled: false, pixelTolerance: 12, includeEdges: false },
      on: vi.fn(() => () => undefined),
    },
    resize: vi.fn(),
    capture: vi.fn(() => Promise.resolve(undefined)),
    destroy: vi.fn(),
  };
  const factory: MapAdapterFactory<FakeRawContext> = (options) => {
    receivedOptions = options;
    return adapter;
  };

  return {
    adapter,
    factory,
    get options() {
      return receivedOptions;
    },
  };
}

describe('createMapWithFactory', () => {
  it('rejects an empty string container with INVALID_CONTAINER', () => {
    const { factory } = createFactory();

    expect(() => {
      createMapWithFactory({ container: '   ' }, factory);
    }).toThrow(
      expect.objectContaining({
        code: 'INVALID_CONTAINER',
        module: 'cesium',
        operation: 'createMap',
        retryable: false,
      }),
    );
  });

  it('defaults to 3d and disables optional widgets', () => {
    const context = createFactory();

    createMapWithFactory({ container: 'map' }, context.factory);

    expect(context.options?.scene.mode).toBe('3d');
    expect(context.options?.widgets).toEqual({
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
  });

  it('normalizes the Cesium base URL to one trailing slash', () => {
    const context = createFactory();

    createMapWithFactory(
      { container: 'map', cesiumBaseUrl: ' https://static.example/cesium/// ' },
      context.factory,
    );

    expect(context.options?.cesiumBaseUrl).toBe('https://static.example/cesium/');
  });

  it('rejects an invalid initial basemap before constructing the adapter', () => {
    const context = createFactory();

    expect(() => {
      createMapWithFactory(
        {
          container: 'map',
          basemap: { type: 'xyz', url: 'https://tiles.example.com/tiles.png' },
        },
        context.factory,
      );
    }).toThrow(expect.objectContaining({ code: 'INVALID_BASEMAP_CONFIG' }));

    expect(context.options).toBeUndefined();
  });

  it('passes a deeply frozen normalized options object to the adapter factory', () => {
    const context = createFactory();

    createMapWithFactory(
      {
        container: 'map',
        id: 'map-1',
        scene: { mode: '2d' },
        widgets: { timeline: true },
      },
      context.factory,
    );

    expect(context.options).toMatchObject({
      container: 'map',
      id: 'map-1',
      scene: { mode: '2d' },
      widgets: { timeline: true },
    });
    expect(Object.isFrozen(context.options)).toBe(true);
    expect(Object.isFrozen(context.options?.scene)).toBe(true);
    expect(Object.isFrozen(context.options?.widgets)).toBe(true);
  });

  it('returns a map that exposes raw context and delegates lifecycle', async () => {
    const context = createFactory();

    const map = createMapWithFactory({ container: 'map', id: 'map-1' }, context.factory);
    map.resize();
    await map.destroy();

    expect(map.id).toBe('map-1');
    expect(map.raw).toBe(context.adapter.raw);
    expect(context.adapter.resize).toHaveBeenCalledOnce();
    expect(context.adapter.destroy).toHaveBeenCalledOnce();
  });

  it('throws GisError instances for validation failures', () => {
    const { factory } = createFactory();

    try {
      createMapWithFactory({ container: '' }, factory);
      throw new Error('Expected createMapWithFactory to throw.');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(GisError);
    }
  });

  it('normalizes the render quality profile and rejects invalid values', () => {
    const defaults = createFactory();
    const defaultMap = createMapWithFactory({ container: 'map', id: 'map-1' }, defaults.factory);
    void defaultMap.destroy();

    expect(defaults.options?.quality).toEqual({
      resolutionScale: 1,
      terrainSse: 2,
      modelLoadConcurrency: 4,
    });
    expect(defaults.options?.qualityAdaptive).toBe(true);
    expect(Object.isFrozen(defaults.options?.quality)).toBe(true);

    const custom = createFactory();
    const customMap = createMapWithFactory(
      {
        container: 'map',
        id: 'map-2',
        quality: { profile: 'low', adaptive: false, modelLoadConcurrency: 6 },
      },
      custom.factory,
    );
    void customMap.destroy();

    expect(custom.options?.quality).toEqual({
      resolutionScale: 0.75,
      terrainSse: 12,
      modelLoadConcurrency: 6,
    });
    expect(custom.options?.qualityAdaptive).toBe(false);

    for (const quality of [
      { profile: 'unknown' as never },
      { resolutionScale: 0.1 },
      { terrainSse: 0 },
      { modelLoadConcurrency: 1.5 },
      { adaptive: 'yes' as never },
    ]) {
      expect(() =>
        createMapWithFactory({ container: 'map', quality }, createFactory().factory),
      ).toThrow(expect.objectContaining({ code: 'INVALID_QUALITY_CONFIG' }));
    }
  });
});
