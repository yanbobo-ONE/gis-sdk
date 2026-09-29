import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { MapEngineAdapter, MapEventMap } from '../src/core/contracts.js';
import type {
  BasemapController,
  CameraController,
  TerrainController,
} from '../src/core/controls.js';
import { GisError } from '../src/core/errors.js';
import { MapRuntime } from '../src/core/map-runtime.js';
import type { CoordinateTransform, PickingController } from '../src/core/controls.js';
import type { QualityController } from '../src/core/quality.js';
import type { LayerManager } from '../src/layers/contracts.js';

interface RawContext {
  readonly name: string;
}

interface TestAdapter extends MapEngineAdapter<RawContext> {
  readonly layers: LayerManager;
  resize: Mock<() => void>;
  destroy: Mock<() => void | Promise<void>>;
  /** 模拟引擎内部失败上报；调用前需已由 MapRuntime 接入 reporter。 */
  reportError(error: GisError): void;
}

const camera = {
  cancelFlight: vi.fn(),
  flyTo: vi.fn(() => Promise.resolve()),
  setView: vi.fn(),
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

const coordinates = {
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
} satisfies CoordinateTransform;

const picking: PickingController = {
  enabled: true,
  lastHit: undefined,
  on: vi.fn(() => () => undefined),
  setEnabled: vi.fn(),
};

const quality = {
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
} satisfies QualityController;

function createAdapter(): TestAdapter {
  let reporter: ((error: GisError) => void) | undefined;
  return {
    raw: { name: 'fake' },
    layers: {} as LayerManager,
    camera,
    basemap,
    terrain,
    coordinates,
    quality,
    picking,
    setErrorReporter: (next) => {
      reporter = next;
    },
    reportError: (error) => reporter?.(error),
    resize: vi.fn(),
    destroy: vi.fn(),
  };
}

describe('MapRuntime', () => {
  it('starts ready and exposes the adapter raw context', () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);

    expect(map.id).toBe('map-1');
    expect(map.state).toBe('ready');
    expect(map.raw).toBe(adapter.raw);
    expect(map.layers).toBe(adapter.layers);
  });

  it('delegates resize while ready', () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);

    map.resize();

    expect(adapter.resize).toHaveBeenCalledOnce();
  });

  it('provides stable control handles and rejects controller calls after destroy', async () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);

    expect(map.camera).toBe(map.camera);
    expect(map.basemap).toBe(map.basemap);
    expect(map.terrain).toBe(map.terrain);
    map.camera.setView({ longitude: 116.39, latitude: 39.9 });
    map.basemap.set({ type: 'xyz', url: '/tiles/{z}/{x}/{y}.png' });
    await map.terrain.set({ type: 'ellipsoid' });
    expect((adapter.camera.setView as Mock).mock.calls).toHaveLength(1);
    expect((adapter.basemap.set as Mock).mock.calls).toHaveLength(1);
    expect((adapter.terrain.set as Mock).mock.calls).toHaveLength(1);

    await map.destroy();
    expect(() => {
      map.camera.cancelFlight();
    }).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'camera.cancelFlight' }));
    expect(() => {
      map.basemap.clear();
    }).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'basemap.clear' }));
    expect(() => {
      void map.terrain.set({ type: 'ellipsoid' });
    }).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'terrain.set' }));
  });

  it('destroys the adapter and emits map:destroy exactly once', async () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);
    const listener = vi.fn<(event: MapEventMap['map:destroy']) => void>();
    map.events.on('map:destroy', listener);

    await map.destroy();
    await map.destroy();

    expect(adapter.destroy).toHaveBeenCalledOnce();
    expect(map.state).toBe('destroyed');
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ id: 'map-1' });
  });

  it('returns the same promise to concurrent destroy callers', async () => {
    const adapter = createAdapter();
    let finishDestroy: (() => void) | undefined;
    const pendingDestroy = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    adapter.destroy.mockReturnValue(pendingDestroy);
    const map = new MapRuntime('map-1', adapter);

    const firstDestroy = map.destroy();
    const secondDestroy = map.destroy();

    expect(map.state).toBe('destroying');
    expect(secondDestroy).toBe(firstDestroy);
    finishDestroy?.();
    await firstDestroy;
  });

  it('rejects resize after destroy with MAP_DISPOSED', async () => {
    const map = new MapRuntime('map-1', createAdapter());
    await map.destroy();

    expect(() => {
      map.resize();
    }).toThrow(
      expect.objectContaining({
        code: 'MAP_DISPOSED',
        module: 'map',
        operation: 'resize',
        retryable: false,
      }),
    );
  });

  it('emits a typed error and permits retry when adapter destroy fails', async () => {
    const adapter = createAdapter();
    const failure = new Error('adapter destroy failed');
    adapter.destroy.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const map = new MapRuntime('map-1', adapter);
    const listener = vi.fn<(event: MapEventMap['map:error']) => void>();
    map.events.on('map:error', listener);

    await expect(map.destroy()).rejects.toMatchObject({
      code: 'MAP_DESTROY_FAILED',
      module: 'map',
      operation: 'destroy',
      retryable: true,
      cause: failure,
    });
    expect(map.state).toBe('ready');
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].error).toBeInstanceOf(GisError);

    await expect(map.destroy()).resolves.toBeUndefined();
    expect(adapter.destroy).toHaveBeenCalledTimes(2);
    expect(map.state).toBe('destroyed');
  });

  it('keeps a successful destroy resolved when a destroy listener throws', async () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);
    const errorListener = vi.fn<(event: MapEventMap['map:error']) => void>();
    map.events.on('map:destroy', () => {
      throw new Error('consumer listener failed');
    });
    map.events.on('map:error', errorListener);

    await expect(map.destroy()).resolves.toBeUndefined();

    expect(map.state).toBe('destroyed');
    expect(errorListener).toHaveBeenCalledOnce();
    const errorEvent = errorListener.mock.calls[0]?.[0];
    expect(errorEvent?.id).toBe('map-1');
    expect(errorEvent?.error).toMatchObject({
      code: 'EVENT_LISTENER_FAILED',
      operation: 'map:destroy',
    });
  });

  it('preserves the adapter error when a map:error listener throws', async () => {
    const adapter = createAdapter();
    const failure = new Error('adapter destroy failed');
    adapter.destroy.mockRejectedValueOnce(failure);
    const map = new MapRuntime('map-1', adapter);
    map.events.on('map:error', () => {
      throw new Error('consumer listener failed');
    });

    await expect(map.destroy()).rejects.toMatchObject({
      code: 'MAP_DESTROY_FAILED',
      cause: failure,
    });
    expect(map.state).toBe('ready');
  });

  it('delegates coordinates and quality while ready and blocks them after destroy', async () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);

    expect(map.coordinates.toWorld({ longitude: 1, latitude: 2 })).toEqual({ x: 1, y: 2, z: 0 });
    expect(map.coordinates.toWindow({ longitude: 1, latitude: 2 })).toEqual({ x: 10, y: 20 });
    expect(map.coordinates.toGeoPosition({ x: 1, y: 2, z: 3 })).toEqual({
      longitude: 1,
      latitude: 2,
      height: 3,
    });
    expect(map.coordinates.pickGeoPosition({ x: 1, y: 2 })).toEqual({
      longitude: 1,
      latitude: 2,
      height: 3,
    });

    expect(map.quality.current.resolutionScale).toBe(1);
    expect(map.quality.adaptive).toBe(true);
    map.quality.setProfile('low');
    map.quality.set({ resolutionScale: 0.8 });
    map.quality.setAdaptive(false);
    expect(quality.setProfile).toHaveBeenCalledWith('low');
    expect(quality.set).toHaveBeenCalledWith({ resolutionScale: 0.8 });
    expect(quality.setAdaptive).toHaveBeenCalledWith(false);

    await map.destroy();

    expect(() => map.coordinates.toWorld({ longitude: 1, latitude: 2 })).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED' }),
    );
    expect(() => {
      map.quality.setAdaptive(true);
    }).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED' }));
  });

  it('forwards engine level failures to map:error once the adapter is connected', () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);
    const errors: unknown[] = [];
    map.events.on('map:error', (event) => {
      errors.push(event);
    });

    adapter.reportError(
      new GisError('tile failed', {
        code: 'BASEMAP_LOAD_FAILED',
        module: 'basemap',
        operation: 'set',
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ id: 'map-1' });
  });
});
