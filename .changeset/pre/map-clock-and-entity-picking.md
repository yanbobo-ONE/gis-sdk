---
'@yanbobo/gis-sdk': minor
---

增加地图时钟 `map.clock`：读写地图时间轴（`snapshot` / `time` 读数，`setTime` / `setRange` / `setMultiplier` / `setAnimating` 控制，时间统一为毫秒时间戳），CZML 与其它带时间区间的动态实体按当前地图时间求值。`map.clock.bind(clock)` 把 `SimulationClock` 接成地图时间来源：默认按渲染帧用真实帧间隔调用 `source.advance()` 并逐帧镜像（源时钟负责倍率与方向，引擎时钟倍率恒为 1，帧间隔取非负值不会倒退），`{ drive: false }` 时只镜像、推进由业务负责；源时钟尚未 `seek()` 时不做镜像，重复绑定先解绑上一次。读不到时钟抛 `CLOCK_TIME_UNAVAILABLE`，参数非法抛 `INVALID_CLOCK_CONFIG`，销毁后调用抛 `MAP_DISPOSED`；`/cesium` 入口补出 `MapClockController`、`MapClockSnapshot`、`MapClockBindOptions` 类型。

同时增加实体级拾取：数据源里的实体不能改 `id`（那是 Cesium 的实体主键），CZML 与 GeoJSON 图层改为在加载后按对象身份登记归属，实体命中因此以 `kind: 'layer'` 回落所属图层，`objectId` 是文档里的实体 id；`setData()` 替换文档后归属自动跟随新实体，实体随数据源释放时登记条目一并回收（弱引用表，不需要业务清理）。
