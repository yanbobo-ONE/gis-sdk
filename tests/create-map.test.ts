import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import type { MapEngineAdapter } from '../src/core/contracts.js';
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

function createFactory() {
  let receivedOptions: NormalizedCreateMapOptions | undefined;
  const adapter: FakeAdapter = {
    raw: { viewer: { kind: 'fake' } },
    layers: {} as LayerManager,
    resize: vi.fn(),
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
});
