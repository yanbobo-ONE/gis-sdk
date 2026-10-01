---
'@yanbobo/gis-sdk': minor
---

增加回放会话 `ReplaySession`（`/core`，零 Cesium）：把时钟与时间轴接成一条「时刻变化 → 提交快照」的线路，替业务处理两件容易写错的事。一是**按修订号合并提交**：快速连跳（拖时间轴滑块、连点下一步）时只有最后一次提交真正执行，过期的直接丢弃，在途提交能从 `signal` 上看到会话已更新或已销毁；二是**订阅时钟而不是只认自己的调用**，因此 `session.advance()` 与 `map.clock.bind(session.clock)` 的按帧推进走同一条路。接口含 `play` / `pause` / `seek` / `advance` / `step` / `setRate` / `setDirection` / `stop` / `refresh` / `load` / `flush` / `dispose` 与 `status`、`lastApplied`、`errorCount` 读数；`exportRange()` 按时间段取每个对象的样本，**SDK 只取数、导出格式由业务定**。快照同时给出 `time`（毫秒，与时钟一致）与 `timelineTime`（秒，与 `ReplayTimeline` 一致），单位换算只发生在会话里；时钟没有时间基准时不提交（与 `map.clock.bind()` 一致）；`apply` 失败不中断时钟，记入 `errorCount`、调用 `onError`，该次操作以 `REPLAY_APPLY_FAILED` 拒绝（原始错误在 `cause`），释放后调用抛 `REPLAY_SESSION_DISPOSED`。**不读数据、不预取、不缓存**——参照实现里的窗口预取与结构检查点（`snapshotAt`）与业务实体模型绑定，因此不在范围内。
