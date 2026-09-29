---
'@yanbobo/gis-sdk': minor
---

增加仿真 / 回放时钟 `SimulationClock`：播放状态机（idle/playing/paused/ended/stalled）、倍率与方向、seek/step、实时模式下的水位线限速、停滞原因与状态订阅；时间推进只由 `advance(真实增量)` 驱动，可用假时间做确定性测试。
