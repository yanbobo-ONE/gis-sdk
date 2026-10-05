import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  const fromDegrees = vi.fn(
    (
      longitude: number,
      latitude: number,
      height: number,
      _ellipsoid?: unknown,
      result?: { x: number; y: number; z: number },
    ) => {
      const target = result ?? { x: 0, y: 0, z: 0 };
      target.x = longitude;
      target.y = latitude;
      target.z = height;
      return target;
    },
  );

  class Polyline {
    show = true;
    width = 1;
    material: unknown;
    positions: { x: number; y: number; z: number }[];

    constructor(options: Record<string, unknown>) {
      this.positions = options.positions as Polyline['positions'];
      this.show = options.show !== false;
      this.width = options.width as number;
      this.material = options.material;
    }
  }

  class PolylineCollection {
    show = true;
    readonly items: Polyline[] = [];

    add(options: Record<string, unknown> | Polyline): Polyline {
      const polyline = options instanceof Polyline ? options : new Polyline(options);
      this.items.push(polyline);
      return polyline;
    }

    remove(polyline: Polyline): boolean {
      const index = this.items.indexOf(polyline);
      if (index < 0) {
        return false;
      }
      this.items.splice(index, 1);
      return true;
    }

    get length(): number {
      return this.items.length;
    }
  }

  const fromType = vi.fn((type: string, uniforms: Record<string, unknown> = {}) => ({
    type,
    shaderSource: '// mock',
    uniforms: { ...uniforms },
  }));

  return { Polyline, PolylineCollection, fromDegrees, fromType };
});

vi.mock('cesium', () => ({
  Cartesian3: { fromDegrees: cesium.fromDegrees },
  Color: {
    fromCssColorString: (value: string) => ({ css: value, alpha: 1 }),
  },
  Material: { fromType: cesium.fromType },
  PolylineCollection: cesium.PolylineCollection,
}));

import { createWindFieldLayer } from '../src/cesium/layers/wind-field-layer.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

/** 3×3×2 的均匀东风网格。 */
function fieldInput(overrides: { u?: number; v?: number; w?: number } = {}) {
  const count = 3 * 3 * 2;
  return {
    axes: {
      lon: { start: 116, step: 1, count: 3 },
      lat: { start: 39, step: 1, count: 3 },
      height: { start: 0, step: 500, count: 2 },
    },
    u: new Float32Array(count).fill(overrides.u ?? 10),
    v: new Float32Array(count).fill(overrides.v ?? 0),
    ...(overrides.w === undefined ? {} : { w: new Float32Array(count).fill(overrides.w) }),
  };
}

function createViewer() {
  const primitives = {
    add: vi.fn((collection: unknown) => collection),
    remove: vi.fn(() => true),
  };
  const frameListeners = new Set<() => void>();
  const viewer = {
    scene: {
      primitives,
      preRender: {
        addEventListener: (listener: () => void) => {
          frameListeners.add(listener);
          return () => frameListeners.delete(listener);
        },
      },
    },
  };
  return { viewer, primitives, frameListeners };
}

function createContext() {
  const onDisposed = vi.fn();
  const context: LayerFactoryContext = { signal: new AbortController().signal, onDisposed };
  return { context, onDisposed };
}

