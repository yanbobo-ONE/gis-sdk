import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const listeners = new Set<(error: unknown) => void>();
  const providerErrorEvent = {
    addEventListener: (listener: (error: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (error: unknown) => {
      for (const listener of [...listeners]) listener(error);
    },
    listenerCount: () => listeners.size,
  };
  return {
    providerErrorEvent,
    listeners,
    SingleTileImageryProvider: { fromUrl: vi.fn() },
    UrlTemplateImageryProvider: class UrlTemplateImageryProvider {
      readonly errorEvent = providerErrorEvent;
      constructor(readonly options: Record<string, unknown>) {}
    },
  };
});

vi.mock('cesium', () => ({
  Rectangle: { fromDegrees: vi.fn() },
  SingleTileImageryProvider: cesium.SingleTileImageryProvider,
  UrlTemplateImageryProvider: cesium.UrlTemplateImageryProvider,
}));

import { CesiumBasemapController } from '../src/cesium/basemap-controller.js';
import { createSingleImageLayer } from '../src/cesium/layers/single-image-layer.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

function createImageryViewer() {
  const items: { provider: unknown; show: boolean; alpha: number; imageryProvider: unknown }[] = [];
  const addImageryProvider = vi.fn((provider: unknown) => {
    const layer = { provider, show: true, alpha: 1, imageryProvider: provider };
    items.push(layer);
    return layer;
  });
  const remove = vi.fn((layer: (typeof items)[number]) => {
    const index = items.indexOf(layer);
    if (index >= 0) items.splice(index, 1);
    return index >= 0;
  });
  return { viewer: { imageryLayers: { addImageryProvider, remove } }, items };
}

function createContext(): LayerFactoryContext {
  return { signal: new AbortController().signal, onDisposed: () => undefined };
}

describe('imagery error observability', () => {
  beforeEach(() => {
    cesium.listeners.clear();
    cesium.SingleTileImageryProvider.fromUrl.mockReset();
  });

  it('counts tile failures for a layer and emits a single error event', async () => {
    cesium.SingleTileImageryProvider.fromUrl.mockResolvedValueOnce({
      errorEvent: cesium.providerErrorEvent,
    });
    const view = createImageryViewer();

    const layer = await createSingleImageLayer(
      view.viewer as never,
      { id: 'survey', type: 'single-image', url: '/survey.png' },
      createContext(),
    );
    const errors: { id: string; error: { code: string; retryable: boolean } }[] = [];
    layer.events.on('error', (event) => {
      errors.push(event);
    });

    expect(layer.errorCount).toBe(0);
    expect(cesium.providerErrorEvent.listenerCount()).toBe(1);

    cesium.providerErrorEvent.emit(new Error('tile 1 failed'));
    cesium.providerErrorEvent.emit(new Error('tile 2 failed'));
    cesium.providerErrorEvent.emit(new Error('tile 3 failed'));

    expect(layer.errorCount).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      id: 'survey',
      error: { code: 'LAYER_LOAD_FAILED', retryable: true },
    });

    await layer.dispose();
    expect(cesium.providerErrorEvent.listenerCount()).toBe(0);
    cesium.providerErrorEvent.emit(new Error('after dispose'));
    expect(layer.errorCount).toBe(3);
  });

  it('counts basemap tile failures and reports only the first one to the map', () => {
    const view = createImageryViewer();
    const reporter = vi.fn();
    const controller = new CesiumBasemapController(view.viewer as never);
    controller.setErrorReporter(reporter);

    controller.set({ type: 'xyz', url: 'https://tiles.example.com/{z}/{x}/{y}.png' });
    expect(controller.errorCount).toBe(0);
    expect(cesium.providerErrorEvent.listenerCount()).toBe(1);

    cesium.providerErrorEvent.emit(new Error('tile 1 failed'));
    cesium.providerErrorEvent.emit(new Error('tile 2 failed'));

    expect(controller.errorCount).toBe(2);
    expect(reporter).toHaveBeenCalledOnce();
    expect(reporter.mock.calls[0]?.[0]).toMatchObject({
      code: 'BASEMAP_LOAD_FAILED',
      module: 'basemap',
      retryable: true,
    });

    // 替换底图先解除旧订阅，重新订阅同一 provider 后仍只有一个监听。
    controller.set({ type: 'xyz', url: 'https://tiles.example.com/{z}/{x}/{y}.png' });
    expect(cesium.providerErrorEvent.listenerCount()).toBe(1);

    controller.clear();
    expect(cesium.providerErrorEvent.listenerCount()).toBe(0);
    expect(controller.errorCount).toBe(2);
    expect(controller.type).toBe('none');

    cesium.providerErrorEvent.emit(new Error('after clear'));
    expect(reporter).toHaveBeenCalledOnce();
  });
});
