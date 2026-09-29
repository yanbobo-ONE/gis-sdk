import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class FakePointPrimitiveCollection {
    show = true;
    readonly points: Record<string, unknown>[] = [];
    readonly destroy = vi.fn();

    get length(): number {
      return this.points.length;
    }

    add(options: Record<string, unknown>): Record<string, unknown> {
      const primitive = { ...options };
      this.points.push(primitive);
      return primitive;
    }

    get(index: number): Record<string, unknown> | undefined {
      return this.points[index];
    }
  }

  const fromDegrees = vi.fn((longitude: number, latitude: number, height: number) => ({
    longitude,
    latitude,
    height,
  }));

  return {
    Cartesian3: { fromDegrees },
    Color: {
      WHITE: { css: 'white' },
      fromCssColorString: vi.fn((value: string) =>
        value === 'invalid-color' ? undefined : { css: value },
      ),
    },
    PointPrimitiveCollection: FakePointPrimitiveCollection,
    FakePointPrimitiveCollection,
    fromDegrees,
  };
});

vi.mock('cesium', () => ({
  Cartesian3: cesium.Cartesian3,
  Color: cesium.Color,
  PointPrimitiveCollection: cesium.PointPrimitiveCollection,
}));

import { createPointsLayer } from '../src/cesium/layers/points-layer.js';
import { MAX_POINT_LAYER_POINTS } from '../src/layers/contracts.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

type FakeCollection = InstanceType<typeof cesium.FakePointPrimitiveCollection>;

function createViewer() {
  const items: FakeCollection[] = [];
  const operations: string[] = [];
  const add = vi.fn((collection: FakeCollection) => {
    items.push(collection);
    operations.push(`add:${String(items.indexOf(collection))}`);
    return collection;
  });
  const remove = vi.fn((collection: FakeCollection) => {
    const index = items.indexOf(collection);
    if (index < 0) {
      return false;
    }
    items.splice(index, 1);
    operations.push('remove');
    return true;
  });
  return { viewer: { scene: { primitives: { add, remove } } }, items, operations, add, remove };
}

function createContext(signal = new AbortController().signal) {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal, onDisposed };
  return { context, onDisposed };
}

