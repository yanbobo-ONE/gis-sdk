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
import type { EnvironmentController } from '../src/core/environment.js';
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
  pending: false,
  ready: Promise.resolve(),
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

const layers = {
  add: vi.fn(),
  get: vi.fn((id: string) =>
    id === 'roads'
      ? { id, type: 'polyline', state: 'ready', visible: true, errorCount: 2 }
      : undefined,
  ),
  list: vi.fn(() => [{ id: 'roads', type: 'polyline', state: 'ready', visible: true }]),
  remove: vi.fn(),
  clear: vi.fn(),
} as unknown as LayerManager;

function createAdapter(): TestAdapter {
  let reporter: ((error: GisError) => void) | undefined;
  return {
    raw: { name: 'fake' },
    layers,
    getEngineDiagnostics: () => ({ cameraRecoveryCount: 3 }),
    camera,
    environment,
    basemap,
    terrain,
    coordinates,
    quality,
    picking,
    setErrorReporter: (next) => {
      reporter = next;
    },
    reportError: (error) => reporter?.(error),
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
    expect(map.camera.view).toEqual({
      longitude: 116.39,
      latitude: 39.9,
      height: 1000,
      heading: 0,
      pitch: -90,
      roll: 0,
    });
    expect(map.camera.viewRectangle).toBeUndefined();
    expect(map.camera.metersPerPixel).toBe(120);
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

  it('delegates drawing edit calls and gates them after destroy', async () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);
    const geometry = {
      mode: 'polyline' as const,
      positions: [
        { longitude: 1, latitude: 2 },
        { longitude: 3, latitude: 4 },
      ],
    };
    (adapter.drawing.commitEdit as Mock).mockReturnValue(geometry);

    expect(map.drawing.edit(geometry)).toBe(true);
    expect(map.drawing.editing).toBeUndefined();
    expect(map.drawing.commitEdit()).toEqual(geometry);
    map.drawing.cancelEdit();
    expect((adapter.drawing.edit as Mock).mock.calls[0]?.[0]).toBe(geometry);
    expect((adapter.drawing.commitEdit as Mock).mock.calls).toHaveLength(1);
    expect((adapter.drawing.cancelEdit as Mock).mock.calls).toHaveLength(1);

    await map.destroy();
    expect(() => map.drawing.edit(geometry)).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'drawing.edit' }),
    );
    expect(() => map.drawing.commitEdit()).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'drawing.commitEdit' }),
    );
    expect(() => map.drawing.insertVertex({ longitude: 1, latitude: 2 })).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'drawing.insertVertex' }),
    );
    expect(() => map.drawing.removeVertex(0)).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'drawing.removeVertex' }),
    );
    expect(() => {
      map.drawing.cancelEdit();
    }).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'drawing.cancelEdit' }));
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

  it('delegates environment effects and gates them after destroy', async () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);
    const state = { kind: 'depthFog' as const, enabled: true, options: { density: 0.4 } };
    (adapter.environment.set as Mock).mockReturnValue(state);

    expect(map.environment.active).toEqual([]);
    expect(map.environment.set('depthFog', { density: 0.4 })).toBe(state);
    map.environment.setEnabled('depthFog', false);
    map.environment.clear('rain');
    map.environment.clearAll();
    expect((adapter.environment.set as Mock).mock.calls[0]).toEqual(['depthFog', { density: 0.4 }]);
    expect((adapter.environment.setEnabled as Mock).mock.calls[0]).toEqual(['depthFog', false]);

    await map.destroy();
    expect(() => map.environment.set('depthFog')).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'environment.set' }),
    );
    expect(() => map.environment.setEnabled('haze', true)).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'environment.setEnabled' }),
    );
    expect(() => {
      map.environment.clear('haze');
    }).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'environment.clear' }));
    expect(() => {
      map.environment.clearAll();
    }).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'environment.clearAll' }),
    );
  });

  it('exposes analysis on the terrain port and gates it after destroy', async () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);
    (adapter.terrain.sample as Mock).mockResolvedValue([
      { longitude: 1, latitude: 2, height: 30, status: 'ok' },
    ]);

    expect(map.analysis.list().length).toBeGreaterThan(0);
    const samples = await map.analysis.run('terrain-sample', {
      points: [{ longitude: 1, latitude: 2 }],
    });
    expect(samples).toEqual([{ longitude: 1, latitude: 2, height: 30, status: 'ok' }]);
    expect((adapter.terrain.sample as Mock).mock.calls[0]?.[0]).toEqual([
      { longitude: 1, latitude: 2 },
    ]);

    const distance = await map.analysis.run('distance', {
      from: { longitude: 0, latitude: 0 },
      to: { longitude: 0.01, latitude: 0 },
    });
    expect(distance.meters).toBeGreaterThan(1_000);

    await map.destroy();
    // 就绪门禁在派发前同步抛出，不会返回 Promise。
    expect(() =>
      map.analysis.run('distance', {
        from: { longitude: 0, latitude: 0 },
        to: { longitude: 0, latitude: 1 },
      }),
    ).toThrow(expect.objectContaining({ code: 'MAP_DISPOSED', operation: 'analysis.run' }));
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

  it('collects a diagnostics snapshot without throwing', () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);

    const snapshot = map.diagnostics.snapshot();

    expect(snapshot.id).toBe('map-1');
    expect(snapshot.state).toBe('ready');
    expect(snapshot.camera.recoveryCount).toBe(3);
    expect(snapshot.camera.view?.longitude).toBe(116.39);
    expect(snapshot.layers).toEqual([
      { id: 'roads', type: 'polyline', state: 'ready', visible: true, errorCount: 2 },
    ]);
    expect(snapshot.basemap).toEqual({ type: 'none', visible: false, opacity: 1, errorCount: 0 });
    expect(snapshot.terrain).toEqual({ type: 'ellipsoid', pending: false });
    expect(snapshot.scene).toEqual({ mode: '3d', morphing: false });
    expect(snapshot.environment).toEqual([]);
    expect(snapshot.drawing).toEqual({ mode: undefined, vertexCount: 0, editing: false });
    expect(snapshot.quality.adaptive).toBe(true);
  });

  it('reports an unreadable camera pose as undefined instead of throwing', () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);
    Object.defineProperty(adapter.camera, 'view', {
      get() {
        throw new GisError('camera is gone', {
          code: 'CAMERA_VIEW_UNAVAILABLE',
          module: 'camera',
          operation: 'view',
        });
      },
      configurable: true,
    });

    const snapshot = map.diagnostics.snapshot();

    expect(snapshot.camera.view).toBeUndefined();
    expect(snapshot.camera.viewRectangle).toBeUndefined();
  });
});
