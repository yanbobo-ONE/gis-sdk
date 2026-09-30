---
'@yanbobo/gis-sdk': minor
---

增加实时链路 `RealtimeSocketClient`（`/core`，零终端依赖）：连接状态机（idle / connecting / open / reconnecting / closed）、有上限指数退避重连与 0.8–1.2 抖动、心跳发送与存活超时判断、按消息类型订阅（含 `*` 通配）、解码失败与订阅方异常隔离、链路统计（消息数 / 解码失败 / 重连次数）。socket 形状按结构化类型声明，浏览器与 Node 自带 WebSocket 直接可用，其它终端通过 `factory` 注入；`send()` 在未连接时抛可重试的 `REALTIME_SOCKET_NOT_OPEN`，不缓存过期指令。
