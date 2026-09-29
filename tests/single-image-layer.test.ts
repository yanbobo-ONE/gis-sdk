import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const fromUrl = vi.fn();
  const fromDegrees = vi.fn((west: number, south: number, east: number, north: number) => ({
    west,
    south,
    east,
    north,
  }));
  const SingleTileImageryProvider = { fromUrl };
  return {
    SingleTileImageryProvider,
    Rectangle: { fromDegrees },
    fromDegrees,
    fromUrl,
    reset() {
      fromDegrees.mockClear();
      fromUrl.mockReset();
    },
  };
});

vi.mock('cesium', () => ({
  Rectangle: cesium.Rectangle,
  SingleTileImageryProvider: cesium.SingleTileImageryProvider,
}));

import { createSingleImageLayer } from '../src/cesium/layers/single-image-layer.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

function createViewer() {
  const items: { provider: unknown; show: boolean; alpha: number }[] = [];
  const addImageryProvider = vi.fn((provider: unknown) => {
    const layer = { provider, show: true, alpha: 1 };
    items.push(layer);
    return layer;
  });
  const remove = vi.fn((layer: (typeof items)[number]) => {
    const index = items.indexOf(layer);
    if (index >= 0) items.splice(index, 1);
    return index >= 0;
  });
  return { viewer: { imageryLayers: { addImageryProvider, remove } }, items, remove };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

describe('single image imagery layer', () => {
  beforeEach(() => {
    cesium.reset();
  });

  it('loads a geographic image with typed degree bounds and visual state', async () => {
    const provider = { kind: 'single-image' };
    cesium.fromUrl.mockResolvedValueOnce(provider);
    const view = createViewer();
    const { context } = createContext();

    const layer = await createSingleImageLayer(
      view.viewer as never,
      {
        id: 'survey',
        type: 'single-image',
        url: ' /images/survey.png ',
        rectangle: { west: 115, south: 39, east: 117, north: 41 },
        opacity: 0.6,
        visible: false,
      },
      context,
    );

    expect(cesium.fromDegrees).toHaveBeenCalledWith(115, 39, 117, 41);
    expect(cesium.fromUrl).toHaveBeenCalledWith('/images/survey.png', {
      rectangle: { west: 115, south: 39, east: 117, north: 41 },
    });
    expect(layer).toMatchObject({
      id: 'survey',
      type: 'single-image',
      visible: false,
      opacity: 0.6,
    });
    expect(view.items[0]).toMatchObject({ provider, show: false, alpha: 0.6 });
  });

  it('uses Cesium default global coverage when rectangle is omitted', async () => {
    cesium.fromUrl.mockResolvedValueOnce({ kind: 'global' });
    const view = createViewer();

    await createSingleImageLayer(
      view.viewer as never,
      { id: 'global', type: 'single-image', url: '/images/global.png' },
      createContext().context,
    );

    expect(cesium.fromDegrees).not.toHaveBeenCalled();
    expect(cesium.fromUrl).toHaveBeenCalledWith('/images/global.png', {});
  });

  it('updates opacity and releases the imagery layer once', async () => {
    cesium.fromUrl.mockResolvedValueOnce({ kind: 'image' });
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createSingleImageLayer(
      view.viewer as never,
      { id: 'image', type: 'single-image', url: '/images/a.png' },
      context,
    );

    layer.setOpacity(0.25);
    expect(view.items[0]?.alpha).toBe(0.25);
    expect(() => {
      layer.setOpacity(-0.1);
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_OPACITY' }));
    await layer.dispose();
    await layer.dispose();
    expect(view.remove).toHaveBeenCalledOnce();
    expect(onDisposed).toHaveBeenCalledOnce();
  });

  it('returns structured errors for invalid config, failed loading, and cancellation', async () => {
    const view = createViewer();
    await expect(
      createSingleImageLayer(
        view.viewer as never,
        {
          id: 'broken',
          type: 'single-image',
          url: ' ',
          rectangle: { west: 0, south: 0, east: 1, north: 1 },
        },
        createContext().context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });
    await expect(
      createSingleImageLayer(
        view.viewer as never,
        {
          id: 'broken',
          type: 'single-image',
          url: '/image.png',
          rectangle: { west: 0, south: 0, east: 0, north: 1 },
        },
        createContext().context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    cesium.fromUrl.mockRejectedValueOnce(new Error('network failed'));
    await expect(
      createSingleImageLayer(
        view.viewer as never,
        { id: 'failed', type: 'single-image', url: '/image.png' },
        createContext().context,
      ),
    ).rejects.toMatchObject({ code: 'LAYER_LOAD_FAILED', retryable: true });

    const controller = new AbortController();
    controller.abort('route changed');
    await expect(
      createSingleImageLayer(
        view.viewer as never,
        { id: 'aborted', type: 'single-image', url: '/image.png' },
        createContext(controller.signal).context,
      ),
    ).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    expect(cesium.fromUrl).toHaveBeenCalledTimes(1);
  });
});
