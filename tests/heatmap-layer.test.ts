import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const fromDegrees = vi.fn((west: number, south: number, east: number, north: number) => ({
    west,
    south,
    east,
    north,
  }));

  class SingleTileImageryProvider {
    readonly options: Record<string, unknown>;
    readonly errorEvent = { addEventListener: vi.fn(() => () => undefined) };

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  }

  return {
    Rectangle: { fromDegrees },
    SingleTileImageryProvider,
    fromDegrees,
    reset() {
      fromDegrees.mockClear();
    },
  };
});

vi.mock('cesium', () => ({
  Rectangle: cesium.Rectangle,
  SingleTileImageryProvider: cesium.SingleTileImageryProvider,
}));

import { createHeatmapLayer } from '../src/cesium/layers/heatmap-layer.js';
import type { HeatmapRasterizer } from '../src/cesium/layers/heatmap-layer.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

const BEIJING = { longitude: 116.391, latitude: 39.907 };

function createViewer() {
  const items: {
    provider: InstanceType<typeof cesium.SingleTileImageryProvider>;
    show: boolean;
    alpha: number;
  }[] = [];
  const addImageryProvider = vi.fn(
    (provider: (typeof items)[number]['provider'], index?: number) => {
      const layer = { provider, show: true, alpha: 1 };
      if (index === undefined) {
        items.push(layer);
      } else {
        items.splice(index, 0, layer);
      }
      return layer;
    },
  );
  const remove = vi.fn((layer: (typeof items)[number]) => {
    const index = items.indexOf(layer);
    if (index >= 0) {
      items.splice(index, 1);
    }
    return index >= 0;
  });
  const indexOf = vi.fn((layer: (typeof items)[number]) => items.indexOf(layer));
  const imageryLayers = {
    addImageryProvider,
    remove,
    indexOf,
    get length() {
      return items.length;
    },
    add(layer: (typeof items)[number], index?: number) {
      items.splice(index ?? items.length, 0, layer);
    },
    raise(layer: (typeof items)[number]) {
      const index = items.indexOf(layer);
      if (index < 0 || index >= items.length - 1) {
        return;
      }
      items.splice(index, 1);
      items.splice(index + 1, 0, layer);
    },
    lower(layer: (typeof items)[number]) {
      const index = items.indexOf(layer);
      if (index <= 0) {
        return;
      }
      items.splice(index, 1);
      items.splice(index - 1, 0, layer);
    },
    raiseToTop(layer: (typeof items)[number]) {
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
    imageryLayers,
    remove,
  };
}

function createRasterizer() {
  const calls: { width: number; height: number; pixels: Uint8ClampedArray }[] = [];
  const rasterizer: HeatmapRasterizer = {
    toDataUrl(pixels, width, height) {
      calls.push({ width, height, pixels });
      return `data:image/png;base64,tile-${String(calls.length)}`;
    },
  };
  return { rasterizer, calls };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

describe('heatmap layer', () => {
  beforeEach(() => {
    cesium.reset();
  });

  it('rasterizes the density grid into a single imagery tile', async () => {
    const view = createViewer();
    const { rasterizer, calls } = createRasterizer();
    const { context } = createContext();

    const layer = await createHeatmapLayer(
      view.viewer as never,
      {
        id: 'density',
        type: 'heatmap',
        points: [BEIJING, { ...BEIJING, weight: 2 }],
        radiusMeters: 1_000,
        resolution: 32,
        opacity: 0.6,
        visible: false,
      },
      context,
      rasterizer,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.width).toBe(32);
    expect(calls[0]?.height).toBe(32);
    // 像素：RGBA，峰值附近有非零 alpha。
    expect(calls[0]?.pixels.length).toBe(32 * 32 * 4);
    expect(Math.max(...(calls[0]?.pixels ?? []))).toBeGreaterThan(0);

    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.provider.options.url).toBe('data:image/png;base64,tile-1');
    // 覆盖范围来自网格的 bounds，经 Rectangle.fromDegrees 转换。
    expect(cesium.fromDegrees).toHaveBeenCalled();
    expect(view.items[0]?.show).toBe(false);
    expect(view.items[0]?.alpha).toBeCloseTo(0.6, 6);
    expect(layer.pointCount).toBe(2);
    expect(layer.opacity).toBeCloseTo(0.6, 6);
    expect(layer.visible).toBe(false);
  });

  it('uses a transparent tile when there are no points', async () => {
    const view = createViewer();
    const { rasterizer, calls } = createRasterizer();
    const { context } = createContext();

    const layer = await createHeatmapLayer(
      view.viewer as never,
      { id: 'empty', type: 'heatmap', points: [] },
      context,
      rasterizer,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.width).toBe(1);
    expect(calls[0]?.pixels.every((value) => value === 0)).toBe(true);
    expect(layer.pointCount).toBe(0);
    expect(view.items).toHaveLength(1);
  });

  it('replaces the tile in place on setData and setStyle', async () => {
    const view = createViewer();
    const { rasterizer, calls } = createRasterizer();
    const { context } = createContext();

    const layer = await createHeatmapLayer(
      view.viewer as never,
      { id: 'density', type: 'heatmap', points: [BEIJING], resolution: 24, opacity: 0.5 },
      context,
      rasterizer,
    );
    const first = view.items[0];

    await layer.setData([BEIJING, { ...BEIJING, weight: 1.5 }]);
    expect(layer.pointCount).toBe(2);
    // 位置不变、状态继承：依旧只有一张影像，透明度与显隐沿用。
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).not.toBe(first);
    expect(view.items[0]?.alpha).toBeCloseTo(0.5, 6);
    expect(view.remove).toHaveBeenCalledWith(first, true);

    await layer.setStyle({ resolution: 48, radiusMeters: 2_000 });
    expect(calls[calls.length - 1]?.width).toBe(48);
    expect(layer.pointCount).toBe(2);
    expect(view.items).toHaveLength(1);
  });

  it('rejects concurrent replacement with a retryable LAYER_BUSY', async () => {
    const view = createViewer();
    const { rasterizer } = createRasterizer();
    const { context } = createContext();
    const layer = await createHeatmapLayer(
      view.viewer as never,
      { id: 'density', type: 'heatmap', points: [BEIJING] },
      context,
      rasterizer,
    );

    const first = layer.setData([BEIJING]);
    const second = layer.setData([BEIJING]);
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toMatchObject({ code: 'LAYER_BUSY', retryable: true });
    await expect(layer.setData([BEIJING])).resolves.toBeUndefined();
  });

  it('validates opacity, points, and grid parameters', async () => {
    const view = createViewer();
    const { rasterizer } = createRasterizer();
    const { context } = createContext();

    await expect(
      createHeatmapLayer(
        view.viewer as never,
        { id: 'x', type: 'heatmap', points: [BEIJING], opacity: 2 },
        context,
        rasterizer,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_OPACITY' });

    await expect(
      createHeatmapLayer(
        view.viewer as never,
        { id: 'x', type: 'heatmap', points: 'nope' as never },
        context,
        rasterizer,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    // 网格参数的数学校验来自 /core，进到图层这一层统一报 INVALID_LAYER_CONFIG。
    await expect(
      createHeatmapLayer(
        view.viewer as never,
        { id: 'x', type: 'heatmap', points: [BEIJING], radiusMeters: 0 },
        context,
        rasterizer,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    await expect(
      createHeatmapLayer(
        view.viewer as never,
        { id: 'x', type: 'heatmap', points: [BEIJING], resolution: 8 },
        context,
        rasterizer,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    expect(view.items).toHaveLength(0);
  });

  it('exposes imagery stacking and releases the layer on dispose', async () => {
    const view = createViewer();
    const { rasterizer } = createRasterizer();
    const { context, onDisposed } = createContext();
    const layer = await createHeatmapLayer(
      view.viewer as never,
      { id: 'density', type: 'heatmap', points: [BEIJING] },
      context,
      rasterizer,
    );

    expect(layer.stackIndex).toBe(0);
    expect(layer.raise()).toBe(false);
    expect(layer.lower()).toBe(false);
    expect(layer.raiseToTop()).toBe(false);

    layer.setOpacity(0.25);
    expect(view.items[0]?.alpha).toBeCloseTo(0.25, 6);
    expect(() => {
      layer.setOpacity(1.5);
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_OPACITY' }));

    layer.setVisible(false);
    expect(view.items[0]?.show).toBe(false);

    await layer.dispose();
    expect(view.items).toHaveLength(0);
    expect(onDisposed).toHaveBeenCalledTimes(1);
    // 与其它图层一致：已释放的句柄在同步校验处就抛错，而不是返回被拒绝的 Promise。
    expect(() => layer.setData([BEIJING])).toThrow(
      expect.objectContaining({ code: 'LAYER_DISPOSED' }),
    );
  });
});
