# 图层管理

`map.layers` 管理当前地图创建的全部 SDK 图层。地图销毁时会先释放图层，再销毁 Cesium Viewer；业务代码不需要维护第二套 Cesium 对象清单。

## 能力模型

公共句柄只提供所有图层都能可靠支持的能力，类型专属操作由对应句柄提供：

| 句柄                      | 公共能力               | 专属能力                       |
| ------------------------- | ---------------------- | ------------------------------ |
| `LayerHandle`             | 显隐、状态、事件、销毁 | 无                             |
| `GeoJsonLayerHandle`      | 公共能力               | 原子替换 GeoJSON 数据          |
| `WmsLayerHandle`          | 公共能力               | 透明度、样式、类型化过滤、重载 |
| `LayerHandle`（3D Tiles） | 公共能力               | 无；保持最小稳定接口           |

因此 WMS 不会出现无意义的 `setData()`，GeoJSON 也不会暴露无法稳定实现的影像透明度操作。

## GeoJSON

数据可以是类型化 GeoJSON 对象，也可以是 URL：

```ts
const targets = await map.layers.add({
  id: 'targets',
  type: 'geojson',
  data: '/data/targets.geojson',
  style: {
    marker: { color: '#00ff88', size: 14 },
    stroke: '#ffffff',
    strokeWidth: 2,
    fill: '#0088ff66',
    clampToGround: true,
  },
});

await targets.setData({
  type: 'FeatureCollection',
  features: [],
});
```

URL 输入通过浏览器 `fetch` 加载，必须满足宿主页面的 CORS 和 CSP。`setData()` 会先完成新数据解析和添加，再移除旧数据；失败或取消时旧数据继续显示。

加载过程可以取消：

```ts
const controller = new AbortController();

const loading = map.layers.add(
  {
    id: 'remote-targets',
    type: 'geojson',
    data: '/data/large.geojson',
  },
  { signal: controller.signal },
);

controller.abort();
await loading;
```

取消时 Promise 以 `LAYER_OPERATION_ABORTED` 拒绝。GeoJSON URL 请求会真正取消；已经进入 Cesium 的不可取消解析会被 SDK 丢弃，不会加入地图。

## WMS 与 GeoServer

```ts
import { wmsFilter } from '@yanbobo/gis-sdk/layers';

const roads = await map.layers.add({
  id: 'roads',
  type: 'wms',
  url: 'https://maps.example/geoserver/wms',
  layers: ['city:roads', 'city:labels'],
  opacity: 0.75,
  style: 'night',
  filter: wmsFilter.and(wmsFilter.eq('status', 'OPEN'), wmsFilter.gte('priority', 2)),
  parameters: {
    transparent: true,
    format: 'image/png',
    tiled: true,
  },
});

roads.setOpacity(0.5);
await roads.setStyle('day');
await roads.setFilter(wmsFilter.like('name', 'Airport%'));
await roads.reload();
```

`wmsFilter` 会校验属性名、拒绝非有限数字并转义字符串。稳定接口不接受原始 CQL 字符串，`parameters` 也不能绕过接口设置 `cql_filter`、`styles` 或 `layers`。

CQL 是 GeoServer 扩展，不是通用 WMS 标准。其他 WMS 服务是否支持过滤取决于服务端；创建 WMS 图层成功表示 Provider 已注册，不表示所有瓦片已经下载完成。

## 3D Tiles

3D Tiles 使用与其他图层一致的 `map.layers.add()` 生命周期。SDK 在加载成功后才把
Tileset 加入场景；页面销毁、`map.layers.remove()`、`map.layers.clear()` 或句柄
`dispose()` 都会释放它拥有的 Cesium Primitive。

```ts
const city = await map.layers.add({
  id: 'city',
  type: '3d-tiles',
  url: '/tiles/city/tileset.json',
  maximumScreenSpaceError: 8,
  skipLevelOfDetail: true,
});

city.setVisible(false);
await city.dispose();
```

| 字段                      | 类型         | 必填 | 默认值/效果                                                              |
| ------------------------- | ------------ | ---- | ------------------------------------------------------------------------ |
| `id`                      | `string`     | 是   | 地图内唯一 ID                                                            |
| `type`                    | `'3d-tiles'` | 是   | 固定值                                                                   |
| `url`                     | `string`     | 是   | 非空 `tileset.json` 或兼容 3D Tiles 服务地址；会去除首尾空格             |
| `visible`                 | `boolean`    | 否   | `true`；加载完成后写入 Tileset 的 `show`                                 |
| `maximumScreenSpaceError` | `number`     | 否   | Cesium 默认 `16`；正有限像素值，值越小细节越高且会增加网络、CPU/GPU 压力 |
| `skipLevelOfDetail`       | `boolean`    | 否   | Cesium 默认 `false`；开启其层级跳跃遍历优化，不等同于性能或容量保证      |

非法 URL、非正/非有限的 `maximumScreenSpaceError` 或非布尔的
`skipLevelOfDetail` 会抛出 `INVALID_LAYER_CONFIG`。下载或 Tileset 解析失败会抛出
可重试的 `LAYER_LOAD_FAILED`；通过 `AbortSignal` 或图层管理器取消加载时，Promise
以 `LAYER_OPERATION_ABORTED` 拒绝。若 Cesium 在取消后才完成加载，SDK 会直接销毁
该 Tileset，不会把它加入场景。

当前稳定接口不包含 Tileset 变换、样式、裁剪、分类、拾取策略、缓存预算、更多
LOD 参数、glTF / 模型、CZML、动态实体或自动性能调优。需要这些能力时可以通过
`map.raw.viewer` 使用 Cesium 公共 API，并由业务代码负责对象所有权、释放和升级兼容性。

## 查询与释放

```ts
const info = map.layers.list();
const roads = map.layers.get('roads');

roads?.setVisible(false);
await map.layers.remove('roads');
await map.layers.clear();
```

直接调用句柄的 `dispose()` 也会从管理器移除。销毁是幂等的；清理失败会抛出可重试的 `LAYER_DISPOSE_FAILED` 或 `LAYER_CLEAR_FAILED`。

## 原生 Cesium 出口

SDK 尚未覆盖的高级能力仍可通过 `map.raw.viewer` 使用 Cesium 公共接口。直接修改 `viewer.dataSources`、`viewer.imageryLayers` 中由 SDK 拥有的对象，会破坏 SDK 的资源所有权和状态判断；访问 `_root`、`_layers`、`_materialCache` 等私有字段不属于兼容承诺。
