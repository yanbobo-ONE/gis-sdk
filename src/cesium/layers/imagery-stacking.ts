import type { LayerStacking } from '../../layers/contracts.js';

/** 影像集合里被底图占住的层数：业务影像图层不得排到它下面。 */
type ImageryFloor = () => number;

/**
 * 每个 Viewer 的底图下限。
 *
 * 用弱引用按 Viewer 索引：底图由底图控制器持有，而图层句柄只拿得到 Viewer；把下限做成
 * 显式参数会一路穿过四个影像图层工厂，收益不抵噪声。条目随 Viewer 释放，不需要清理。
 */
const imageryFloors = new WeakMap<object, ImageryFloor>();

/** 登记某个 Viewer 的底图下限；由适配器在创建图层运行时之前调用一次。 */
export function registerImageryFloor(viewer: object, floor: ImageryFloor): void {
  imageryFloors.set(viewer, floor);
}

function resolveImageryFloor(viewer: object): number {
  const floor = imageryFloors.get(viewer)?.() ?? 0;
  return Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 0;
}

/** 影像图层需要的那部分 Viewer。 */
interface ImageryCollectionView {
  readonly imageryLayers: {
    readonly length: number;
    indexOf(layer: object): number;
    raise(layer: object): void;
    lower(layer: object): void;
    raiseToTop(layer: object): void;
    remove(layer: object, destroy?: boolean): boolean;
    add(layer: object, index?: number): void;
  };
}

/**
 * 把某个影像图层包成 {@link LayerStacking}。
 *
 * 图层对象会被 `reload()` / `setStyle()` 换掉，所以这里每次操作都重新取当前图层，而不是
 * 捕获一次引用。顺序读取与增删都直接作用在 Viewer 的影像集合上，因此业务通过
 * `map.raw.viewer` 手动调整顺序后，读数同样会跟着变。
 *
 * 句柄的释放由句柄自己的生命周期检查负责（本模块不加第二道门）；这里只回答"能不能挪、
 * 挪到哪儿"——图层已不在集合里（例如被业务从 `viewer.imageryLayers` 里摘掉）时读数为
 * `undefined`、移动返回 `false`。
 *
 * @internal
 */
export function createImageryStacking(
  viewer: ImageryCollectionView,
  getLayer: () => object,
): LayerStacking {
  const currentIndex = (): number => viewer.imageryLayers.indexOf(getLayer());

  return {
    get stackIndex(): number | undefined {
      const index = currentIndex();
      if (index < 0) {
        return undefined;
      }
      return Math.max(0, index - resolveImageryFloor(viewer));
    },
    raise(): boolean {
      const layer = getLayer();
      const index = viewer.imageryLayers.indexOf(layer);
      if (index < 0 || index >= viewer.imageryLayers.length - 1) {
        return false;
      }
      viewer.imageryLayers.raise(layer);
      return true;
    },
    lower(): boolean {
      const layer = getLayer();
      const index = viewer.imageryLayers.indexOf(layer);
      if (index < 0 || index <= resolveImageryFloor(viewer)) {
        return false;
      }
      viewer.imageryLayers.lower(layer);
      return true;
    },
    raiseToTop(): boolean {
      const layer = getLayer();
      const index = viewer.imageryLayers.indexOf(layer);
      if (index < 0 || index >= viewer.imageryLayers.length - 1) {
        return false;
      }
      viewer.imageryLayers.raiseToTop(layer);
      return true;
    },
    lowerToBottom(): boolean {
      const layer = getLayer();
      const collection = viewer.imageryLayers;
      const index = collection.indexOf(layer);
      if (index < 0) {
        return false;
      }
      // 直接 lowerToBottom 会排到底图之下；这里显式挪到下限那一格。
      const floor = Math.min(resolveImageryFloor(viewer), Math.max(0, collection.length - 1));
      if (index <= floor) {
        return false;
      }
      collection.remove(layer, false);
      collection.add(layer, floor);
      return true;
    },
  };
}
