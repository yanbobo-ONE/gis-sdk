---
'@yanbobo/gis-sdk': minor
---

增加分析 Worker 执行接口：`createAnalysisWorkerClient(port, options)` 在主线程侧把 `run()` 转发给 Worker（按 id 匹配、`signal` 取消双向生效、默认 30 秒超时以 `ANALYSIS_WORKER_TIMEOUT` 拒绝、销毁以 `ANALYSIS_WORKER_DISPOSED` 拒绝在途请求），`createAnalysisWorkerHost(port, { controller })` 在 Worker 侧串行执行并把结果 / 失败回传；失败响应保留 `GisError` 的 `code` 与 `retryable`，因此按代码分支的逻辑跨线程仍然成立。同时导出消息协议的类型与守卫、`analysisTools` 内置工具清单，以及运行时错误码清单 `GIS_ERROR_CODES` / `isGisErrorCode()`。
