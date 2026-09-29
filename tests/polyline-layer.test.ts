import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class FakePolyline {
    width = 1;
    material: unknown;
    show = true;
    constructor(readonly options: Record<string, unknown>) {}
  }

  class FakePolylineCollection {
    show = true;
    readonly polylines: FakePolyline[] = [];
    readonly destroy = vi.fn();

    get length(): number {
      return this.polylines.length;
    }

    add(options: Record<string, unknown>): FakePolyline {
      const polyline = new FakePolyline(options);
      this.polylines.push(polyline);
      return polyline;
    }

    get(index: number): FakePolyline | undefined {
      return this.polylines[index];
    }
  }

  const fromDegrees = vi.fn((longitude: number, latitude: number, height: number) => ({
    longitude,
    latitude,
    height,
  }));
  const fromType = vi.fn((type: string, uniforms: Record<string, unknown>) => ({ type, uniforms }));

  return {
    Cartesian3: { fromDegrees },
    Color: {
      WHITE: { css: 'white' },
      fromCssColorString: vi.fn((value: string) =>
        value === 'invalid-color' ? undefined : { css: value },
      ),
    },
    Material: { fromType },
    PolylineCollection: FakePolylineCollection,
    FakePolylineCollection,
    fromDegrees,
    fromType,
  };
});

vi.mock('cesium', () => ({
  Cartesian3: cesium.Cartesian3,
  Color: cesium.Color,
  Material: cesium.Material,
  PolylineCollection: cesium.PolylineCollection,
}));

import { createPolylineLayer } from '../src/cesium/layers/polyline-layer.js';
import { MAX_POLYLINES_PER_LAYER } from '../src/layers/contracts.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

type FakeCollection = InstanceType<typeof cesium.FakePolylineCollection>;

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

const path = [
  { longitude: 116.39, latitude: 39.9 },
  { longitude: 117.2, latitude: 39.4 },
];

