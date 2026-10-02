import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  let sequence = 0;
  const load = vi.fn((data: unknown) => {
    const loadId = ++sequence;
    return Promise.resolve({
      id: loadId,
      data,
      show: true,
      // 实体带加载序号，替换文档后可与上一次的实体区分开。
      entities: {
        values: [1, 2, 3].map((index) => ({ id: `sat-${String(loadId)}-${String(index)}` })),
      },
    });
  });
  return {
    CzmlDataSource: { load },
    load,
    reset() {
      sequence = 0;
      load.mockClear();
    },
  };
});

vi.mock('cesium', () => ({ CzmlDataSource: cesium.CzmlDataSource }));

import { createCzmlLayer } from '../src/cesium/layers/czml-layer.js';
import { pickableEntityMarker } from '../src/cesium/layers/pickable-entities.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

interface FakeDataSource {
  readonly id: number;
  show: boolean;
  readonly entities: { values: { id: string }[] };
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
  return { viewer: { dataSources: { add, remove } }, items, operations, add, remove };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

const document = [
  { id: 'document', version: '1.0' },
  { id: 'sat-1', position: { cartographicDegrees: [0, 116.39, 39.9, 500_000] } },
];

describe('createCzmlLayer', () => {
  beforeEach(() => {
    cesium.reset();
    vi.unstubAllGlobals();
  });

  it('loads a document array and reports the entity count', async () => {
    const view = createViewer();
    const { context } = createContext();

    const layer = await createCzmlLayer(
      view.viewer as never,
      { id: 'satellites', type: 'czml', data: document, visible: false },
      context,
    );

    expect(cesium.load).toHaveBeenCalledWith(document);
    expect(layer.type).toBe('czml');
    expect(layer.visible).toBe(false);
    expect(layer.state).toBe('hidden');
    expect(layer.entityCount).toBe(3);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.show).toBe(false);

    layer.setVisible(true);
    expect(layer.state).toBe('ready');
    expect(view.items[0]?.show).toBe(true);
  });

  it('registers loaded entities for picking under the layer id', async () => {
    const view = createViewer();
    const { context } = createContext();

    const layer = await createCzmlLayer(
      view.viewer as never,
      { id: 'satellites', type: 'czml', data: document },
      context,
    );

    expect(pickableEntityMarker(view.items[0]?.entities.values[0])).toEqual({
      layerId: 'satellites',
      objectId: 'sat-1-1',
    });

    // 替换文档后，新文档的实体同样归属该图层。
    await layer.setData([{ id: 'document', version: '1.0' }, { id: 'sat-9' }]);
    expect(pickableEntityMarker(view.items[0]?.entities.values[0])).toEqual({
      layerId: 'satellites',
      objectId: 'sat-2-1',
    });
  });

  it('exposes the document clock and follows setData', async () => {
    const view = createViewer();
    const { context } = createContext();
    const withClock = [
      {
        id: 'document',
        version: '1.0',
        clock: {
          interval: '2026-09-30T00:00:00Z/2026-09-30T06:00:00Z',
          currentTime: '2026-09-30T01:00:00Z',
        },
      },
      { id: 'sat-1', position: { cartographicDegrees: [0, 116.39, 39.9, 500_000] } },
    ];

    const layer = await createCzmlLayer(
      view.viewer as never,
      { id: 'satellites', type: 'czml', data: withClock },
      context,
    );

    // 文档自带 clock 的读数（毫秒时间戳）；SDK 不自动应用它，只把它交出来。
    expect(layer.clock).toEqual({
      startTime: Date.parse('2026-09-30T00:00:00Z'),
      endTime: Date.parse('2026-09-30T06:00:00Z'),
      currentTime: Date.parse('2026-09-30T01:00:00Z'),
    });

    // 换成不带 clock 的文档：读数跟着消失，不保留上一份文档的值。
    await layer.setData(document);
    expect(layer.clock).toBeUndefined();
  });

  it('fetches a URL before handing data to Cesium', async () => {
    const view = createViewer();
    const { context } = createContext();
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(document) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createCzmlLayer(
      view.viewer as never,
      { id: 'satellites', type: 'czml', data: '/data/satellites.czml' },
      context,
    );

    expect(fetchMock).toHaveBeenCalledWith('/data/satellites.czml', {
      signal: context.signal,
    });
    expect(cesium.load).toHaveBeenCalledWith(document);
  });

  it('replaces the document atomically and keeps the old one on abort', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createCzmlLayer(
      view.viewer as never,
      { id: 'satellites', type: 'czml', data: document },
      context,
    );
    const first = view.items[0];

    await layer.setData([...document, { id: 'sat-2' }]);

    expect(view.items).toHaveLength(1);
    expect(view.items[0]).not.toBe(first);
    expect(layer.state).toBe('ready');

    const controller = new AbortController();
    const pending = layer.setData(document, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    // 取消后旧文档仍然生效，图层不进入错误态。
    expect(layer.state).toBe('ready');
    expect(view.items).toHaveLength(1);
  });

  it('rejects concurrent replacement and reports load failures', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createCzmlLayer(
      view.viewer as never,
      { id: 'satellites', type: 'czml', data: document },
      context,
    );

    const first = layer.setData(document);
    await expect(layer.setData(document)).rejects.toMatchObject({ code: 'LAYER_BUSY' });
    await first;

    cesium.load.mockRejectedValueOnce(new Error('broken document'));
    await expect(layer.setData(document)).rejects.toMatchObject({
      code: 'LAYER_LOAD_FAILED',
      retryable: true,
    });
    expect(layer.state).toBe('error');
  });

  it('removes the data source on dispose and reports it once', async () => {
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createCzmlLayer(
      view.viewer as never,
      { id: 'satellites', type: 'czml', data: document },
      context,
    );

    await layer.dispose();
    await layer.dispose();

    expect(view.items).toHaveLength(0);
    expect(onDisposed).toHaveBeenCalledTimes(1);
    expect(layer.state).toBe('disposed');
    expect(() => {
      layer.setVisible(true);
    }).toThrow(expect.objectContaining({ code: 'LAYER_DISPOSED' }));
  });

  it('rejects an empty or non-array source', async () => {
    const view = createViewer();
    const { context } = createContext();

    await expect(
      createCzmlLayer(view.viewer as never, { id: 'x', type: 'czml', data: '   ' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });
  });
});
