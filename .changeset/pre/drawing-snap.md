---
'@yanbobo/gis-sdk': minor
---

增加绘制吸附：`map.drawing.setSnap({ enabled, pixelTolerance?, includeEdges? })` 让落点与顶点拖动吸附到已完成图形的顶点（可选线段），判定为顶点优先、阈值按屏幕像素（默认 12，上限 64），线段落点按屏幕比例插值且经度走最短弧；编辑会话中自动排除正在拖动的顶点自身。同时导出零依赖纯函数 `findSnapTarget()` / `segmentsOf()` / `resolveSnapOptions()` 与阈值常量，供其它终端自行拼候选。
