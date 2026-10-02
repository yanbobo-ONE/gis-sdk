---
'@yanbobo/gis-sdk': minor
---

增加密度热力图图层 `type: 'heatmap'`：输入是**业务点位**（经纬度 + 可选权重），SDK 在本地把权重按四次核 `(1 - d²/r²)²` 摊成密度网格、着色成带透明度的位图，再作为单张影像贴合到覆盖范围——**不依赖外部数据集**，也不需要业务预处理。`setData()` / `setStyle()` 先栅格化再换影像（原子替换，替换期间以可重试的 `LAYER_BUSY` 拒绝），并继承透明度、显隐与堆叠位置；空点位得到一张全透明小图而不是报错。透明度走影像图层 alpha（调整不需要重栅格化），alpha 随密度增长因此叠加不出现方形遮罩；支持内置色带 `thermal` / `radar` / `cool` 与自定义色标（`#rgb` / `#rrggbb`，按 offset 升序、首尾覆盖 0 与 1），可显式传 `maxDensity` 让多批数据可比。句柄具备影像图层的全部能力（`setOpacity` / `setVisible` / `stackIndex` / `raise` / `lower` / `raiseToTop` / `lowerToBottom`）。`/core` 同时导出纯计算的 `buildHeatmapGrid()` 与 `colorizeHeatmap()`（零 Cesium，可单独复用与单测）；图层侧非法参数抛 `INVALID_LAYER_CONFIG` / `INVALID_LAYER_OPACITY`，核心侧抛 `INVALID_SPATIAL_INPUT`。规模上限：点数 20 万、位图长边 1024；不做时序混合与聚合标注（留在业务）。
