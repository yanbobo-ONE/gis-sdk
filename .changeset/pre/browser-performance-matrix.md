---
'@yanbobo/gis-sdk': minor
---

验收台增加浏览器端性能矩阵探针：固定机位、关闭自动降档（否则测到的是降档之后的开销），每个场景先等瓦片收敛再等满一个 60 帧采样窗口，然后读 `map.quality.snapshot`，输出 12 个场景的帧率、帧耗时与 JS 堆，原始 JSON 通过面板的 `data-matrix` 暴露给验收脚本，测完自动回收探针图层、环境效果与质量档。矩阵内含两行对照（仅分辨率 0.75、默认档复测），用于把切档效果与顺序、预热、漂移区分开；一次实测记录、读数口径与限制见[性能基准](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/performance.md)。
