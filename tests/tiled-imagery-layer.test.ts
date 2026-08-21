import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  let providerSequence = 0;
  const tmsFromUrl = vi.fn();

  class TileMapServiceImageryProvider {
    readonly id = ++providerSequence;

    static fromUrl = tmsFromUrl;

    constructor(readonly options: Record<string, unknown> = {}) {}
  }

  class WebMapTileServiceImageryProvider {
    readonly id = ++providerSequence;

    constructor(readonly options: Record<string, unknown>) {}
  }

  return {
    TileMapServiceImageryProvider,
    WebMapTileServiceImageryProvider,
    tmsFromUrl,
    reset() {
      providerSequence = 0;
      tmsFromUrl.mockReset();
    },
  };
});

vi.mock('cesium', () => ({
  TileMapServiceImageryProvider: cesium.TileMapServiceImageryProvider,
  WebMapTileServiceImageryProvider: cesium.WebMapTileServiceImageryProvider,
}));

import { createTmsLayer, createWmtsLayer } from '../src/cesium/layers/tiled-imagery-layer.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

interface FakeImageryLayer {
  readonly provider: { readonly id: number; readonly options: Record<string, unknown> };
  show: boolean;
  alpha: number;
}

function createViewer() {
  const items: FakeImageryLayer[] = [];
  const addImageryProvider = vi.fn(
    (provider: FakeImageryLayer['provider'], index?: number): FakeImageryLayer => {
      const layer = { provider, show: true, alpha: 1 };
      items.splice(index ?? items.length, 0, layer);
      return layer;
    },
  );
  const remove = vi.fn((layer: FakeImageryLayer) => {
    const index = items.indexOf(layer);
    if (index >= 0) {
      items.splice(index, 1);
    }
    return index >= 0;
  });

  return {
    viewer: { imageryLayers: { addImageryProvider, remove } },
    items,
    addImageryProvider,
    remove,
  };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

describe('tiled imagery layers', () => {
  beforeEach(() => {
    cesium.reset();
  });

  it('loads TMS metadata asynchronously and applies visual state', async () => {
    const provider = new cesium.TileMapServiceImageryProvider({ fileExtension: 'jpg' });
    cesium.tmsFromUrl.mockResolvedValueOnce(provider);
    const view = createViewer();
    const { context } = createContext();

    const layer = await createTmsLayer(
      view.viewer as never,
      {
        id: 'terrain',
        type: 'tms',
        url: '  /tiles/terrain  ',
        fileExtension: 'jpg',
        maximumLevel: 12,
        tileWidth: 512,
        tileHeight: 256,
        flipXY: true,
        visible: false,
        opacity: 0.4,
      },
      context,
    );

    expect(cesium.tmsFromUrl).toHaveBeenCalledWith('/tiles/terrain', {
      fileExtension: 'jpg',
      maximumLevel: 12,
      tileWidth: 512,
      tileHeight: 256,
      flipXY: true,
    });
    expect(layer.type).toBe('tms');
    expect(layer.visible).toBe(false);
    expect(layer.opacity).toBe(0.4);
    expect(view.items[0]).toMatchObject({ show: false, alpha: 0.4, provider });
  });

  it('constructs WMTS with typed service identifiers and optional tile settings', async () => {
    const view = createViewer();
    const { context } = createContext();

    const layer = await createWmtsLayer(
      view.viewer as never,
      {
        id: 'imagery',
        type: 'wmts',
        url: ' /wmts ',
        layer: 'city:imagery',
        style: 'default',
        tileMatrixSetID: 'WebMercatorQuad',
        format: 'image/png',
        enablePickFeatures: false,
        minimumLevel: 1,
        maximumLevel: 16,
        tileMatrixLabels: ['0', '1', '2'],
        subdomains: ['a', 'b'],
        opacity: 0.65,
      },
      context,
    );

    expect(view.items[0]?.provider.options).toEqual({
      url: '/wmts',
      layer: 'city:imagery',
      style: 'default',
      tileMatrixSetID: 'WebMercatorQuad',
      format: 'image/png',
      enablePickFeatures: false,
      minimumLevel: 1,
      maximumLevel: 16,
      tileMatrixLabels: ['0', '1', '2'],
      subdomains: ['a', 'b'],
    });
    expect(layer.type).toBe('wmts');
    expect(layer.opacity).toBe(0.65);
  });

  it('updates opacity without rebuilding and releases its imagery layer once', async () => {
    cesium.tmsFromUrl.mockResolvedValueOnce(new cesium.TileMapServiceImageryProvider());
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createTmsLayer(
      view.viewer as never,
      { id: 'terrain', type: 'tms', url: '/tiles' },
      context,
    );

    layer.setOpacity(0.25);
    expect(layer.opacity).toBe(0.25);
    expect(view.items[0]?.alpha).toBe(0.25);
    expect(() => {
      layer.setOpacity(1.1);
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_OPACITY' }));

    await layer.dispose();
    await layer.dispose();
    expect(view.remove).toHaveBeenCalledOnce();
    expect(view.remove).toHaveBeenCalledWith(expect.anything(), true);
    expect(onDisposed).toHaveBeenCalledOnce();
  });

  it('rejects invalid configs and provider failures with structured errors', async () => {
    const view = createViewer();
    const { context } = createContext();

    await expect(
      createTmsLayer(view.viewer as never, { id: 'terrain', type: 'tms', url: ' ' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });
    await expect(
      createWmtsLayer(
        view.viewer as never,
        {
          id: 'imagery',
          type: 'wmts',
          url: '/wmts',
          layer: ' ',
          style: 'default',
          tileMatrixSetID: 'WebMercatorQuad',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });
    await expect(
      createWmtsLayer(
        view.viewer as never,
        {
          id: 'imagery',
          type: 'wmts',
          url: '/wmts',
          layer: 'imagery',
          style: 'default',
          tileMatrixSetID: 'WebMercatorQuad',
          maximumLevel: 2.5,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    cesium.tmsFromUrl.mockRejectedValueOnce(new Error('capabilities unavailable'));
    await expect(
      createTmsLayer(view.viewer as never, { id: 'terrain', type: 'tms', url: '/tiles' }, context),
    ).rejects.toMatchObject({ code: 'LAYER_LOAD_FAILED', retryable: true });
    expect(view.items).toEqual([]);
  });

  it('does not create or add a layer when already aborted or cancelled during TMS loading', async () => {
    const view = createViewer();
    const controller = new AbortController();
    controller.abort(new Error('route changed'));
    const aborted = createContext(controller.signal);
    await expect(
      createTmsLayer(
        view.viewer as never,
        { id: 'terrain', type: 'tms', url: '/tiles' },
        aborted.context,
      ),
    ).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    expect(cesium.tmsFromUrl).not.toHaveBeenCalled();

    let resolveProvider: ((provider: unknown) => void) | undefined;
    cesium.tmsFromUrl.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProvider = resolve;
      }),
    );
    const pendingController = new AbortController();
    const pending = createTmsLayer(
      view.viewer as never,
      { id: 'terrain', type: 'tms', url: '/tiles' },
      createContext(pendingController.signal).context,
    );
    pendingController.abort('cancelled');
    await expect(pending).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    resolveProvider?.(new cesium.TileMapServiceImageryProvider());
    await Promise.resolve();
    expect(view.items).toEqual([]);
  });
});
