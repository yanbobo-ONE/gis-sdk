# 诊断快照 map.diagnostics

`map.diagnostics.snapshot()` 一次拿到地图当前的关键读数：生命周期、相机、渲染质量与帧率、图层与错误计数、底图、地形、场景模式、环境效果、绘制状态。它面向**线上排查与验收自检**——日志上报、面板展示、自动化断言都只需要一次调用。

```ts
const snapshot = map.diagnostics.snapshot();

snapshot.state; // 'ready' | 'destroying' | 'destroyed'
snapshot.camera.view; // { longitude, latitude, height, heading, pitch, roll } | undefined
snapshot.camera.recoveryCount; // 相机位姿安全网累计恢复次数
snapshot.quality.fps; // 滑动窗口平均帧率
snapshot.quality.degraded; // 是否已降到初始质量之下
snapshot.layers; // [{ id, type, state, visible, errorCount }]
snapshot.basemap.errorCount; // 底图首个远端失败后的累计计数
snapshot.terrain; // { type, pending }：已安装地形与是否有安装 / 切换在途
snapshot.environment; // 当前生效的环境效果状态
snapshot.drawing.editing; // 是否在编辑会话中
```

## 采集口径

- **只汇总已有读数**：不新增采集、不留历史、不写日志；快照只反映调用时刻。
- **永不抛错**：读不到的字段用 `undefined` 表达（例如相机位姿不可读时 `camera.view` 为 `undefined`，`camera.recoveryCount` 仍可用）。排查现场最怕"取诊断把程序打挂"，这条是硬约定。
- **不做隐私裁剪**：快照里没有业务数据，只有 SDK 自己的运行状态；业务自己的字段请在业务侧采集。
- **不碰引擎私有字段**：相机恢复次数由适配器通过 `getEngineDiagnostics()` 上报，引擎不提供时按 0 处理。其它终端只要实现 `MapEngineAdapter`，同一份快照就能用。

## 推荐用法

```ts
// 1) 出错时上报
map.events.on('map:error', ({ error }) => {
  report({ error, diagnostics: map.diagnostics.snapshot() });
});

// 2) 验收自检：地图就绪后断言"图层都加载完、没有远端失败"
const { layers, quality } = map.diagnostics.snapshot();
if (layers.some((layer) => layer.state !== 'ready' || layer.errorCount > 0)) {
  throw new Error('图层未全部就绪');
}

// 3) 面板展示：把 fps 与降档状态做成常驻读数
const { quality } = map.diagnostics.snapshot();
badge.textContent = `${quality.fps.toFixed(0)} fps${quality.degraded ? ' · 已降档' : ''}`;
```

与相邻模块的分工：图层与底图的 `errorCount` 记录**远端失败次数**（只上报首个失败事件），`map.events.on('map:error')` 是**事件流**，`map.diagnostics.snapshot()` 是**当前状态快照**。三者互补：事件流用于实时告警，快照用于事后复盘。

## 当前边界

- **不做持续监控**：没有采样定时器、没有指标导出、没有告警阈值；需要时序数据时业务按固定间隔调用 `snapshot()` 并自行上报。
- **不含实时链路读数**：`RealtimeSocketClient.stats` 与 `DataPipeline` 统计由业务在自己的编排层采集，SDK 不做跨模块聚合（避免为了诊断把实时链路也拖进地图实例）。
- **不含 Worker 与设备信息**：Worker 池尚未发布，`navigator.gpu`、内存等设备读数属于宿主环境，不在 SDK 承诺范围。
