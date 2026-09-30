---
'@yanbobo/gis-sdk': minor
---

增加 CZML 图层 `{ type: 'czml', data }`：文档数组或 URL 交给 Cesium 的 `CzmlDataSource`，实体生命周期由 SDK 统一管理（`setVisible()` / `setData()` / `remove()` / `map.destroy()`）；`setData()` 是原子替换（新文档加载成功后才换掉旧实体，取消时旧文档继续生效且图层不进入错误态），并提供 `entityCount` 读数。文档里的 `clock` **不会**被 SDK 应用到地图时钟——时钟与动画编排仍由业务接。
