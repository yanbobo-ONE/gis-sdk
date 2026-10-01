# WMS、TMS、WMTS 与单图影像图层

本页用于接入服务端地图影像。所有类型都通过 `map.layers.add()` 创建：WMS 适合带样式和属性过滤的服务；TMS/WMTS 适合标准瓦片服务；单图影像适合已有地理配准范围的 PNG、JPG 或 WebP 图。

## WMS：样式与类型化过滤

```ts
import { wmsFilter } from '@yanbobo/gis-sdk/layers';

const roads = await map.layers.add({
  id: 'roads',
  type: 'wms',
  url: 'https://maps.example.com/geoserver/wms',
  layers: ['city:roads', 'city:labels'],
  opacity: 0.75,
  style: 'night',
  filter: wmsFilter.eq('status', 'OPEN'),
  parameters: { transparent: true, format: 'image/png', tiled: true },
});
```

| 字段         | 类型                                          | 必填 | 说明                       |
| ------------ | --------------------------------------------- | ---- | -------------------------- |
| `url`        | `string`                                      | 是   | 非空 WMS GetMap 服务地址   |
| `layers`     | `string \| readonly string[]`                 | 是   | 一个、逗号分隔或多个图层名 |
| `opacity`    | `number`                                      | 否   | `0` 到 `1`，默认 `1`       |
| `style`      | `string`                                      | 否   | 服务端样式名               |
| `filter`     | `WmsFilter`                                   | 否   | 类型化 CQL 过滤条件        |
| `parameters` | `Record<string, string \| number \| boolean>` | 否   | 附加 GetMap 参数           |

`parameters` 不能写入 `layers`、`styles`、`cql_filter`；必须使用对应类型化字段，避免原始 CQL 拼接。

### WMS 句柄方法

```ts
roads.setOpacity(0.5);
await roads.setStyle('day');
await roads.setFilter(wmsFilter.like('name', 'Airport%'));
await roads.reload();
```

| 方法                 | 参数/返回                                 | 效果                                |
| -------------------- | ----------------------------------------- | ----------------------------------- |
| `setOpacity(value)`  | `0..1`，`void`                            | 即时改透明度，不重建 Provider       |
| `setStyle(style?)`   | `string \| undefined`，`Promise<void>`    | 原子替换 Provider；空字符串清除样式 |
| `setFilter(filter?)` | `WmsFilter \| undefined`，`Promise<void>` | 原子替换 Provider；省略清除过滤     |
| `reload()`           | `Promise<void>`                           | 用当前配置重建 Provider             |

`setStyle`、`setFilter` 或 `reload` 失败时旧画面继续显示。CQL 是 GeoServer 扩展，其他 WMS 服务是否支持由服务端决定。

## 带鉴权的服务：自定义请求头

企业影像服务常把凭证放在 **HTTP 头**里（Bearer token、租户标识、API Key），而不是查询串——查询串会进日志与浏览器历史，头不会。四种影像图层与 XYZ 底图都支持 `headers`：

```ts
await map.layers.add({
  id: 'secure-wms',
  type: 'wms',
  url: 'https://maps.example.com/geoserver/wms',
  layers: 'city:coverage',
  headers: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': 'tenant-1' },
});

map.basemap.set({
  type: 'xyz',
  url: 'https://tiles.example.com/{z}/{x}/{y}.png',
  headers: { Authorization: `Bearer ${token}` },
});
```

| 规则     | 说明                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| 名称校验 | 必须是合法 HTTP 字段名（RFC 7230 token），含空格或换行的名称会被拒绝并报 `INVALID_LAYER_CONFIG` |
| 值校验   | 必须是字符串；允许空值（某些服务用"存在即生效"的标记头）                                        |
| 生效范围 | 该图层的**每一次**瓦片 / 图片请求；底层把地址包成 Cesium 的 `Resource`                          |
| 凭证刷新 | **不在 SDK 范围**：token 过期后由业务重建图层或更新配置，SDK 不做自动续期                       |
| 传输安全 | 头里的凭证仍会出现在网络面板与代理日志里，请配合 HTTPS 与最小权限 token 使用                    |

**不要**把凭证塞进 `url` 查询串再交给 SDK——那样它会出现在日志、错误上报与截图里；能放头就放头。

## TMS：目录或 tilemapresource.xml

```ts
const terrain = await map.layers.add({
  id: 'terrain',
  type: 'tms',
  url: '/tiles/terrain',
  fileExtension: 'jpg',
  maximumLevel: 12,
  opacity: 0.8,
});
```

