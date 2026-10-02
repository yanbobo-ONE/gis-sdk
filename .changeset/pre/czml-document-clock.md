---
'@yanbobo/gis-sdk': minor
---

CZML 文档自带的 `clock` 现在有读数：`/core` 新增 `readCzmlClock(document)`（解析 `clock.interval` 与 `currentTime`，统一给出毫秒时间戳；区间缺失、格式非法或终点早于起点时返回 `undefined`，这是读数不抛错），CZML 图层句柄新增 `layer.clock` 对照当前文档，`setData()` 换文档后跟着换。**SDK 仍不会自动把文档时钟应用到地图时钟**——同一张地图上可能有多个文档，谁是主时间轴只有业务知道——但业务不必再自己解析 ISO 区间：`map.clock.setRange(clock.startTime, clock.endTime)` 即可，要由 `SimulationClock` 决定播放状态就把它喂给时钟再 `map.clock.bind()`。
