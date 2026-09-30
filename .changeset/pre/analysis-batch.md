---
'@yanbobo/gis-sdk': minor
---

增加批量分析执行 `runAnalysisBatch(controller, items, options)`：在跑的任务数不超过 `concurrency`（默认 4，1 到 32），逐条失败隔离（某条报错不影响其余），返回结果与输入**同序**便于与业务行对齐，`onProgress` 按完成顺序回调 `{ completed, failed, total, running, pending }`；`signal` 中止后不再派发新任务、在途任务拿到同一个信号，函数返回部分结果并把 `cancelled` 置为 `true`。可与 `createAnalysisWorkerPool()` 叠加使用（池管跑在哪，批量管怎么编排）。
