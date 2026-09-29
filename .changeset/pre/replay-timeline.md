---
'@yanbobo/gis-sdk': minor
---

增加回放时间轴 `ReplayTimeline`（`/core`，零 Cesium 依赖）：按对象分组保存样本，负责时间排序、同刻去重、容量上限、`sampleAt()` 插值查询、`latest()` 取最近样本、`window()` / `trackAt()` 窗口切片与有界外推；插值与复制函数由调用方注入，SDK 不对样本内容做任何假设，也不读数据源或做缓存策略。非法配置与时间抛 `INVALID_REPLAY_INPUT`。
