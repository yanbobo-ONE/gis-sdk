---
'@yanbobo/gis-sdk': minor
---

增加帧耗时统计：`/core` 新增零依赖的 `FrameStatistics`（滑动窗口给出平均、P50 / P95 / 最长帧与长帧计数，分位用最近秩口径，报出的值一定是真出现过的某一帧），并接入 `map.quality.snapshot`：新增 `frameTimeP50Ms`、`frameTimeP95Ms`、`frameTimeMaxMs`、`longFrames`、`longFrameRatio` 五个读数。平均值会把卡顿摊平——60 帧里两帧卡到 200 毫秒，平均也只涨到 25 毫秒（仍有 40 fps）——所以判断"稳不稳"要看分位与最长帧：窗口 5% 以内的单次顿挫抬不动 P95，只出现在 `frameTimeMaxMs` 上。长帧阈值默认 50 毫秒（与浏览器 Long Tasks 一致，便于和主线程长任务对照），可用 `createMap({ quality: { longFrameMs } })` 调整，按 60 Hz 看齐不齐就降到 16.7；阈值只影响读数，升降档判断仍然只看平均帧率。阈值非法抛 `INVALID_QUALITY_CONFIG`，`FrameStatistics` 的窗口与阈值非法抛 `INVALID_FRAME_STATISTICS_CONFIG`。
