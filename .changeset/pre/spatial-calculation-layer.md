---
'@yanbobo/gis-sdk': minor
---

增加空间计算层（`@yanbobo/gis-sdk/core`，零 Cesium 纯函数）：量算（距离、折线长度、面积含洞、方位角、目标点、包围盒、质心、沿线取点、最近点）、空间判断（点在多边形内、批量判断带包围盒预筛、绕向规范化）与 CRS 坐标转换（proj4 封装、CGCS2000 高斯带按公式登记并校验带号、批量转换）；同时定稿 `map.analysis` 分析控制器契约（`src/core/analysis.ts`，本版尚未挂到地图实例）。
