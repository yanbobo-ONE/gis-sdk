---
'@yanbobo/gis-sdk': minor
---

增加分析工具 `map.analysis`：`run(tool, input)` 按工具 ID 窄化输入输出，13 个内置工具覆盖距离、地表距离、面积、方位角、地形采样、通视、视域、坡度坡向、CRS 转换、点在面内、批量点在面内、包围盒与质心，结果带 `algorithmVersion`，取消走 `signal`（`ANALYSIS_ABORTED`）。算法全部在 `/core`：`evaluateLineOfSight()`、`evaluateHorizon()`、`slopeAspectFromPlane()`、`surfacePathLength()`、`curvatureDropMeters()` 与 `createAnalysisController(terrainPort)` 都不依赖渲染引擎，`map.analysis` 只负责路由与地形取数；缺地形数据的采样点不参与判定、不伪造成 0 高，整条线无数据时抛可重试的 `ANALYSIS_TERRAIN_UNAVAILABLE`。
