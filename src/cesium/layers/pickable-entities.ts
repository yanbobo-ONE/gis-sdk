import type { PickingMarker } from '../../core/controls.js';

/**
 * 托管实体的拾取归属。
 *
 * 单对象图层可以直接把标记写进 Cesium 图元的 `id`，但数据源里的实体不行：`entity.id` 是
 * Cesium 的实体主键（CZML / GeoJSON 文档自己要用），不能覆盖成标记对象。这里改用按对象
 * 身份索引的弱引用表登记归属，实体随数据源释放时条目会被垃圾回收自动清掉。
 */
const markers = new WeakMap<object, PickingMarker>();

/** 登记一批实体的拾取归属；实体 id 作为 `objectId` 一并记录。 */
export function registerPickableEntities(entities: Iterable<object>, layerId: string): void {
  for (const entity of entities) {
    const objectId = (entity as { readonly id?: unknown }).id;
    markers.set(entity, typeof objectId === 'string' ? { layerId, objectId } : { layerId });
  }
}

/** 查询某个已加载实体的拾取归属；不是托管实体时返回 `undefined`。 */
export function pickableEntityMarker(value: unknown): PickingMarker | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return markers.get(value);
}