| 字段                            | 类型      | 必填 | 默认值/效果                          |
| ------------------------------- | --------- | ---- | ------------------------------------ |
| `url`                           | `string`  | 是   | TMS 目录或元数据地址；首尾空格会去除 |
| `opacity`                       | `number`  | 否   | `1`，范围 `0..1`                     |
| `fileExtension`                 | `string`  | 否   | Cesium 默认 `png`                    |
| `minimumLevel` / `maximumLevel` | `number`  | 否   | 非负整数；最大层级不得小于最小层级   |
| `tileWidth` / `tileHeight`      | `number`  | 否   | 正整数像素                           |
| `flipXY`                        | `boolean` | 否   | 兼容旧版 gdal2tiles X/Y 翻转         |

TMS 会异步读取元数据；取消加载时以 `LAYER_OPERATION_ABORTED` 拒绝，迟到的 Provider 不会加入地图。

## WMTS：KVP 或 REST 瓦片

```ts
const satellite = await map.layers.add({
  id: 'satellite',
  type: 'wmts',
  url: 'https://maps.example.com/wmts',
  layer: 'city:satellite',
  style: 'default',
  tileMatrixSetID: 'WebMercatorQuad',
  format: 'image/jpeg',
  maximumLevel: 18,
  tileMatrixLabels: ['0', '1', '2'],
});
```

| 字段                            | 类型                          | 必填 | 说明                         |
| ------------------------------- | ----------------------------- | ---- | ---------------------------- |
| `url`                           | `string`                      | 是   | KVP GetTile 地址或 REST 模板 |
| `layer`                         | `string`                      | 是   | WMTS 图层标识，不能为空      |
| `style`                         | `string`                      | 是   | WMTS 样式标识，不能为空      |
| `tileMatrixSetID`               | `string`                      | 是   | TileMatrixSet 标识，不能为空 |
| `format`                        | `string`                      | 否   | Cesium 默认 `image/jpeg`     |
| `enablePickFeatures`            | `boolean`                     | 否   | Cesium GetFeatureInfo 策略   |
| `minimumLevel` / `maximumLevel` | `number`                      | 否   | 非负整数，且层级范围有效     |
| `tileMatrixLabels`              | `readonly string[]`           | 否   | 每个层级的 TileMatrix 标识   |
| `subdomains`                    | `string \| readonly string[]` | 否   | REST 模板 `{s}` 的子域名     |

## 单图影像：覆盖指定范围的图片

```ts
const survey = await map.layers.add({
  id: 'survey-2026',
  type: 'single-image',
  url: '/images/survey-2026.png',
  rectangle: { west: 115.8, south: 39.6, east: 116.8, north: 40.4 },
  opacity: 0.7,
});
```

| 字段        | 类型                           | 必填 | 说明                                                                                                    |
| ----------- | ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------- |
| `url`       | `string`                       | 是   | 单张影像 URL；首尾空格会去除                                                                            |
| `rectangle` | `{ west, south, east, north }` | 否   | WGS84 度数范围；经度在 `-180..180`，纬度在 `-90..90`，且 `west < east`、`south < north`。省略时覆盖全局 |
| `opacity`   | `number`                       | 否   | `0` 到 `1`，默认 `1`                                                                                    |
| `visible`   | `boolean`                      | 否   | 默认 `true`                                                                                             |

图像必须已按上述范围完成地理配准；SDK 不读取世界文件、投影文件或影像 EXIF。跨日期变更线的图像需由业务拆分后分别添加。

## 影像图层共有句柄：ImageryLayerHandle

```ts
terrain.setVisible(false);
satellite.setOpacity(0.65);
await satellite.dispose();
```

| 方法/属性                       | 效果                                            |
| ------------------------------- | ----------------------------------------------- |
| `visible` / `setVisible(value)` | 读取或修改 `ImageryLayer.show`，不重建 Provider |
| `opacity` / `setOpacity(value)` | 读取或修改 `ImageryLayer.alpha`，范围 `0..1`    |
| `dispose()`                     | 幂等调用 `imageryLayers.remove(layer, true)`    |

非法配置为 `INVALID_LAYER_CONFIG`，透明度非法为 `INVALID_LAYER_OPACITY`，Provider 创建失败为可重试的 `LAYER_LOAD_FAILED`。

::: info 当前边界
SDK 不解析 WMTS Capabilities XML，也不封装动态时间/维度、矢量瓦片、企业鉴权参数或自动 LOD。
:::
