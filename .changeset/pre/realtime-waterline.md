---
'@yanbobo/gis-sdk': minor
---

增加实时策略层：`RealtimeWaterline`（乱序样本按仿真时间排序释放、精确对象共同覆盖决定水位线、过期/超限/窗口丢弃统计、双阈值追赶与倍率上限、断流与失活状态）与 `RealtimeTimestampGuard`（超前异常样本隔离与连续确认），默认数值取自 Plugin-web 的生产初值。