describe('wind field layer', () => {
  beforeEach(() => {
    cesium.fromDegrees.mockClear();
    cesium.fromType.mockClear();
  });

  it('creates one polyline per particle and advances them each frame', async () => {
    const { viewer, primitives, frameListeners } = createViewer();
    const { context } = createContext();
    let now = 1_000;

    const layer = await createWindFieldLayer(
      viewer as never,
      {
        id: 'wind',
        type: 'wind-field',
        field: fieldInput(),
        particles: 6,
        lifetimeSeconds: 60,
        seed: 3,
      },
      context,
      () => now,
    );

    const collection = primitives.add.mock.calls[0]?.[0] as InstanceType<
      typeof cesium.PolylineCollection
    >;
    expect(primitives.add).toHaveBeenCalledTimes(1);
    expect(layer.particleCount).toBe(6);
    expect(collection.items).toHaveLength(6);
    expect(collection.items.every((line) => !line.show)).toBe(true);
    expect(cesium.fromType).toHaveBeenCalledWith('PolylineGlow', expect.anything());

    // 推进 0.5 秒：每颗粒子产生一段拖尾，尾点是上一位置、头点是当前位置（向东移动）。
    now += 500;
    for (const listener of frameListeners) {
      listener();
    }
    const drawn = collection.items.filter((line) => line.show);
    expect(drawn.length).toBeGreaterThan(0);
    for (const line of drawn) {
      const [tail, head] = line.positions;
      expect(head && tail).toBeTruthy();
      if (!head || !tail) continue;
      expect(head.x).toBeGreaterThan(tail.x); // 东风 → 经度增大
      expect(head.y).toBeCloseTo(tail.y, 9);
    }
    expect(layer.averageSpeed).toBeCloseTo(10, 6);
    expect(frameListeners.size).toBe(1);
  });

  it('rejects invalid configuration and concurrent replacement', async () => {
    const { viewer } = createViewer();
    const { context } = createContext();

    await expect(
      createWindFieldLayer(
        viewer as never,
        { id: 'wind', type: 'wind-field', field: undefined as never },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    await expect(
      createWindFieldLayer(
        viewer as never,
        {
          id: 'wind',
          type: 'wind-field',
          field: { ...fieldInput(), u: new Float32Array(2) },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    await expect(
      createWindFieldLayer(
        viewer as never,
        { id: 'wind', type: 'wind-field', field: fieldInput(), particles: 0 },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    await expect(
      createWindFieldLayer(
        viewer as never,
        { id: 'wind', type: 'wind-field', field: fieldInput(), colors: ['#fff'] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_CONFIG' });

    await expect(
      createWindFieldLayer(
        viewer as never,
        { id: 'wind', type: 'wind-field', field: fieldInput(), opacity: 2 },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_LAYER_OPACITY' });

    const layer = await createWindFieldLayer(
      viewer as never,
      { id: 'wind', type: 'wind-field', field: fieldInput(), particles: 2 },
      context,
    );
    const first = layer.setData(fieldInput({ u: 20 }));
    const second = layer.setData(fieldInput({ u: 30 }));
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toMatchObject({ code: 'LAYER_BUSY', retryable: true });
    await expect(layer.setData(fieldInput({ u: 40 }))).resolves.toBeUndefined();
  });

  it('applies style changes and stops advancing while hidden', async () => {
    const { viewer, primitives, frameListeners } = createViewer();
    const { context } = createContext();
    let now = 1_000;
    const layer = await createWindFieldLayer(
      viewer as never,
      { id: 'wind', type: 'wind-field', field: fieldInput(), particles: 4, lifetimeSeconds: 60 },
      context,
      () => now,
    );
    const collection = primitives.add.mock.calls[0]?.[0] as InstanceType<
      typeof cesium.PolylineCollection
    >;

    await layer.setStyle({ particles: 8, width: 4 });
    expect(layer.particleCount).toBe(8);
    expect(collection.items).toHaveLength(8);
    expect(collection.items.every((line) => line.width === 4)).toBe(true);

    now += 500;
    for (const listener of frameListeners) {
      listener();
    }
    const before = collection.items.map((line) => line.positions[1]?.x ?? 0);

    // 隐藏后不再推进：位置保持不变，集合同步隐藏。
    layer.setVisible(false);
    expect(collection.show).toBe(false);
    now += 500;
    for (const listener of frameListeners) {
      listener();
    }
    expect(collection.items.map((line) => line.positions[1]?.x ?? 0)).toEqual(before);

    await layer.setStyle({ particles: 8, width: 2, opacity: 0.5 });
    await expect(layer.setStyle({ particles: 2.5 })).rejects.toMatchObject({
      code: 'INVALID_LAYER_CONFIG',
    });
  });

  it('releases the collection and detaches the frame listener on dispose', async () => {
    const { viewer, primitives, frameListeners } = createViewer();
    const { context, onDisposed } = createContext();
    const layer = await createWindFieldLayer(
      viewer as never,
      { id: 'wind', type: 'wind-field', field: fieldInput(), particles: 3 },
      context,
    );

    await layer.dispose();
    expect(primitives.remove).toHaveBeenCalledTimes(1);
    expect(frameListeners.size).toBe(0);
    expect(onDisposed).toHaveBeenCalledTimes(1);
    expect(() => layer.setData(fieldInput())).toThrow(
      expect.objectContaining({ code: 'LAYER_DISPOSED' }),
    );
  });
});
