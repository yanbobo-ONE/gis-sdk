import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  createImageryStacking,
  registerImageryFloor,
} from '../src/cesium/layers/imagery-stacking.js';

/**
 * 用**真实 Cesium** 的 `ImageryLayerCollection` 跑一遍排序逻辑。
 *
 * 顺序控制直接调这个类上的 `indexOf` / `raise` / `lower` / `raiseToTop` / `remove(layer, false)` /
 * `add(layer, index)`；这些方法的语义（尤其是"不在集合里会抛错"和 `remove` 默认销毁图层）只能靠
 * 真实现来锁住，手写的假集合会把假设抄成事实。
 *
 * 走 CJS 产物加载：ESM 入口会把整个引擎拉进来，而这里的纪律与浏览器无关，只需要集合类。
 */
const requireCjs = createRequire(import.meta.url);
const { ImageryLayerCollection } = requireCjs('cesium') as {
  ImageryLayerCollection: new () => {
    readonly length: number;
    get(index: number): CesiumLayer;
    add(layer: CesiumLayer, index?: number): void;
    remove(layer: CesiumLayer, destroy?: boolean): boolean;
    indexOf(layer: CesiumLayer): number;
    raise(layer: CesiumLayer): void;
    lower(layer: CesiumLayer): void;
    raiseToTop(layer: CesiumLayer): void;
  };
};

/** 集合只要求成员有 `show` 与 `readyEvent`，不需要真的 Provider。 */
interface CesiumLayer {
  readonly name: string;
  show: boolean;
  readonly readyEvent: { addEventListener(listener: () => void): () => void };
}

function createLayer(name: string): CesiumLayer {
  return {
    name,
    show: true,
    readyEvent: { addEventListener: () => () => undefined },
  };
}

function createCollection(names: readonly string[]): {
  readonly collection: InstanceType<typeof ImageryLayerCollection>;
  readonly layers: CesiumLayer[];
} {
  const collection = new ImageryLayerCollection();
  const layers = names.map((name) => createLayer(name));
  for (const layer of layers) {
    collection.add(layer);
  }
  return { collection, layers };
}

function orderOf(collection: {
  readonly length: number;
  get(index: number): CesiumLayer;
}): string[] {
  const names: string[] = [];
  for (let index = 0; index < collection.length; index += 1) {
    names.push(collection.get(index).name);
  }
  return names;
}

describe('imagery stacking against real Cesium collection', () => {
  it('reorders business layers while keeping the basemap at the bottom', () => {
    const { collection, layers } = createCollection(['basemap', 'a', 'b', 'c']);
    const viewer = { imageryLayers: collection };
    registerImageryFloor(viewer, () => 1);
    const layerA = layers[1];
    if (!layerA) {
      throw new Error('场景缺少业务图层 a');
    }
    const stacking = createImageryStacking(viewer, () => layerA);

    expect(stacking.stackIndex).toBe(0);

    expect(stacking.raise()).toBe(true);
    expect(orderOf(collection)).toEqual(['basemap', 'b', 'a', 'c']);

    expect(stacking.lowerToBottom()).toBe(true);
    expect(orderOf(collection)).toEqual(['basemap', 'a', 'b', 'c']);
    expect(stacking.stackIndex).toBe(0);
    // 下限之上的第一格就是底图之上：再往下不动，也不会把底图挤走。
    expect(stacking.lower()).toBe(false);
    expect(stacking.lowerToBottom()).toBe(false);
    expect(orderOf(collection)).toEqual(['basemap', 'a', 'b', 'c']);

    expect(stacking.raiseToTop()).toBe(true);
    expect(orderOf(collection)).toEqual(['basemap', 'b', 'c', 'a']);
    expect(stacking.stackIndex).toBe(2);
  });

  it('moves a layer that starts outside the collection without throwing', () => {
    const { collection, layers } = createCollection(['basemap', 'a']);
    const viewer = { imageryLayers: collection };
    registerImageryFloor(viewer, () => 1);
    const detached = createLayer('detached');
    const stacking = createImageryStacking(viewer, () => detached);

    // 真实集合的 raise/lower 对不在集合里的图层会抛错，所以读数为空时不能往下调。
    expect(stacking.stackIndex).toBeUndefined();
    expect(stacking.raise()).toBe(false);
    expect(stacking.lower()).toBe(false);
    expect(stacking.raiseToTop()).toBe(false);
    expect(stacking.lowerToBottom()).toBe(false);

    // 加回来之后照常工作：说明上面的 false 是没有副作用，而不是把集合写坏。
    collection.add(detached);
    expect(stacking.stackIndex).toBe(1);
    expect(stacking.lowerToBottom()).toBe(true);
    expect(orderOf(collection)).toEqual(['basemap', 'detached', 'a']);
    const businessLayer = layers[1];
    expect(businessLayer?.name).toBe('a');
  });

  it('does not destroy the layer when moving it to the bottom', () => {
    const { collection, layers } = createCollection(['basemap', 'a', 'b']);
    const viewer = { imageryLayers: collection };
    registerImageryFloor(viewer, () => 1);
    const layerB = layers[2];
    if (!layerB) {
      throw new Error('场景缺少业务图层 b');
    }
    const stacking = createImageryStacking(viewer, () => layerB);

    // remove 默认 destroy=true；实现里必须显式传 false，否则换序会顺手销毁图层。
    expect(stacking.lowerToBottom()).toBe(true);
    expect(collection.indexOf(layerB)).toBe(1);
    expect(orderOf(collection)).toEqual(['basemap', 'b', 'a']);
    expect(stacking.stackIndex).toBe(0);
  });
});
