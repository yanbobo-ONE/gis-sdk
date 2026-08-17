import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { MapEngineAdapter, MapEventMap } from '../src/core/contracts.js';
import { GisError } from '../src/core/errors.js';
import { MapRuntime } from '../src/core/map-runtime.js';

interface RawContext {
  readonly name: string;
}

interface TestAdapter extends MapEngineAdapter<RawContext> {
  resize: Mock<() => void>;
  destroy: Mock<() => void | Promise<void>>;
}

function createAdapter(): TestAdapter {
  return {
    raw: { name: 'fake' },
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
  });

  it('delegates resize while ready', () => {
    const adapter = createAdapter();
    const map = new MapRuntime('map-1', adapter);

    map.resize();

    expect(adapter.resize).toHaveBeenCalledOnce();
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
});
