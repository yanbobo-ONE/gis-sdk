---
'@yanbobo/gis-sdk': minor
---

增加影像图层的堆叠顺序控制：WMS / TMS / WMTS / 单图影像四个句柄新增 `stackIndex`（在业务影像图层里的序号，0 最靠下）与 `raise()` / `lower()` / `raiseToTop()` / `lowerToBottom()`，到边界时返回 `false` 而不是抛错。**底图恒在最底层**：这四个操作不会把业务图层排到底图之下，序号也只按业务影像图层计（底图不占号），底图清空后下限自动回到 0；顺序直接作用在 Viewer 的影像集合上，业务用 `map.raw.viewer.imageryLayers` 手动调整后读数同样跟着变。图元通道（点位 / 折线 / 模型 / 3D Tiles）与数据源通道（CZML / GeoJSON）不提供排序：它们的可见性由几何与深度决定，集合顺序不决定谁盖住谁，给一个"能调但看不出效果"的接口比没有更糟；跨通道排序同样不支持。`LayerStacking` 类型从 `/layers` 导出，取舍与用法见[图层管理](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/layer-management.md#堆叠顺序)。
