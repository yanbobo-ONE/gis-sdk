---
'@yanbobo/gis-sdk': minor
---

增加仿真事件调度 `SimulationEventScheduler`（`/core`，零 Cesium）：按时间维护业务事件表，同 `id` 再次 `add()` 视为**改期**（替换原事件而不是并列两条），`remove()` / `clear()` 取消，`between(from, to, direction?)` 按播放方向取区间——正向 `(from, timeSeconds <= to]` 升序、反向降序，两个方向都是**起点不重复触发、终点触发一次**，因此回放循环用"上一帧 → 这一帧"连续取值不会重复触发事件。时间单位与 `ReplayTimeline` 一致（秒），与 `map.clock`（毫秒）对齐时自行换算。调度器不持计时器、不依赖引擎，也不设容量上限（面向百量级业务事件表）；非法事件与区间抛 `INVALID_SIMULATION_INPUT`。
