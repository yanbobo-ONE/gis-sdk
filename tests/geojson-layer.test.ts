import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  let sequence = 0;

  const load = vi.fn((data: unknown, options?: Record<string, unknown>) =>
    Promise.resolve({
      id: ++sequence,
      data,
      options,
      show: true,
      entities: { values: [{ id: `f-${String(sequence)}` }] },
    }),
  );

  const fromCssColorString = vi.fn((value: string) => {
    return value === 'invalid-color' ? undefined : { css: value };
  });

  return {
    Color: { fromCssColorString },
    GeoJsonDataSource: { load },
    load,
    reset() {
      sequence = 0;
      load.mockClear();
      fromCssColorString.mockClear();
    },
  };
});

vi.mock('cesium', () => ({
  Color: cesium.Color,
  GeoJsonDataSource: cesium.GeoJsonDataSource,
}));

import { createGeoJsonLayer } from '../src/cesium/layers/geojson-layer.js';
import { pickableEntityMarker } from '../src/cesium/layers/pickable-entities.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

interface FakeDataSource {
  readonly id: number;
  readonly entities: { values: { id: string }[] };
  show: boolean;
}

function createViewer() {
  const items: FakeDataSource[] = [];
  const operations: string[] = [];
  const add = vi.fn((dataSource: FakeDataSource) => {
    items.push(dataSource);
    operations.push(`add:${String(dataSource.id)}`);
    return Promise.resolve(dataSource);
  });
  const remove = vi.fn((dataSource: FakeDataSource) => {
    const index = items.indexOf(dataSource);
    if (index >= 0) {
      items.splice(index, 1);
    }
    operations.push(`remove:${String(dataSource.id)}`);
    return index >= 0;
  });

  return {
    viewer: { dataSources: { add, remove } },
    items,
    operations,
    add,
    remove,
  };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

function emptyGeoJson() {
  return {
    type: 'FeatureCollection' as const,
    features: [],
  };
}

describe('createGeoJsonLayer', () => {
  beforeEach(() => {
    cesium.reset();
    vi.unstubAllGlobals();
  });

  it('registers loaded features for picking under the layer id', async () => {
    const view = createViewer();
    const { context } = createContext();

    const layer = await createGeoJsonLayer(
      view.viewer as never,
      { id: 'targets', type: 'geojson', data: emptyGeoJson() },
      context,
    );

    expect(pickableEntityMarker(view.items[0]?.entities.values[0])).toEqual({
      layerId: 'targets',
      objectId: 'f-1',
    });

    // 替换数据后，新实体的归属跟随同一图层。
    await layer.setData(emptyGeoJson());
    expect(pickableEntityMarker(view.items[0]?.entities.values[0])).toEqual({
      layerId: 'targets',
      objectId: 'f-2',
    });
  });

  it('loads object data with converted stable styles and initial visibility', async () => {
    const view = createViewer();
    const { context } = createContext();

    const layer = await createGeoJsonLayer(
      view.viewer as never,
      {
        id: 'targets',
        type: 'geojson',
        data: emptyGeoJson(),
        visible: false,
        style: {
          marker: { color: '#00ff00', size: 18, symbol: 'airport' },
          stroke: '#ffffff',
          strokeWidth: 3,
          fill: '#0088ff66',
          clampToGround: true,
        },
      },
      context,
    );

    expect(cesium.load).toHaveBeenCalledWith(emptyGeoJson(), {
      markerColor: { css: '#00ff00' },
      markerSize: 18,
      markerSymbol: 'airport',
      stroke: { css: '#ffffff' },
      strokeWidth: 3,
      fill: { css: '#0088ff66' },
      clampToGround: true,
    });
    expect(layer.type).toBe('geojson');
    expect(layer.visible).toBe(false);
    expect(layer.state).toBe('hidden');
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.show).toBe(false);
  });

  it('fetches URL data with AbortSignal before handing JSON to Cesium', async () => {
    const view = createViewer();
    const { context } = createContext();
    const data = emptyGeoJson();
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(data),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createGeoJsonLayer(
      view.viewer as never,
      { id: 'remote', type: 'geojson', data: '/data/targets.geojson' },
      context,
    );

    expect(fetchMock).toHaveBeenCalledWith('/data/targets.geojson', {
      signal: context.signal,
    });
    expect(cesium.load).toHaveBeenCalledWith(data, {});
  });

  it('atomically replaces data by adding the new source before removing the old one', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createGeoJsonLayer(
      view.viewer as never,
      { id: 'targets', type: 'geojson', data: emptyGeoJson() },
      context,
    );
    view.operations.splice(0);

    await layer.setData({
      type: 'Feature',
      properties: { name: 'updated' },
      geometry: { type: 'Point', coordinates: [120, 30] },
    });

    expect(view.operations).toEqual(['add:2', 'remove:1']);
    expect(view.items.map((item) => item.id)).toEqual([2]);
    expect(layer.state).toBe('ready');
  });

  it('keeps the previous data when replacement loading fails', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createGeoJsonLayer(
      view.viewer as never,
      { id: 'targets', type: 'geojson', data: emptyGeoJson() },
      context,
    );
    cesium.load.mockRejectedValueOnce(new Error('invalid geojson'));

    await expect(layer.setData(emptyGeoJson())).rejects.toMatchObject({
      code: 'LAYER_LOAD_FAILED',
      module: 'layer',
      operation: 'setData',
    });
    expect(view.items.map((item) => item.id)).toEqual([1]);
    expect(layer.state).toBe('error');
  });

  it('aborts an in-flight URL replacement without removing the current data', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createGeoJsonLayer(
      view.viewer as never,
      { id: 'targets', type: 'geojson', data: emptyGeoJson() },
      context,
    );
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(new Error('request aborted', { cause: options.signal.reason }));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const states: string[] = [];
    layer.events.on('state:changed', (event) => {
      states.push(event.state);
    });
    const replacing = layer.setData('/data/slow.geojson', { signal: controller.signal });
    controller.abort('route changed');

    await expect(replacing).rejects.toMatchObject({
      code: 'LAYER_OPERATION_ABORTED',
      operation: 'setData',
    });
    expect(view.items.map((item) => item.id)).toEqual([1]);
    expect(layer.state).toBe('ready');
    expect(states).not.toContain('error');
  });

  it('removes a replacement data source when Cesium finishes adding it after cancellation', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createGeoJsonLayer(
      view.viewer as never,
      { id: 'targets', type: 'geojson', data: emptyGeoJson() },
      context,
    );
    let finishLateAdd: (() => void) | undefined;
    view.add.mockImplementationOnce(
      (dataSource: FakeDataSource) =>
        new Promise((resolve) => {
          finishLateAdd = () => {
            view.items.push(dataSource);
            view.operations.push(`add:${String(dataSource.id)}`);
            resolve(dataSource);
          };
        }),
    );
    const controller = new AbortController();
    const replacing = layer.setData(emptyGeoJson(), { signal: controller.signal });
    await vi.waitFor(() => {
      expect(view.add).toHaveBeenCalledTimes(2);
    });

    controller.abort(new Error('route changed'));
    await expect(replacing).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    finishLateAdd?.();
    await vi.waitFor(() => {
      expect(view.items.map((item) => item.id)).toEqual([1]);
    });
    expect(view.operations).toContain('remove:2');
  });

  it('rejects invalid stable style values before creating Cesium data', async () => {
    const view = createViewer();
    const { context } = createContext();

    await expect(
      createGeoJsonLayer(
        view.viewer as never,
        {
          id: 'targets',
          type: 'geojson',
          data: emptyGeoJson(),
          style: { fill: 'invalid-color' },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_LAYER_STYLE',
      module: 'layer',
      operation: 'add',
    });
    expect(cesium.load).not.toHaveBeenCalled();
    expect(view.items).toEqual([]);
  });

  it('updates visibility and disposes the active data source exactly once', async () => {
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createGeoJsonLayer(
      view.viewer as never,
      { id: 'targets', type: 'geojson', data: emptyGeoJson() },
      context,
    );

    layer.setVisible(false);
    expect(view.items[0]?.show).toBe(false);

    await layer.dispose();
    await layer.dispose();

    expect(view.remove).toHaveBeenCalledOnce();
    expect(onDisposed).toHaveBeenCalledOnce();
    expect(view.items).toEqual([]);
  });
});
