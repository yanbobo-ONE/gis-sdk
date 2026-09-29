---
'@yanbobo/gis-sdk': minor
---

增加渲染质量档与按帧率自动降档（`createMap({ quality })`、`map.quality`、`RenderQualityMonitor`），联动渲染分辨率、地形屏幕空间误差与模型并发上限；并增加影像图层与底图的远端失败可观测性（累计错误计数，只上报首个失败）。
