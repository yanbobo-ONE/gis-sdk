---
'@yanbobo/gis-sdk': minor
---

增加实时会话门禁与重同步控制器：`RealtimeSessionGate`（会话只能由首条带会话 id 的消息或显式控制消息建立/切换，旧会话迟到包一律丢弃）与 `RealtimeResyncController`（序列断档转入快照等待、同一断档重复上报合并、请求上限与增量追赶状态机）。
