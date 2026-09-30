---
'@yanbobo/gis-sdk': minor
---

影像图层与底图支持自定义请求头 `headers`：WMS / TMS / WMTS / 单图影像四种图层与 XYZ 底图都可以带 `{ Authorization: 'Bearer …' }`、`X-Tenant-Id`、API Key 这类鉴权头（底层把 URL 包成 Cesium 的 `Resource`，对该图层的每次瓦片 / 图片请求生效）。名称按 RFC 7230 token 校验、值必须是字符串（允许空值），非法配置抛 `INVALID_LAYER_CONFIG`；**凭证刷新策略不在 SDK 范围**，token 过期由业务重建图层或更新配置。
