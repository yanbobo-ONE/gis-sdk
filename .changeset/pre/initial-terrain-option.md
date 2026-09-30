---
'@yanbobo/gis-sdk': minor
---

把外部接入点收到创建处：`createMap({ terrain })` 让地形服务地址与底图瓦片地址一样在创建时声明，并新增 `map.terrain.ready` / `map.terrain.pending` 读数。地形配置不合法（类型未知、`url` 为空、`requestVertexNormals` / `requestWaterMask` 不是布尔）在 `createMap` 时同步抛 `INVALID_TERRAIN_CONFIG`，不会先建出地图再失败；异步加载失败时 `map.terrain.type` 保持 `'ellipsoid'`（不静默换服务），错误同时经 `ready` 拒绝与 `map:error` 上报一次，因此不 `await` 也不会丢错误，初始加载在途时 `set()` 以可重试的 `TERRAIN_BUSY` 拒绝。诊断快照的 `terrain` 增加 `pending`；`/cesium` 入口补出 `TerrainSpec`、`CesiumTerrainSpec`、`EllipsoidTerrainSpec`、`TerrainSetOptions` 类型。新增[外部接入点](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/external-endpoints.md)总览页，并用源码守卫测试锁住"SDK 不内置任何外部服务地址与资产"的边界。
