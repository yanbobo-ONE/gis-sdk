# 外部接入点

这一页回答一个问题：**SDK 什么时候会联网、地址从哪来**。

结论先说：SDK **不内置任何外部服务地址**，也不附带瓦片、地形、纹理或模型资产。每一处联网能力的地址都由调用方通过公开选项给出；不给地址就不发请求（`createMap` 默认连在线底图和 Cesium ion 都不请求）。因此换服务商、切内网、走反向代理都只是改一处配置，不需要打补丁或替换 SDK 代码。

## 接入点一览

| 接入点                           | 公开入口                                                                       | 不给地址时的行为                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Cesium 静态资源（Workers 等）    | `createMap({ cesiumBaseUrl })`                                                 | 沿用 Cesium 自动解析；首个 Viewer 创建后全局锁定                                 |
| XYZ 瓦片底图                     | `createMap({ basemap })` 或 `map.basemap.set({ type: 'xyz', url })`            | 不加载在线影像（`baseLayer: false`）                                             |
| 影像服务 WMS / TMS / WMTS / 单图 | `map.layers.add({ type: 'wms' \| 'tms' \| 'wmts' \| 'single-image', url })`    | 无默认服务；`url` 为必填，为空即 `INVALID_LAYER_CONFIG`                          |
| 3D Tiles                         | `map.layers.add({ type: 'tiles3d', url })`                                     | 同上，无默认数据集                                                               |
| 静态模型 glTF / GLB              | `map.layers.add({ type: 'model', url })`                                       | 同上，无默认模型                                                                 |
| 地形（Cesium Terrain）           | `createMap({ terrain })` 或 `map.terrain.set({ type: 'cesium-terrain', url })` | 保持椭球地形，不发出任何地形请求                                                 |
| 矢量数据 GeoJSON / CZML          | `map.layers.add({ type: 'geojson' \| 'czml', data })`                          | `data` 传字符串时按 URL 拉取；传对象时完全离线                                   |
| 实时长连接                       | `new RealtimeSocketClient({ url })`                                            | `url` 为必填，无默认端点                                                         |
| 分析 Worker                      | 由业务注入端口：`createAnalysisWorkerClient(port)`                             | SDK 不指定 Worker 脚本地址，脚本打包方式留给业务                                 |
| 其他原生能力                     | `map.raw.viewer`                                                               | 不封装；接入与资源释放都由业务负责（见[错误与原生出口](./errors-and-native.md)） |

需要鉴权的服务（企业影像服务、私有瓦片、内网地形）把凭证放在请求头里，而不是查询串：

```ts
map.layers.add({
  type: 'wms',
  id: 'private-imagery',
  url: 'https://gis.internal.example/wms',
  layers: 'base',
  headers: { Authorization: 'Bearer <token>' },
});
```

`headers` 同样适用于 `createMap({ basemap })` 与 `map.basemap.set()`。SDK 只负责把业务给的请求头带上每次请求，**不负责凭证续期**：令牌过期时由业务重建图层或重新配置底图。细节见[影像图层](./imagery-layers.md)。

## 创建期声明地形地址

地形与底图一样可以在创建时声明，不必先建图再设置：

```ts
const map = createMap({
  container: 'map',
  cesiumBaseUrl: '/cesium/',
  basemap: { type: 'xyz', url: '/tiles/{z}/{x}/{y}.png' },
  terrain: { type: 'cesium-terrain', url: 'https://terrain.example.com/' },
});

await map.terrain.ready; // 初始地形安装完成；失败则在这里拒绝
```

- `{ type: 'ellipsoid' }` 同步生效，不发网络请求。
- `{ type: 'cesium-terrain', url }` 异步拉取元数据；`map.terrain.pending` 在途为 `true`，此时调用 `map.terrain.set()` 会以可重试的 `TERRAIN_BUSY` 拒绝。
- 加载失败时 `map.terrain.type` 保持 `'ellipsoid'`（不会静默换服务），错误同时经 `map.terrain.ready` 拒绝与 `map:error` 上报一次；错误码 `TERRAIN_LOAD_FAILED` 可重试。
- 配置本身不合法（类型未知、`url` 为空、开关不是布尔）在 `createMap` 时同步抛 `INVALID_TERRAIN_CONFIG`，不会先建出地图再失败。

因此"创建期声明地形"只有两条需要处理的路径：`await map.terrain.ready` 走成功分支，或在 `map:error` 里统一收错误。

## 自检：地址是否真的由业务掌握

接入点是否被写死，可以用三个只读手段确认，都不需要读 SDK 源码：

1. `map.diagnostics.snapshot().terrain` 给出 `{ type, pending }`，配合 `map.basemap.type` / `errorCount` 区分"没配"和"配了但服务不可用"。
2. `map:error` 事件只上报首个失败（底图瓦片、地形元数据），避免瓦片级错误刷屏。
3. 仓库测试 `tests/external-endpoints.test.ts` 会扫描 `src/`，出现绝对 URL、`localhost`、ion 资产标识即失败——这条守卫保证"不内置地址"不会在某次提交里被悄悄破坏。
4. 验收台的"创建期声明地形"按钮用本地元数据 fixture 跑真实请求：面板给出 `类型 / 加载中 pending / 兑现后 pending` 三个读数，`/__test/terrain-state` 给出 `layerJsonRequests`，用来确认创建期声明的地址确实被请求（步骤见[示例说明](https://github.com/yanbobo-ONE/gis-sdk/blob/main/examples/vanilla/README.md)）。

## 明确不做的事

| 不做                       | 原因                                                   |
| -------------------------- | ------------------------------------------------------ |
| 附带瓦片 / 地形 / 纹理资产 | SDK 不带外部资产，服务与数据都由业务提供               |
| 内置 Cesium ion 资产       | 默认关闭，避免隐式依赖第三方账号与配额                 |
| 凭证申请与自动续期         | 令牌生命周期属业务；SDK 只做"把给定请求头带上每次请求" |
| 代理与跨域处理             | 由部署层（网关、反向代理）解决，SDK 不改变请求语义     |
| 服务目录与服务端协议       | 属业务后端协议；SDK 只消费调用方给出的地址与参数       |

## 相关页面

- [地图控制](./map-controls.md)：`map.basemap`、`map.terrain` 的参数与异常边界
- [影像图层](./imagery-layers.md)：WMS / TMS / WMTS / 单图的样式、过滤与请求头
- [图层管理](./layer-management.md)：图层的添加、查询与释放
- [实时链路](./realtime-socket.md)：长连接的地址、重连与订阅
- [错误与原生出口](./errors-and-native.md)：`map:error` 与 `map.raw.viewer` 的所有权边界
