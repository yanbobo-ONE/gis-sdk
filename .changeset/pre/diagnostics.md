---
'@yanbobo/gis-sdk': minor
---

增加诊断快照 `map.diagnostics.snapshot()`：一次调用汇总生命周期状态、相机位姿与安全网恢复次数、渲染质量与帧采样、图层（含 `errorCount`）、底图、地形、场景模式、环境效果与绘制 / 编辑状态。生成快照永不抛错（读不到的字段用 `undefined` 表达），只汇总 SDK 已有读数、不新增采集；引擎侧读数通过 `MapEngineAdapter.getEngineDiagnostics()` 注入，其它终端实现同一契约即可复用。
