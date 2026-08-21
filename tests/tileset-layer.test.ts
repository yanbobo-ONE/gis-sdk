import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class FakeTileset {
    show = true;
    readonly destroy = vi.fn();

    constructor(readonly id: number) {}
  }

  let sequence = 0;
  const fromUrl = vi.fn(() => Promise.resolve(new FakeTileset(++sequence)));

  return {
    Cesium3DTileset: { fromUrl },
    FakeTileset,
    fromUrl,
    reset() {
      sequence = 0;
      fromUrl.mockReset();
      fromUrl.mockImplementation(() => Promise.resolve(new FakeTileset(++sequence)));
    },
  };
});

vi.mock('cesium', () => ({
  Cesium3DTileset: cesium.Cesium3DTileset,
}));

import { createTiles3dLayer } from '../src/cesium/layers/tileset-layer.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

type FakeTileset = InstanceType<typeof cesium.FakeTileset>;

function createViewer() {
  const items: FakeTileset[] = [];
  const add = vi.fn((tileset: FakeTileset) => {
    items.push(tileset);
    return tileset;
  });
  const remove = vi.fn((tileset: FakeTileset) => {
    const index = items.indexOf(tileset);
    if (index >= 0) {
      items.splice(index, 1);
    }
    return index >= 0;
  });

  return {
    viewer: { scene: { primitives: { add, remove } } },
    items,
    add,
    remove,
  };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

describe('createTiles3dLayer', () => {
  beforeEach(() => {
    cesium.reset();
  });

  it('loads a tileset with typed options and controls its visibility', async () => {
    const view = createViewer();
    const { context, onDisposed } = createContext();

    const layer = await createTiles3dLayer(
      view.viewer as never,
      {
        id: 'city',
        type: '3d-tiles',
        url: ' /tiles/city/tileset.json ',
        visible: false,
        maximumScreenSpaceError: 8,
        skipLevelOfDetail: true,
      },
      context,
    );

    expect(cesium.fromUrl).toHaveBeenCalledWith('/tiles/city/tileset.json', {
      maximumScreenSpaceError: 8,
      skipLevelOfDetail: true,
    });
    expect(layer.type).toBe('3d-tiles');
    expect(layer.state).toBe('hidden');
    expect(layer.visible).toBe(false);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.show).toBe(false);

    layer.setVisible(true);
    expect(layer.state).toBe('ready');
    expect(view.items[0]?.show).toBe(true);

    const tileset = view.items[0];
    await layer.dispose();
    expect(view.remove).toHaveBeenCalledWith(tileset);
    expect(onDisposed).toHaveBeenCalledOnce();
  });

  it('rejects invalid configuration before loading Cesium resources', async () => {
    const view = createViewer();
    const { context } = createContext();

    await expect(
      createTiles3dLayer(
        view.viewer as never,
        {
          id: 'city',
          type: '3d-tiles',
          url: '   ',
          maximumScreenSpaceError: 0,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
    expect(cesium.fromUrl).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean level-of-detail flag before loading Cesium resources', async () => {
    const view = createViewer();
    const { context } = createContext();

    await expect(
      createTiles3dLayer(
        view.viewer as never,
        {
          id: 'city',
          type: '3d-tiles',
          url: '/tiles/city/tileset.json',
          skipLevelOfDetail: 'enabled' as never,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation: 'add',
    });
    expect(cesium.fromUrl).not.toHaveBeenCalled();
  });

  it('wraps Cesium load failures as retryable layer errors', async () => {
    const view = createViewer();
    const { context } = createContext();
    cesium.fromUrl.mockRejectedValueOnce(new Error('tiles unavailable'));

    await expect(
      createTiles3dLayer(
        view.viewer as never,
        { id: 'city', type: '3d-tiles', url: '/tiles/city/tileset.json' },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation: 'add',
      retryable: true,
    });
    expect(view.add).not.toHaveBeenCalled();
  });

  it('rejects an already cancelled add without starting Cesium loading', async () => {
    const view = createViewer();
    const controller = new AbortController();
    controller.abort('route changed');
    const { context } = createContext(controller.signal);

    await expect(
      createTiles3dLayer(
        view.viewer as never,
        { id: 'city', type: '3d-tiles', url: '/tiles/city/tileset.json' },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'LAYER_OPERATION_ABORTED',
      operation: 'add',
    });
    expect(cesium.fromUrl).not.toHaveBeenCalled();
  });

  it('destroys a tileset that resolves after cancellation', async () => {
    const view = createViewer();
    const controller = new AbortController();
    const { context } = createContext(controller.signal);
    const lateTileset = new cesium.FakeTileset(1);
    let resolveTileset: ((tileset: FakeTileset) => void) | undefined;
    cesium.fromUrl.mockImplementationOnce(
      () =>
        new Promise<FakeTileset>((resolve) => {
          resolveTileset = resolve;
        }),
    );

    const adding = createTiles3dLayer(
      view.viewer as never,
      { id: 'city', type: '3d-tiles', url: '/tiles/city/tileset.json' },
      context,
    );
    await vi.waitFor(() => {
      expect(cesium.fromUrl).toHaveBeenCalledOnce();
    });

    controller.abort('route changed');
    await expect(adding).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    resolveTileset?.(lateTileset);

    await vi.waitFor(() => {
      expect(lateTileset.destroy).toHaveBeenCalledOnce();
    });
    expect(view.add).not.toHaveBeenCalled();
  });

  it('destroys directly when the primitive collection no longer owns the tileset', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createTiles3dLayer(
      view.viewer as never,
      { id: 'city', type: '3d-tiles', url: '/tiles/city/tileset.json' },
      context,
    );
    const tileset = view.items[0];
    view.remove.mockReturnValueOnce(false);

    await layer.dispose();

    expect(tileset?.destroy).toHaveBeenCalledOnce();
  });

  it('makes repeated disposal idempotent', async () => {
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createTiles3dLayer(
      view.viewer as never,
      { id: 'city', type: '3d-tiles', url: '/tiles/city/tileset.json' },
      context,
    );

    await Promise.all([layer.dispose(), layer.dispose()]);

    expect(view.remove).toHaveBeenCalledOnce();
    expect(onDisposed).toHaveBeenCalledOnce();
  });
});
