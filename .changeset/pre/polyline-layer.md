---
'@yanbobo/gis-sdk': minor
---

增加折线图层（`type: 'polyline'`，PolylineCollection 批量渲染、单层 10000 条、五种 Cesium 内置材质 solid/glow/outline/arrow/dash、逐条样式覆盖与拾取标记、`setData()` 原子替换与 `setStyle()` 整层调整）；同时把画布快照的 `canvas` 契约改为可移植形状，去掉 core 层对 DOM 类型的依赖。
