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
import type { LayerManager } from '../src/layers/contracts.js';

interface RawContext {
  readonly name: string;
}

interface TestAdapter extends MapEngineAdapter<RawContext> {
  readonly layers: LayerManager;
  resize: Mock<() => void>;
  destroy: Mock<() => void | Promise<void>>;
}

const camera = {
  cancelFlight: vi.fn(),
  flyTo: vi.fn(() => Promise.resolve()),
  setView: vi.fn(),
} satisfies CameraController;

const basemap = {
  clear: vi.fn(),
  opacity: 1,
  set: vi.fn(),
  setOpacity: vi.fn(),
  setVisible: vi.fn(),
  type: 'none',
  visible: false,
} satisfies BasemapController;

const terrain = {
  set: vi.fn(() => Promise.resolve()),
  type: 'ellipsoid',
} satisfies TerrainController;

function createAdapter(): TestAdapter {
  return {
    raw: { name: 'fake' },
    layers: {} as LayerManager,
    camera,
    basemap,
    terrain,
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
});
