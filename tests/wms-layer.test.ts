import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  let providerSequence = 0;

  class WebMapServiceImageryProvider {
    readonly id = ++providerSequence;

    constructor(readonly options: Record<string, unknown>) {}
  }

  return {
    WebMapServiceImageryProvider,
    reset() {
      providerSequence = 0;
    },
  };
});

vi.mock('cesium', () => ({
  Resource: class Resource {
    constructor(
      readonly options: { readonly url: string; readonly headers?: Record<string, string> },
    ) {}
  },
  WebMapServiceImageryProvider: cesium.WebMapServiceImageryProvider,
}));

import { createWmsLayer } from '../src/cesium/layers/wms-layer.js';
import { wmsFilter } from '../src/cesium/layers/wms-filter.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

interface FakeImageryLayer {
  readonly provider: InstanceType<typeof cesium.WebMapServiceImageryProvider>;
  show: boolean;
  alpha: number;
}

function createViewer() {
  const items: FakeImageryLayer[] = [];
  const operations: string[] = [];
  const addImageryProvider = vi.fn(
    (provider: InstanceType<typeof cesium.WebMapServiceImageryProvider>, index?: number) => {
      const layer = { provider, show: true, alpha: 1 };
      items.splice(index ?? items.length, 0, layer);
      operations.push(`add:${String(provider.id)}:${String(index ?? items.length - 1)}`);
      return layer;
    },
  );
  const remove = vi.fn((layer: FakeImageryLayer, destroy: boolean) => {
    const index = items.indexOf(layer);
    if (index >= 0) {
      items.splice(index, 1);
    }
    operations.push(`remove:${String(layer.provider.id)}:${String(destroy)}`);
    return index >= 0;
  });
  const indexOf = vi.fn((layer: FakeImageryLayer) => items.indexOf(layer));
  // 堆叠顺序要的那几个集合方法：按 Cesium 语义在同一个 items 数组上换位。
  const imageryLayers = {
    addImageryProvider,
    remove,
    indexOf,
    get length() {
      return items.length;
    },
    add(layer: FakeImageryLayer, index?: number) {
      items.splice(index ?? items.length, 0, layer);
    },
    raise(layer: FakeImageryLayer) {
      const index = items.indexOf(layer);
      if (index < 0 || index >= items.length - 1) {
        return;
      }
      items.splice(index, 1);
      items.splice(index + 1, 0, layer);
    },
    lower(layer: FakeImageryLayer) {
      const index = items.indexOf(layer);
      if (index <= 0) {
        return;
      }
      items.splice(index, 1);
      items.splice(index - 1, 0, layer);
    },
    raiseToTop(layer: FakeImageryLayer) {
      const index = items.indexOf(layer);
      if (index < 0) {
        return;
      }
      items.splice(index, 1);
      items.push(layer);
    },
  };

  return {
    viewer: { imageryLayers },
    items,
    operations,
    addImageryProvider,
    remove,
    imageryLayers,
  };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

describe('createWmsLayer', () => {
  beforeEach(() => {
    cesium.reset();
  });

  it('creates a provider with typed style/filter and applies visual state', async () => {
    const view = createViewer();
    const { context } = createContext();

    const layer = await createWmsLayer(
      view.viewer as never,
      {
        id: 'roads',
        type: 'wms',
        url: 'https://maps.example/geoserver/wms',
        layers: ['city:roads', 'city:labels'],
        visible: false,
        opacity: 0.45,
        style: 'night',
        filter: wmsFilter.eq('status', 'OPEN'),
        parameters: { transparent: true, format: 'image/png', tiled: true },
      },
      context,
    );

    expect(view.addImageryProvider).toHaveBeenCalledOnce();
    expect(view.items[0]?.provider.options).toEqual({
      url: 'https://maps.example/geoserver/wms',
      layers: 'city:roads,city:labels',
      parameters: {
        transparent: true,
        format: 'image/png',
        tiled: true,
        styles: 'night',
        cql_filter: "status = 'OPEN'",
      },
    });
    expect(layer.type).toBe('wms');
    expect(layer.visible).toBe(false);
    expect(layer.opacity).toBe(0.45);
    expect(layer.state).toBe('hidden');
    expect(view.items[0]).toMatchObject({ show: false, alpha: 0.45 });
  });

  it('replaces providers atomically while preserving index, visibility, and opacity', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createWmsLayer(
      view.viewer as never,
      {
        id: 'roads',
        type: 'wms',
        url: '/geoserver/wms',
        layers: 'city:roads',
        opacity: 0.6,
      },
      context,
    );
    layer.setVisible(false);
    view.operations.splice(0);

    await layer.setStyle('night');
    await layer.setFilter(wmsFilter.gte('priority', 3));
    await layer.reload();

    expect(view.operations).toEqual([
      'add:2:0',
      'remove:1:true',
      'add:3:0',
      'remove:2:true',
      'add:4:0',
      'remove:3:true',
    ]);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ show: false, alpha: 0.6 });
    expect(view.items[0]?.provider.options).toMatchObject({
      parameters: { styles: 'night', cql_filter: 'priority >= 3' },
    });
  });

  it('updates opacity without rebuilding the provider and validates its range', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createWmsLayer(
      view.viewer as never,
      { id: 'roads', type: 'wms', url: '/wms', layers: 'roads' },
      context,
    );

    layer.setOpacity(0.25);

    expect(layer.opacity).toBe(0.25);
    expect(view.items[0]?.alpha).toBe(0.25);
    expect(view.addImageryProvider).toHaveBeenCalledOnce();
    expect(() => {
      layer.setOpacity(1.5);
    }).toThrow(
      expect.objectContaining({
        code: 'INVALID_LAYER_OPACITY',
        operation: 'setOpacity',
      }),
    );
  });

  it('rejects invalid config, reserved raw parameters, and an already aborted add', async () => {
    const view = createViewer();
    const { context } = createContext();
    await expect(
      createWmsLayer(
        view.viewer as never,
        { id: 'roads', type: 'wms', url: '   ', layers: [] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    await expect(
      createWmsLayer(
        view.viewer as never,
        {
          id: 'roads',
          type: 'wms',
          url: '/wms',
          layers: 'roads',
          parameters: { cql_filter: 'unsafe raw expression' },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_WMS_PARAMETERS' });

    const controller = new AbortController();
    controller.abort(new Error('route changed'));
    const abortedContext = createContext(controller.signal);
    await expect(
      createWmsLayer(
        view.viewer as never,
        { id: 'roads', type: 'wms', url: '/wms', layers: 'roads' },
        abortedContext.context,
      ),
    ).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED', operation: 'add' });
    expect(view.items).toEqual([]);
  });

  it('disposes the current imagery layer once', async () => {
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createWmsLayer(
      view.viewer as never,
      { id: 'roads', type: 'wms', url: '/wms', layers: 'roads' },
      context,
    );

    await layer.dispose();
    await layer.dispose();

    expect(view.remove).toHaveBeenCalledOnce();
    expect(view.remove).toHaveBeenCalledWith(expect.anything(), true);
    expect(onDisposed).toHaveBeenCalledOnce();
    expect(view.items).toEqual([]);
  });

  it('passes custom headers through a Resource', async () => {
    const view = createViewer();
    const { context } = createContext();

    await createWmsLayer(
      view.viewer as never,
      {
        id: 'secure',
        type: 'wms',
        url: 'https://example.com/wms',
        layers: 'demo:coverage',
        headers: { Authorization: 'Bearer token' },
      },
      context,
    );

    const url = view.items[0]?.provider.options.url as
      { options?: { headers?: unknown } } | undefined;
    expect(url).toBeInstanceOf((await import('cesium')).Resource);
    expect(url?.options?.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('rejects an invalid header name before creating a provider', async () => {
    const view = createViewer();
    const { context } = createContext();

    // WMS 图层的校验失败走 Promise 拒绝（与其余非法配置一致）。
    await expect(
      createWmsLayer(
        view.viewer as never,
        {
          id: 'secure',
          type: 'wms',
          url: 'https://example.com/wms',
          layers: 'demo:coverage',
          headers: { 'Bad Header': 'x' },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });
    expect(view.items).toHaveLength(0);
  });

  it('exposes imagery stacking on the handle', async () => {
    const view = createViewer();
    const { context } = createContext();
    const spec = {
      type: 'wms' as const,
      url: 'https://example.com/wms',
      layers: 'demo:coverage',
    };

    const first = await createWmsLayer(view.viewer as never, { ...spec, id: 'first' }, context);
    const second = await createWmsLayer(view.viewer as never, { ...spec, id: 'second' }, context);

    // 没有底图时下限是 0：两个业务图层依次落在 0 / 1。
    expect(first.stackIndex).toBe(0);
    expect(second.stackIndex).toBe(1);

    // 句柄把操作转给影像集合：换序后两者互换，读数跟着变。
    expect(first.raiseToTop()).toBe(true);
    expect(first.stackIndex).toBe(1);
    expect(second.stackIndex).toBe(0);
    expect(first.raiseToTop()).toBe(false);
    expect(first.lowerToBottom()).toBe(true);
    expect(first.stackIndex).toBe(0);

    // 释放之后不再报告序号，并且顺序操作被生命周期拦住。
    await second.dispose();
    expect(second.stackIndex).toBeUndefined();
    expect(() => {
      second.raise();
    }).toThrow(expect.objectContaining({ code: 'LAYER_DISPOSED' }));
  });
});
