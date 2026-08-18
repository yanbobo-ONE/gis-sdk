import { describe, expect, it, vi } from 'vitest';

import { LayerHandleRuntime } from '../src/layers/layer-handle-runtime.js';
import {
  LayerRuntime,
  type LayerFactory,
  type LayerFactoryContext,
} from '../src/layers/layer-runtime.js';
import type {
  GeoJsonLayerSpec,
  LayerHandle,
  LayerSpec,
  WmsLayerSpec,
} from '../src/layers/contracts.js';

function geoJsonSpec(id: string): GeoJsonLayerSpec {
  return {
    id,
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [],
    },
  };
}

function wmsSpec(id: string): WmsLayerSpec {
  return {
    id,
    type: 'wms',
    url: 'https://maps.example/geoserver/wms',
    layers: ['workspace:targets'],
  };
}

interface FakeHandleOptions {
  readonly onSetVisible?: (visible: boolean) => void;
  readonly onDispose?: () => void | Promise<void>;
}

function createHandle(
  spec: LayerSpec,
  context: LayerFactoryContext,
  options: FakeHandleOptions = {},
): LayerHandle {
  return new LayerHandleRuntime({
    id: spec.id,
    type: spec.type,
    visible: spec.visible ?? true,
    onSetVisible: options.onSetVisible ?? (() => undefined),
    onDispose: options.onDispose ?? (() => undefined),
    onDisposed: context.onDisposed,
  });
}

function createFactory(options: FakeHandleOptions = {}): LayerFactory {
  return (spec, context) => Promise.resolve(createHandle(spec, context, options));
}

