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

  class FakeLabelCollection {
    show = true;
    readonly labels: Record<string, unknown>[] = [];
    readonly destroy = vi.fn();

    get length(): number {
      return this.labels.length;
    }

    add(options: Record<string, unknown>): Record<string, unknown> {
      const label = { ...options };
      this.labels.push(label);
      return label;
    }

    get(index: number): Record<string, unknown> | undefined {
      return this.labels[index];
    }
  }

  class FakeCartesian2 {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
  }

  const fromDegrees = vi.fn((longitude: number, latitude: number, height: number) => ({
    longitude,
    latitude,
    height,
  }));

  return {
    Cartesian2: FakeCartesian2,
    FakeCartesian2,
    Cartesian3: { fromDegrees },
    Color: {
      WHITE: { css: 'white' },
      fromCssColorString: vi.fn((value: string) =>
        value === 'invalid-color' ? undefined : { css: value },
      ),
    },
    PointPrimitiveCollection: FakePointPrimitiveCollection,
    FakePointPrimitiveCollection,
    FakeLabelCollection,
    LabelCollection: FakeLabelCollection,
    fromDegrees,
  };
});

vi.mock('cesium', () => ({
  Cartesian2: cesium.Cartesian2,
  Cartesian3: cesium.Cartesian3,
  Color: cesium.Color,
  LabelCollection: cesium.LabelCollection,
  PointPrimitiveCollection: cesium.PointPrimitiveCollection,
}));

import { createPointsLayer } from '../src/cesium/layers/points-layer.js';
import { MAX_POINT_LAYER_POINTS } from '../src/layers/contracts.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

type FakeCollection = InstanceType<typeof cesium.FakePointPrimitiveCollection>;
type FakeLabels = InstanceType<typeof cesium.FakeLabelCollection>;

/** 从场景里挑出第一个标签集合。 */
const labelsOf = (items: unknown[]): FakeLabels | undefined =>
  items.find((item): item is FakeLabels => item instanceof cesium.FakeLabelCollection);

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

  it('renders one label per point that has text and writes the picking marker', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createPointsLayer(
      view.viewer as never,
      {
        id: 'targets',
        type: 'points',
        points: [
          { id: 'a', longitude: 116.39, latitude: 39.9, label: '目标 A' },
          { id: 'b', longitude: 121.47, latitude: 31.23 },
          { id: 'c', longitude: 113.26, latitude: 23.13, label: '  目标 C  ' },
        ],
        labels: { enabled: true, font: '14px serif', color: '#ffee00', offsetPixels: [4, -20] },
      },
      context,
    );

    const labels = labelsOf(view.items);
    expect(labels?.labels).toHaveLength(2);
    expect(labels?.labels[0]).toMatchObject({
      text: '目标 A',
      font: '14px serif',
      fillColor: { css: '#ffee00' },
      outlineColor: { css: '#0b1310' },
      outlineWidth: 2,
      id: { layerId: 'targets', objectId: 'a' },
    });
    // 偏移按像素传入，文本两端空白会被去掉。
    expect(labels?.labels[1]).toMatchObject({ text: '目标 C' });
    const offset = labels?.labels[1]?.pixelOffset as { x: number; y: number } | undefined;
    expect(offset).toEqual({ x: 4, y: -20 });
    expect(layer.count).toBe(3);
    expect(layer.labelCount).toBe(2);

    layer.setVisible(false);
    expect(labels?.show).toBe(false);
    await layer.dispose();
    expect(view.items).toHaveLength(0);
  });

  it('truncates labels at maxLabels while keeping every point', async () => {
    const view = createViewer();
    const { context } = createContext();
    const points = Array.from({ length: 10 }, (_, index) => ({
      longitude: 116 + index * 0.001,
      latitude: 39.9,
      label: `P${String(index)}`,
    }));
    const layer = await createPointsLayer(
      view.viewer as never,
      { id: 'targets', type: 'points', points, labels: { enabled: true, maxLabels: 4 } },
      context,
    );

    expect(layer.count).toBe(10);
    expect(layer.labelCount).toBe(4);
    expect(labelsOf(view.items)?.labels.map((label) => label.text)).toEqual([
      'P0',
      'P1',
      'P2',
      'P3',
    ]);

    // maxLabels 为 0 时不建标签集合。
    const noLabels = await createPointsLayer(
      view.viewer as never,
      { id: 'none', type: 'points', points, labels: { enabled: true, maxLabels: 0 } },
      context,
    );
    expect(noLabels.labelCount).toBe(0);
    expect(labelsOf(view.items)).toBeDefined();
  });

  it('replaces labels together with points and toggles them through setStyle', async () => {
    const view = createViewer();
    const { context } = createContext();
    const layer = await createPointsLayer(
      view.viewer as never,
      {
        id: 'targets',
        type: 'points',
        points: [{ longitude: 1, latitude: 2, label: 'first' }],
        labels: { enabled: true },
      },
      context,
    );
    expect(layer.labelCount).toBe(1);

    await layer.setData([{ longitude: 3, latitude: 4, label: 'second' }]);
    expect(labelsOf(view.items)?.labels[0]).toMatchObject({ text: 'second' });
    expect(layer.labelCount).toBe(1);
    // 旧标签集合已从场景移除，只留一套点 + 一套标签。
    expect(view.items).toHaveLength(2);

    // 关闭标签：集合被移除，点还在。
    layer.setStyle({ labels: { enabled: false } });
    expect(layer.labelCount).toBe(0);
    expect(view.items).toHaveLength(1);

    // 重新打开：按当前点位重建，字体颜色生效。
    layer.setStyle({ labels: { enabled: true, font: '16px serif', color: '#ff0000' } });
    expect(layer.labelCount).toBe(1);
    expect(labelsOf(view.items)?.labels[0]).toMatchObject({
      text: 'second',
      font: '16px serif',
      fillColor: { css: '#ff0000' },
    });
  });

  it('validates label configuration and text', () => {
    const view = createViewer();
    const context = createContext().context;
    const base = {
      id: 'targets',
      type: 'points' as const,
      points: [{ longitude: 1, latitude: 2 }],
    };

    // 与点位校验一致：建点是同步过程，工厂直接抛出。
    const cases: readonly [Parameters<typeof createPointsLayer>[1]][] = [
      [{ ...base, labels: { enabled: true, font: '  ' } }],
      [{ ...base, labels: { enabled: true, offsetPixels: [1] as never } }],
      [{ ...base, labels: { enabled: true, outlineWidth: 20 } }],
      [{ ...base, labels: { enabled: true, maxLabels: 99_999 } }],
      [{ ...base, points: [{ longitude: 1, latitude: 2, label: 'x'.repeat(65) }] }],
    ];
    for (const [spec] of cases) {
      expect(() => createPointsLayer(view.viewer as never, spec, context)).toThrow(
        expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }),
      );
    }

    // 颜色错误沿用图层既有的 INVALID_LAYER_COLOR 代码。
    expect(() =>
      createPointsLayer(
        view.viewer as never,
        { ...base, labels: { enabled: true, color: 'invalid-color' } },
        context,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_LAYER_COLOR' }));

    // 空白标签按"没有标签"处理，不报错也不建标签。
    expect(() =>
      createPointsLayer(
        view.viewer as never,
        {
          ...base,
          points: [{ longitude: 1, latitude: 2, label: '   ' }],
          labels: { enabled: true },
        },
        context,
      ),
    ).not.toThrow();
  });
});
