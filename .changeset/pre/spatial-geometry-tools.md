---
'@yanbobo/gis-sdk': minor
---

增加三个零依赖的空间几何工具：`convexHull()`（安德鲁单调链，返回闭合环，平面口径与 turf `convex` 一致）、`simplifyPath()` / `simplifyRing()`（Ramer–Douglas–Peucker，距离用米制 `nearestPointOnPath()`，高纬度不会过抽，首尾保留、环保持闭合）与 `validatePolygon()`（返回问题列表而非抛错：顶点不足、未闭合、重复顶点、自交、洞越界或穿壳；自交检测用包围盒扫描）。同时 `map.analysis` 新增 `convex-hull` 与 `simplify` 两个内置工具，`list()` 现为 15 个工具。
