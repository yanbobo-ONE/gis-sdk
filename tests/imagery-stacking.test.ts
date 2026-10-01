import { describe, expect, it } from 'vitest';

import {
  createImageryStacking,
  registerImageryFloor,
} from '../src/cesium/layers/imagery-stacking.js';
import type { LayerStacking } from '../src/layers/contracts.js';

interface FakeLayer {
  readonly name: string;
}

/** 按 Cesium 的 `ImageryLayerCollection` 语义建模：数组顺序即叠加顺序。 */
function createCollection(names: readonly string[]) {
  const items: FakeLayer[] = names.map((name) => ({ name }));
  return {
    items,
    get length() {
      return items.length;
    },
    indexOf(layer: FakeLayer) {
      return items.indexOf(layer);
    },
    raise(layer: FakeLayer) {
      const index = items.indexOf(layer);
      if (index < 0 || index >= items.length - 1) {
        return;
      }
      items.splice(index, 1);
      items.splice(index + 1, 0, layer);
    },
    lower(layer: FakeLayer) {
      const index = items.indexOf(layer);
      if (index <= 0) {
        return;
      }
      items.splice(index, 1);
      items.splice(index - 1, 0, layer);
    },
    raiseToTop(layer: FakeLayer) {
      const index = items.indexOf(layer);
      if (index < 0) {
        return;
      }
      items.splice(index, 1);
      items.push(layer);
    },
    remove(layer: FakeLayer) {
      const index = items.indexOf(layer);
      if (index < 0) {
        return false;
      }
      items.splice(index, 1);
      return true;
    },
    add(layer: FakeLayer, index?: number) {
      items.splice(index ?? items.length, 0, layer);
    },
  };
}

function orderOf(collection: { readonly items: readonly FakeLayer[] }): string[] {
  return collection.items.map((layer) => layer.name);
}

type FakeCollection = ReturnType<typeof createCollection>;

/**
 * 建立一个带底图的场景：第 0 层是底图（不属于业务图层），业务图层从第 1 层起。
 */
function createScene(
  businessLayerNames: readonly string[],
  target: string,
  options: { readonly withBasemap?: boolean } = {},
): {
  readonly collection: FakeCollection;
  readonly stacking: LayerStacking;
  readonly viewer: { readonly imageryLayers: FakeCollection };
} {
  const withBasemap = options.withBasemap ?? true;
  const names = withBasemap ? ['basemap', ...businessLayerNames] : [...businessLayerNames];
  const collection = createCollection(names);
  const viewer = { imageryLayers: collection };
  const floor = withBasemap ? 1 : 0;
  registerImageryFloor(viewer, () => floor);
  const layer = collection.items.find((item) => item.name === target);
  if (!layer) {
    throw new Error(`测试场景里没有图层 ${target}`);
  }
  return { collection, stacking: createImageryStacking(viewer, () => layer), viewer };
}

describe('imagery stacking', () => {
  it('moves a business layer within the imagery stack', () => {
    const { collection, stacking } = createScene(['a', 'b', 'c'], 'a');

    // 序号按业务影像图层算，底图不占号。
    expect(stacking.stackIndex).toBe(0);

    expect(stacking.raise()).toBe(true);
    expect(orderOf(collection)).toEqual(['basemap', 'b', 'a', 'c']);
    expect(stacking.stackIndex).toBe(1);

    expect(stacking.raiseToTop()).toBe(true);
    expect(orderOf(collection)).toEqual(['basemap', 'b', 'c', 'a']);
    expect(stacking.stackIndex).toBe(2);
    // 已在最上层：返回 false 而不是抛错。
    expect(stacking.raiseToTop()).toBe(false);
    expect(stacking.raise()).toBe(false);
  });

  it('never puts a business layer below the basemap', () => {
    const { collection, stacking } = createScene(['a', 'b'], 'b');

    expect(stacking.lower()).toBe(true);
    expect(orderOf(collection)).toEqual(['basemap', 'b', 'a']);

    // 下限是底图之上：再 lower 不动，也不会越过底图。
    expect(stacking.lower()).toBe(false);
    expect(stacking.lowerToBottom()).toBe(false);
    expect(orderOf(collection)).toEqual(['basemap', 'b', 'a']);
    expect(stacking.stackIndex).toBe(0);
  });

  it('lets a business layer reach the bottom when there is no basemap', () => {
    const { collection, stacking } = createScene(['a', 'b'], 'b', { withBasemap: false });

    expect(stacking.stackIndex).toBe(1);
    expect(stacking.lowerToBottom()).toBe(true);
    expect(orderOf(collection)).toEqual(['b', 'a']);
    expect(stacking.stackIndex).toBe(0);
  });

  it('reads the current layer each time so provider swaps keep working', () => {
    const collection = createCollection(['basemap', 'old']);
    const viewer = { imageryLayers: collection };
    registerImageryFloor(viewer, () => 1);
    const initial = collection.items[1];
    if (!initial) {
      throw new Error('测试场景里没有业务图层');
    }
    let current: FakeLayer = initial;
    const stacking = createImageryStacking(viewer, () => current);

    expect(stacking.stackIndex).toBe(0);

    // 模拟 reload 换掉图层对象：顺序与读数按新对象算。
    collection.add({ name: 'new' }, 2);
    const swapped = collection.items[2];
    if (!swapped) {
      throw new Error('测试场景里没有替换后的图层');
    }
    current = swapped;
    expect(stacking.stackIndex).toBe(1);
    expect(stacking.raiseToTop()).toBe(false);

    collection.add({ name: 'third' });
    expect(stacking.raiseToTop()).toBe(true);
    expect(orderOf(collection)).toEqual(['basemap', 'old', 'third', 'new']);
    expect(stacking.stackIndex).toBe(2);
  });

  it('reports undefined and refuses to move once the layer left the collection', () => {
    const { collection, stacking } = createScene(['a'], 'a');
    const layer = collection.items[1];
    if (!layer) {
      throw new Error('测试场景里没有业务图层');
    }

    // 业务通过 map.raw.viewer 把图层摘掉：读数为 undefined，移动是无副作用的 false。
    collection.remove(layer);

    expect(stacking.stackIndex).toBeUndefined();
    expect(stacking.raise()).toBe(false);
    expect(stacking.lower()).toBe(false);
    expect(stacking.raiseToTop()).toBe(false);
    expect(stacking.lowerToBottom()).toBe(false);
    expect(orderOf(collection)).toEqual(['basemap']);
  });
});
