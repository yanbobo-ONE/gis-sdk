---
'@yanbobo/gis-sdk': minor
---

增加空间闪电 `map.lightning` 与配套的 `/core` 纯计算：`generateLightningBolt()`（在起点建立的局部 ENU 坐标系里生成主干与分支，段内正弦包络抖动幅度夹在 40 到 320 米，分支密度 sparse / normal / dense，同 `seed` 形状可复现）、`lightningEnvelope()`（预闪 → 主峰 0.14 → 至多 3 次脉冲 → 余辉，折线辉光与屏幕闪光共用同一条曲线）与 `LightningFlashChannel`（写入/读取/按秒衰减/清零，暂停推进即冻结）。控制器 `strike(options)` 触发一次闪击并返回 id（同 id 替换），`cancel()` / `cancelAll()` 撤销，`setStyle({ coreColor, thickness, screenFlash })` 改外观，并发上限 8 且超出时淘汰最早触发的闪击；几何触发时生成一次，之后逐帧只写材质属性，不重新分配资源。渲染只用 Cesium 公开 API：`PolylineCollection` 承载主干与分支、内置 `Material` 的 `PolylineGlow` 类型做辉光（`PolylineCollection` 只接受真正的 `Material`——它直接读 `material.shaderSource`，传 `MaterialProperty` 会在渲染循环里抛错并停下渲染；因此每次闪击共用一份材质，逐帧改写 `material.uniforms`）、`PostProcessStage` 做屏幕闪光（权重 0.28，可关闭）。同批移植了局部 ENU 坐标系 `createLocalFrame()` 与 `geodeticToEcef()` / `ecefToGeodetic()`（`/core`，零 Cesium，文档随本功能一起补），程序化几何与精确量算的分工写进了闪电页面。