describe('LayerRuntime', () => {
  it('adds, lists, finds, hides, and directly disposes a managed layer', async () => {
    const onSetVisible = vi.fn<(visible: boolean) => void>();
    const onDispose = vi.fn<() => void>();
    const layers = new LayerRuntime(createFactory({ onSetVisible, onDispose }));

    const layer = await layers.add(geoJsonSpec('targets'));
    const states: string[] = [];
    layer.events.on('state:changed', ({ state }) => states.push(state));

    layer.setVisible(false);

    expect(layer.id).toBe('targets');
    expect(layer.type).toBe('geojson');
    expect(layer.visible).toBe(false);
    expect(layer.state).toBe('hidden');
    expect(onSetVisible).toHaveBeenCalledWith(false);
    expect(states).toEqual(['hidden']);
    expect(layers.get('targets')).toBe(layer);
    expect(layers.list()).toEqual([
      {
        id: 'targets',
        type: 'geojson',
        state: 'hidden',
        visible: false,
      },
    ]);

    await layer.dispose();
    await layer.dispose();

    expect(onDispose).toHaveBeenCalledOnce();
    expect(layer.state).toBe('disposed');
    expect(layers.get('targets')).toBeUndefined();
    expect(layers.list()).toEqual([]);
  });

  it('rejects invalid and concurrently duplicated ids with stable errors', async () => {
    let finishCreation: (() => void) | undefined;
    let pendingContext: LayerFactoryContext | undefined;
    const factory: LayerFactory = (spec, context) => {
      pendingContext = context;
      return new Promise((resolve) => {
        finishCreation = () => {
          resolve(createHandle(spec, context));
        };
      });
    };
    const layers = new LayerRuntime(factory);

    await expect(layers.add(geoJsonSpec('   '))).rejects.toMatchObject({
      code: 'INVALID_LAYER_ID',
      module: 'layer',
      operation: 'add',
    });

    const first = layers.add(geoJsonSpec('same-id'));
    await expect(layers.add(wmsSpec('same-id'))).rejects.toMatchObject({
      code: 'DUPLICATE_LAYER_ID',
      module: 'layer',
      operation: 'add',
    });

    expect(pendingContext).toBeDefined();
    finishCreation?.();
    await expect(first).resolves.toMatchObject({ id: 'same-id' });
  });

  it('propagates AbortSignal, rejects with a stable error, and releases the id', async () => {
    let attempts = 0;
    const factory: LayerFactory = (spec, context) => {
      attempts += 1;
      if (attempts > 1) {
        return Promise.resolve(createHandle(spec, context));
      }
      return new Promise((resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => {
            reject(new Error('creation aborted', { cause: context.signal.reason }));
          },
          { once: true },
        );
        if (context.signal.aborted) {
          reject(new Error('creation aborted', { cause: context.signal.reason }));
        }
      });
    };
    const layers = new LayerRuntime(factory);
    const controller = new AbortController();
    const adding = layers.add(geoJsonSpec('targets'), { signal: controller.signal });

    await Promise.resolve();
    controller.abort('route changed');

    await expect(adding).rejects.toMatchObject({
      code: 'LAYER_OPERATION_ABORTED',
      module: 'layer',
      operation: 'add',
    });
    await expect(layers.add(geoJsonSpec('targets'))).resolves.toMatchObject({ id: 'targets' });
    expect(layers.get('targets')?.id).toBe('targets');
  });

  it('removes active layers and aborts layers that are still loading', async () => {
    const factory: LayerFactory = (spec, context) => {
      if (spec.id === 'pending') {
        return new Promise((resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('creation aborted', { cause: context.signal.reason }));
            },
            { once: true },
          );
        });
      }
      return Promise.resolve(createHandle(spec, context));
    };
    const layers = new LayerRuntime(factory);
    await layers.add(geoJsonSpec('ready'));
    const pending = layers.add(geoJsonSpec('pending'));

    await expect(layers.remove('missing')).resolves.toBe(false);
    await expect(layers.remove('ready')).resolves.toBe(true);
    await expect(layers.remove('pending')).resolves.toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    expect(layers.list()).toEqual([]);
  });

  it('clears all layers and preserves failed handles for a retry', async () => {
    let failFirstDispose = true;
    const onDispose = vi.fn(() => {
      if (failFirstDispose) {
        failFirstDispose = false;
        throw new Error('temporary cleanup failure');
      }
    });
    const layers = new LayerRuntime(createFactory({ onDispose }));
    const first = await layers.add(geoJsonSpec('first'));
    await layers.add(wmsSpec('second'));

    await expect(layers.clear()).rejects.toMatchObject({
      code: 'LAYER_CLEAR_FAILED',
      module: 'layer',
      operation: 'clear',
    });
    expect(first.state).toBe('error');
    expect(layers.get('first')).toBe(first);
    expect(layers.get('second')).toBeUndefined();

    await expect(layers.clear()).resolves.toBeUndefined();
    expect(layers.list()).toEqual([]);
    expect(onDispose).toHaveBeenCalledTimes(3);
  });

  it('rejects additions while clear is in progress', async () => {
    let finishDispose: (() => void) | undefined;
    const layers = new LayerRuntime(
      createFactory({
        onDispose: () =>
          new Promise<void>((resolve) => {
            finishDispose = resolve;
          }),
      }),
    );
    await layers.add(geoJsonSpec('first'));

    const clearing = layers.clear();
    const concurrentClear = layers.clear();
    expect(concurrentClear).toBe(clearing);
    await expect(layers.add(wmsSpec('late'))).rejects.toMatchObject({
      code: 'LAYER_MANAGER_BUSY',
      module: 'layer',
      operation: 'add',
    });
    finishDispose?.();
    await clearing;
    expect(layers.list()).toEqual([]);
  });

  it('aborts pending additions during destroy and rejects future operations', async () => {
    const factory: LayerFactory = (spec, context) => {
      if (spec.id === 'pending') {
        return new Promise((resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('creation aborted', { cause: context.signal.reason }));
            },
            { once: true },
          );
        });
      }
      return Promise.resolve(createHandle(spec, context));
    };
    const layers = new LayerRuntime(factory);
    await layers.add(geoJsonSpec('ready'));
    const pending = layers.add(geoJsonSpec('pending'));

    await expect(layers.destroy()).resolves.toBeUndefined();
    await expect(pending).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    await expect(layers.destroy()).resolves.toBeUndefined();
    await expect(layers.add(geoJsonSpec('later'))).rejects.toMatchObject({
      code: 'LAYER_MANAGER_DISPOSED',
      module: 'layer',
      operation: 'add',
    });
  });

  it('keeps destroy retryable when layer cleanup fails', async () => {
    let failFirstDispose = true;
    const layers = new LayerRuntime(
      createFactory({
        onDispose: () => {
          if (failFirstDispose) {
            failFirstDispose = false;
            throw new Error('temporary cleanup failure');
          }
        },
      }),
    );
    await layers.add(geoJsonSpec('targets'));

    await expect(layers.destroy()).rejects.toMatchObject({ code: 'LAYER_CLEAR_FAILED' });
    await expect(layers.add(wmsSpec('imagery'))).resolves.toMatchObject({ id: 'imagery' });
    await expect(layers.destroy()).resolves.toBeUndefined();
  });
});