describe('points layer', () => {
  beforeEach(() => {
    cesium.fromDegrees.mockClear();
    cesium.Color.fromCssColorString.mockClear();
  });

  it('renders points with layer defaults and per-point overrides', async () => {
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createPointsLayer(
      view.viewer as never,
      {
        id: 'targets',
        type: 'points',
        pixelSize: 12,
        outlineWidth: 2,
        points: [
          { longitude: 116.39, latitude: 39.9, height: 100 },
          { longitude: 121.47, latitude: 31.23, color: '#ff0000', pixelSize: 20 },
        ],
      },
      context,
    );

    expect(cesium.fromDegrees).toHaveBeenCalledWith(116.39, 39.9, 100);
    expect(cesium.fromDegrees).toHaveBeenCalledWith(121.47, 31.23, 0);
    const collection = view.items[0];
    expect(collection?.points).toEqual([
      {
        position: { longitude: 116.39, latitude: 39.9, height: 100 },
        color: { css: '#43bfeb' },
        pixelSize: 12,
        outlineWidth: 2,
        outlineColor: { css: '#43bfeb' },
        // 拾取标记：没有业务 id 时只标记图层。
        id: { layerId: 'targets' },
      },
      {
        position: { longitude: 121.47, latitude: 31.23, height: 0 },
        color: { css: '#ff0000' },
        pixelSize: 20,
        outlineWidth: 2,
        outlineColor: { css: '#43bfeb' },
        id: { layerId: 'targets' },
      },
    ]);
    expect(layer).toMatchObject({ id: 'targets', type: 'points', count: 2, visible: true });

    layer.setVisible(false);
    expect(collection?.show).toBe(false);

    await layer.dispose();
    expect(view.remove).toHaveBeenCalledOnce();
    expect(onDisposed).toHaveBeenCalledOnce();
  });

  it('replaces points atomically and keeps the previous set when cancelled', async () => {
    const view = createViewer();
    const layer = await createPointsLayer(
      view.viewer as never,
      {
        id: 'targets',
        type: 'points',
        points: [{ longitude: 0, latitude: 0 }],
      },
      createContext().context,
    );
    const original = view.items[0];

    view.operations.length = 0;
    await layer.setData([
      { longitude: 1, latitude: 1 },
      { longitude: 2, latitude: 2 },
    ]);

    expect(layer.count).toBe(2);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).not.toBe(original);
    expect(original?.destroy).not.toHaveBeenCalled();
    // 先加入新集合再移除旧集合，替换过程中不出现空白帧。
    expect(view.operations).toEqual(['add:1', 'remove']);

    const controller = new AbortController();
    controller.abort('route changed');
    await expect(
      layer.setData([{ longitude: 3, latitude: 3 }], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    expect(layer.count).toBe(2);
    expect(layer.state).toBe('ready');

    await layer.dispose();
  });

  it('rejects a concurrent replacement with LAYER_BUSY', async () => {
    const view = createViewer();
    const layer = await createPointsLayer(
      view.viewer as never,
      { id: 'targets', type: 'points', points: [{ longitude: 0, latitude: 0 }] },
      createContext().context,
    );

    const first = layer.setData([{ longitude: 1, latitude: 1 }]);
    await expect(layer.setData([{ longitude: 2, latitude: 2 }])).rejects.toMatchObject({
      code: 'LAYER_BUSY',
      retryable: true,
    });
    await first;
    expect(layer.count).toBe(1);

    await layer.dispose();
  });

  it('applies style changes to every existing point', async () => {
    const view = createViewer();
    const layer = await createPointsLayer(
      view.viewer as never,
      {
        id: 'targets',
        type: 'points',
        points: [
          { longitude: 0, latitude: 0 },
          { longitude: 1, latitude: 1 },
        ],
      },
      createContext().context,
    );

    layer.setStyle({ color: '#00ff00', pixelSize: 16 });
    const collection = view.items[0];
    expect(collection?.points[0]).toMatchObject({ color: { css: '#00ff00' }, pixelSize: 16 });
    expect(collection?.points[1]).toMatchObject({ color: { css: '#00ff00' }, pixelSize: 16 });

    // 只改一项时其余样式保持。
    layer.setStyle({ outlineWidth: 3 });
    expect(collection?.points[0]).toMatchObject({
      color: { css: '#00ff00' },
      pixelSize: 16,
      outlineWidth: 3,
    });

    expect(() => {
      layer.setStyle({ pixelSize: 1 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }));
    expect(() => {
      layer.setStyle({ outlineWidth: 99 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }));
    expect(() => {
      layer.setStyle({ color: 'invalid-color' });
    }).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_COLOR' }));

    await layer.dispose();
  });

  it('rejects invalid configuration before creating primitives', () => {
    const view = createViewer();
    const context = createContext().context;
    const cases: readonly [Parameters<typeof createPointsLayer>[1], string][] = [
      [
        { id: 'bad', type: 'points', points: [{ longitude: 181, latitude: 0 }] },
        'INVALID_LAYER_CONFIG',
      ],
      [
        { id: 'bad', type: 'points', points: [{ longitude: 0, latitude: 91 }] },
        'INVALID_LAYER_CONFIG',
      ],
      [
        {
          id: 'bad',
          type: 'points',
          points: [{ longitude: Number.NaN, latitude: 0 }],
        },
        'INVALID_LAYER_CONFIG',
      ],
      [
        { id: 'bad', type: 'points', points: [{ longitude: 0, latitude: 0, pixelSize: 1 }] },
        'INVALID_LAYER_CONFIG',
      ],
      [{ id: 'bad', type: 'points', points: [], pixelSize: 99 }, 'INVALID_LAYER_CONFIG'],
      [{ id: 'bad', type: 'points', points: [], color: 'invalid-color' }, 'INVALID_LAYER_COLOR'],
    ];

    // 建点是同步过程：工厂直接抛出，图层管理器会把它转成 Promise 拒绝。
    for (const [spec, code] of cases) {
      expect(() => createPointsLayer(view.viewer as never, spec, context)).toThrow(
        expect.objectContaining({ code }),
      );
    }

    expect(() =>
      createPointsLayer(
        view.viewer as never,
        {
          id: 'huge',
          type: 'points',
          points: Array.from({ length: MAX_POINT_LAYER_POINTS + 1 }, () => ({
            longitude: 0,
            latitude: 0,
          })),
        },
        context,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }));
    expect(view.add).not.toHaveBeenCalled();
  });

  it('rejects creation when the layer is added after cancellation', () => {
    const view = createViewer();
    const controller = new AbortController();
    controller.abort('route changed');

    expect(() =>
      createPointsLayer(
        view.viewer as never,
        { id: 'cancelled', type: 'points', points: [{ longitude: 0, latitude: 0 }] },
        createContext(controller.signal).context,
      ),
    ).toThrow(expect.objectContaining({ code: 'LAYER_OPERATION_ABORTED' }));
    expect(view.add).not.toHaveBeenCalled();
  });

  it('writes the business id into the picking marker', async () => {
    const view = createViewer();
    const layer = await createPointsLayer(
      view.viewer as never,
      {
        id: 'targets',
        type: 'points',
        points: [
          { id: 'sat-1', longitude: 0, latitude: 0 },
          { id: '  ', longitude: 1, latitude: 1 },
        ],
      },
      createContext().context,
    );

    expect(view.items[0]?.points[0]?.id).toEqual({ layerId: 'targets', objectId: 'sat-1' });
    // 空白 id 视为未提供，只标记图层。
    expect(view.items[0]?.points[1]?.id).toEqual({ layerId: 'targets' });

    await layer.dispose();
  });
});