describe('polyline layer', () => {
  beforeEach(() => {
    cesium.fromDegrees.mockClear();
    cesium.fromType.mockClear();
    cesium.Color.fromCssColorString.mockClear();
  });

  it('renders polylines with layer defaults, per-polyline overrides, and pick markers', async () => {
    const view = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createPolylineLayer(
      view.viewer as never,
      {
        id: 'routes',
        type: 'polyline',
        width: 4,
        material: 'glow',
        glowPower: 0.5,
        polylines: [
          { positions: path },
          { id: 'route-2', positions: path, color: '#ff0000', material: 'dash' },
        ],
      },
      context,
    );

    expect(cesium.fromDegrees).toHaveBeenCalledWith(116.39, 39.9, 0);
    const collection = view.items[0];
    expect(collection?.polylines).toHaveLength(2);
    expect(collection?.polylines[0]?.width).toBe(4);
    expect(collection?.polylines[0]?.material).toEqual({
      type: 'PolylineGlow',
      uniforms: { color: { css: '#ffffff' }, glowPower: 0.5 },
    });
    // 逐条覆盖颜色与材质类型。
    expect(collection?.polylines[1]?.material).toEqual({
      type: 'PolylineDash',
      uniforms: { color: { css: '#ff0000' }, dashLength: 16 },
    });
    expect(collection?.polylines[0]?.options.id).toEqual({ layerId: 'routes' });
    expect(collection?.polylines[1]?.options.id).toEqual({
      layerId: 'routes',
      objectId: 'route-2',
    });
    expect(layer).toMatchObject({ id: 'routes', type: 'polyline', count: 2, visible: true });

    layer.setVisible(false);
    expect(collection?.show).toBe(false);

    await layer.dispose();
    expect(view.remove).toHaveBeenCalledOnce();
    expect(onDisposed).toHaveBeenCalledOnce();
  });

  it('maps every supported material kind to a public Cesium material type', async () => {
    const view = createViewer();
    await createPolylineLayer(
      view.viewer as never,
      {
        id: 'kinds',
        type: 'polyline',
        polylines: [
          { positions: path, material: 'solid' },
          { positions: path, material: 'outline', outlineWidth: 3, outlineColor: '#00ff00' },
          { positions: path, material: 'arrow' },
          { positions: path, material: 'dash', dashLength: 32 },
        ],
      },
      createContext().context,
    );

    const materials = view.items[0]?.polylines.map((polyline) => polyline.material);
    expect(materials).toEqual([
      { type: 'Color', uniforms: { color: { css: '#ffffff' } } },
      {
        type: 'PolylineOutline',
        uniforms: { color: { css: '#ffffff' }, outlineColor: { css: '#00ff00' }, outlineWidth: 3 },
      },
      { type: 'PolylineArrow', uniforms: { color: { css: '#ffffff' } } },
      { type: 'PolylineDash', uniforms: { color: { css: '#ffffff' }, dashLength: 32 } },
    ]);
  });

  it('replaces polylines atomically and keeps the previous set when cancelled', async () => {
    const view = createViewer();
    const layer = await createPolylineLayer(
      view.viewer as never,
      { id: 'routes', type: 'polyline', polylines: [{ positions: path }] },
      createContext().context,
    );
    const original = view.items[0];

    view.operations.length = 0;
    await layer.setData([{ positions: path }, { positions: path }]);

    expect(layer.count).toBe(2);
    expect(view.items).toHaveLength(1);
    expect(view.operations).toEqual(['add:1', 'remove']);

    const controller = new AbortController();
    controller.abort('route changed');
    await expect(
      layer.setData([{ positions: path }], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'LAYER_OPERATION_ABORTED' });
    expect(layer.count).toBe(2);
    expect(layer.state).toBe('ready');
    expect(original?.destroy).not.toHaveBeenCalled();

    await layer.dispose();
  });

  it('applies style changes to every polyline', async () => {
    const view = createViewer();
    const layer = await createPolylineLayer(
      view.viewer as never,
      {
        id: 'routes',
        type: 'polyline',
        polylines: [{ positions: path }, { positions: path }],
      },
      createContext().context,
    );

    layer.setStyle({ material: 'arrow', width: 8, color: '#0000ff' });
    const collection = view.items[0];
    expect(collection?.polylines[0]?.material).toEqual({
      type: 'PolylineArrow',
      uniforms: { color: { css: '#0000ff' } },
    });
    expect(collection?.polylines[0]?.width).toBe(8);
    expect(collection?.polylines[1]?.width).toBe(8);

    // 只改一项时其余样式保持。
    layer.setStyle({ glowPower: 0.8, material: 'glow' });
    expect(collection?.polylines[0]?.material).toEqual({
      type: 'PolylineGlow',
      uniforms: { color: { css: '#0000ff' }, glowPower: 0.8 },
    });

    await layer.dispose();
  });

  it('rejects invalid configuration before creating primitives', () => {
    const view = createViewer();
    const context = createContext().context;
    const cases: readonly [Parameters<typeof createPolylineLayer>[1], string][] = [
      [
        { id: 'bad', type: 'polyline', polylines: [{ positions: [path[0] as never] }] },
        'INVALID_LAYER_CONFIG',
      ],
      [{ id: 'bad', type: 'polyline', polylines: [{ positions: [] }] }, 'INVALID_LAYER_CONFIG'],
      [
        {
          id: 'bad',
          type: 'polyline',
          polylines: [{ positions: [{ longitude: 181, latitude: 0 }] as never }],
        },
        'INVALID_LAYER_CONFIG',
      ],
      [
        { id: 'bad', type: 'polyline', polylines: [{ positions: path, width: 100 }] },
        'INVALID_LAYER_CONFIG',
      ],
      [
        {
          id: 'bad',
          type: 'polyline',
          polylines: [{ positions: path, material: 'neon' as never }],
        },
        'INVALID_LAYER_CONFIG',
      ],
      [
        { id: 'bad', type: 'polyline', polylines: [{ positions: path, glowPower: 2 }] },
        'INVALID_LAYER_CONFIG',
      ],
      [
        { id: 'bad', type: 'polyline', polylines: [{ positions: path, dashLength: 0 }] },
        'INVALID_LAYER_CONFIG',
      ],
      [
        { id: 'bad', type: 'polyline', polylines: [{ positions: path, color: 'invalid-color' }] },
        'INVALID_LAYER_COLOR',
      ],
      [{ id: 'bad', type: 'polyline', polylines: 'nope' as never }, 'INVALID_LAYER_CONFIG'],
    ];

    for (const [spec, code] of cases) {
      expect(() => createPolylineLayer(view.viewer as never, spec, context)).toThrow(
        expect.objectContaining({ code }),
      );
    }

    expect(() =>
      createPolylineLayer(
        view.viewer as never,
        {
          id: 'huge',
          type: 'polyline',
          polylines: Array.from({ length: MAX_POLYLINES_PER_LAYER + 1 }, () => ({
            positions: path,
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
      createPolylineLayer(
        view.viewer as never,
        { id: 'cancelled', type: 'polyline', polylines: [{ positions: path }] },
        createContext(controller.signal).context,
      ),
    ).toThrow(expect.objectContaining({ code: 'LAYER_OPERATION_ABORTED' }));
    expect(view.add).not.toHaveBeenCalled();
  });
});
