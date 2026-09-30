---
'@yanbobo/gis-sdk': minor
---

增加分析 Worker 池 `createAnalysisWorkerPool(ports, options)`：调度采用**最小在途优先**（默认每个 Worker 串行、`maxPendingPerWorker: 1`），全部饱和时请求进入 FIFO 队列，队列上限默认 32、超出以可重试的 `ANALYSIS_WORKER_QUEUE_FULL` 拒绝；提供 `stats`（workers / pending / queued / completed / failed）与 `dispose()`（销毁全部客户端并拒绝排队请求）。每个 Worker 复用 `createAnalysisWorkerClient()`，取消、超时与错误码还原语义与单 Worker 完全一致。
