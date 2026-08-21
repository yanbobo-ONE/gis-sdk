# API 使用参考

本页按实际调用任务说明当前已发布的 alpha 出口。每个方法都列出参数、返回值、运行效果和常见异常；需要查看完整 TypeScript 结构时，使用[类型索引](/api/)。功能是否已完成、何时变更，以[功能状态与路线图](/guide/capability-status)为准。

## 从安装到运行

下面的流程可以直接放进原生页面、Vue、React 或其他前端框架的组件生命周期中。示例使用空白地球，因此不需要 Cesium ion token；WMS 地址替换成实际服务地址即可显示业务数据。

```bash
pnpm add @yanbobo/gis-sdk@alpha
pnpm exec gis-sdk-copy-assets public/cesium
```

```html
<div id="map"></div>
```

```css
#map {
  width: 100%;
  height: 100vh;
}
```

```ts
import { createMap } from '@yanbobo/gis-sdk/cesium';
import { wmsFilter } from '@yanbobo/gis-sdk/layers';
import '@yanbobo/gis-sdk/styles.css';

const map = createMap({
  container: 'map',
  cesiumBaseUrl: '/cesium/',
  scene: { mode: '3d' },
});

const offError = map.events.on('map:error', ({ error }) => {
  console.error(error.code, error.operation, error.retryable);
});

const areas = await map.layers.add({
  id: 'areas',
  type: 'geojson',
  data: '/data/areas.geojson',
  style: { fill: '#249b6a66', stroke: '#dce7e1', strokeWidth: 2 },
});

const roads = await map.layers.add({
  id: 'roads',
  type: 'wms',
  url: 'https://maps.example.com/geoserver/wms',
  layers: 'city:roads',
  filter: wmsFilter.eq('status', 'OPEN'),
});

roads.setOpacity(0.65);
await areas.setData('/data/areas-next.geojson');

const observer = new ResizeObserver(() => map.resize());
observer.observe(document.querySelector('#map')!);

// 在组件卸载、路由离开或场景切换时调用。
async function disposeMap() {
  offError();
  observer.disconnect();
  await map.destroy();
}
```

运行效果：创建一个不带在线默认底图的 Cesium Viewer，加入一个 GeoJSON 数据源和一个 WMS 影像图层。`setOpacity()` 即时更新影像透明度，`setData()` 成功后才替换旧 GeoJSON；销毁时会取消加载任务、清理图层和 Viewer。

如需初始化 XYZ 底图、切换地形或控制相机，请阅读[地图控制](/guide/map-controls)。
动态更新的有界缓冲、同键合并与批量读取见[数据管线](/guide/data-pipeline)。

## 当前已发布与未发布 API

| 范围                                                        | 状态                        | 应使用的入口                                                         |
| ----------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| 地图生命周期与事件                                          | 可用                        | `createMap`、`map.resize`、`map.destroy`、`map.events`               |
| GeoJSON 与 WMS 图层                                         | 可用                        | `map.layers`、`GeoJsonLayerHandle`、`WmsLayerHandle`、`wmsFilter`    |
| Cesium 原生公共能力                                         | 可用，但不纳入 SDK 封装承诺 | `map.raw.viewer`                                                     |
| XYZ 底图、相机、椭球 / Cesium Terrain 地形                  | 可用                        | `createMap({ basemap })`、`map.basemap`、`map.camera`、`map.terrain` |
| 数据管线核心                                                | 可用                        | `DataPipeline`（从 `/core` 或包根导入）                              |
| TMS/WMTS、3D Tiles、模型、动态实体                          | 未发布                      | 没有对应 SDK 方法                                                    |
| Worker 管线、海量数据渲染、绘制、材质、空间分析、插件、诊断 | 未发布                      | 没有对应 SDK 方法                                                    |

不要根据规划名称猜测调用方式。后续版本完成能力后，会在本页新增真实导出、参数表、运行效果和最小示例，同时在[功能状态与路线图](/guide/capability-status)记录版本。

## createMap(options)

创建一个拥有独立生命周期和图层管理器的 Cesium 地图实例。

```ts
import { createMap } from '@yanbobo/gis-sdk/cesium';

const map = createMap({
  container: 'map',
  id: 'operations-map',
  cesiumBaseUrl: '/cesium/',
  scene: { mode: '3d' },
  widgets: {
    fullscreenButton: true,
    homeButton: true,
  },
});
```

### 参数

| 参数            | 类型                    | 必填 | 默认值                | 作用                                                         |
| --------------- | ----------------------- | ---- | --------------------- | ------------------------------------------------------------ |
| `container`     | `string \| HTMLElement` | 是   | -                     | Viewer 容器元素或元素 ID；字符串会去除首尾空格               |
| `id`            | `string`                | 否   | `crypto.randomUUID()` | 地图实例标识，用于事件和错误定位                             |
| `cesiumBaseUrl` | `string`                | 否   | 沿用 Cesium 当前配置  | `Workers`、`Assets`、`ThirdParty`、`Widgets` 的共同父路径    |
| `scene.mode`    | `'2d' \| '3d'`          | 否   | `'3d'`                | 初始场景模式                                                 |
| `basemap`       | `XyzBasemapSpec`        | 否   | 不加载在线底图        | 初始化 SDK 管理的 XYZ 底图；模板必须包含 `{z}`、`{x}`、`{y}` |
| `widgets`       | `CesiumWidgetOptions`   | 否   | 全部关闭              | 按字段启用 Cesium Viewer 控件                                |

`widgets` 支持 `animation`、`baseLayerPicker`、`fullscreenButton`、`geocoder`、`homeButton`、`infoBox`、`navigationHelpButton`、`sceneModePicker`、`selectionIndicator` 和 `timeline`。

**返回值：** `CesiumMap`。创建调用是同步的；返回时 Viewer 和 `map.layers` 已建立。

**运行效果：** 默认不创建在线底图，不要求 Cesium ion token。`cesiumBaseUrl` 是当前页面进程的 Cesium 全局配置，第一个成功创建的 Viewer 会锁定该地址。

**可能抛出：**

- `INVALID_CONTAINER`：容器字符串为空。
- `INVALID_BASEMAP_CONFIG`：初始 XYZ 模板、类型或显隐配置无效。
- `INVALID_BASEMAP_OPACITY`：初始底图透明度不是 `0` 到 `1` 的有限数。
- `CESIUM_BASE_URL_CONFLICT`：已有地图使用了其他静态资源根路径。
- Cesium Viewer 构造产生的原始错误，例如容器元素不存在或 WebGL 不可用。

创建成功后的实际效果是：Viewer 已绑定到容器，`map.layers` 可以立即使用；但网络图层尚未被添加。`cesiumBaseUrl` 与 `gis-sdk-copy-assets public/cesium` 的目标目录对应，最终部署时应确保 `/cesium/Workers`、`/cesium/Assets`、`/cesium/ThirdParty` 和 `/cesium/Widgets` 都可访问。

## 地图实例

### map.resize()

```ts
const observer = new ResizeObserver(() => map.resize());
observer.observe(document.querySelector('#map')!);
```

无参数、无返回值。通知 Viewer 重新计算画布尺寸，适用于容器大小变化、侧栏折叠或全屏切换。地图销毁中或销毁后调用会抛出 `MAP_DISPOSED`。

### map.destroy()

```ts
onUnmounted(async () => {
  await map.destroy();
});
```

无参数，返回 `Promise<void>`。SDK 会先取消加载中任务并清理全部图层，再销毁 Viewer 和事件监听器。

并发调用共享同一次销毁操作；成功后重复调用直接完成。图层或 Viewer 清理失败会抛出 `MAP_DESTROY_FAILED`，`retryable` 为 `true` 时可再次调用。

### map.state

只读值：`'ready' | 'destroying' | 'destroyed'`。它描述地图资源生命周期，不代表网络图层已经下载完全部瓦片。

### map.events.on(type, listener)

```ts
const offError = map.events.on('map:error', ({ id, error }) => {
  console.error(id, error.code, error.operation, error.retryable);
});

const offDestroy = map.events.on('map:destroy', ({ id }) => {
  console.log(`${id} destroyed`);
});

offError();
offDestroy();
```

| 参数       | 类型                           | 说明       |
| ---------- | ------------------------------ | ---------- |
| `type`     | `'map:error' \| 'map:destroy'` | 事件名称   |
| `listener` | `(event) => void`              | 同步监听器 |

返回幂等取消函数 `Unsubscribe`。`once(type, listener)` 参数相同，但监听器最多执行一次。

## map.layers.add(spec, options?)

添加图层并返回与 `spec.type` 对应的能力句柄。

```ts
const layer = await map.layers.add(
  {
    id: 'targets',
    type: 'geojson',
    data: '/data/targets.geojson',
  },
  { signal: abortController.signal },
);
```

| 参数             | 类型                               | 必填 | 说明                         |
| ---------------- | ---------------------------------- | ---- | ---------------------------- |
| `spec`           | `GeoJsonLayerSpec \| WmsLayerSpec` | 是   | 带 `type` 判别字段的图层配置 |
| `options.signal` | `AbortSignal`                      | 否   | 取消尚未完成的加载           |

**返回值：** `Promise<GeoJsonLayerHandle | WmsLayerHandle>`。TypeScript 会根据 `type` 自动推导具体句柄。

**运行效果：** ID 在加载开始前即被预留，避免两个并发请求创建同名图层。Promise 完成后图层才会被 `get()` 和 `list()` 看见。

**常见异常：** `INVALID_LAYER_ID`、`DUPLICATE_LAYER_ID`、`LAYER_OPERATION_ABORTED`、`LAYER_LOAD_FAILED`、`LAYER_MANAGER_BUSY`、`LAYER_MANAGER_DISPOSED`。

## 图层管理方法

### map.layers.get(id)

```ts
const layer = map.layers.get('targets');
layer?.setVisible(false);
```

接收图层 ID，返回 `LayerHandle | undefined`。只查询已完成加载的图层，不发起网络请求，也不会提前暴露加载中的句柄。

### map.layers.list()

```ts
const snapshot = map.layers.list();
// [{ id: 'targets', type: 'geojson', state: 'ready', visible: true }]
```

无参数，返回只读 `LayerInfo[]` 快照。修改快照不会改变真实图层；后续状态变化也不会回写旧快照。

### map.layers.remove(id)

接收图层 ID，返回 `Promise<boolean>`。存在时取消加载或释放已加载资源并返回 `true`；不存在时返回 `false`。清理失败抛出 `LAYER_DISPOSE_FAILED`，图层保留以便重试。

### map.layers.clear()

无参数，返回 `Promise<void>`。取消全部加载并释放全部已加载图层。清理期间不能添加新图层；部分图层失败时抛出 `LAYER_CLEAR_FAILED`，失败句柄会保留以便再次清理。

## 通用 LayerHandle

每种图层句柄都有以下字段和方法：

| 成员                  | 类型                      | 效果                                                             |
| --------------------- | ------------------------- | ---------------------------------------------------------------- |
| `id`                  | `string`                  | 地图实例内唯一 ID                                                |
| `type`                | `'geojson' \| 'wms'`      | 图层判别字段                                                     |
| `state`               | `LayerState`              | `loading`、`ready`、`hidden`、`disposing`、`disposed` 或 `error` |
| `visible`             | `boolean`                 | 当前显隐状态                                                     |
| `events`              | `EventHub<LayerEventMap>` | 订阅 `state:changed`                                             |
| `setVisible(visible)` | `void`                    | 修改底层对象显隐，不重建数据源或 Provider                        |
| `dispose()`           | `Promise<void>`           | 幂等释放并从所属管理器移除                                       |

图层已释放后调用修改方法会抛出 `LAYER_DISPOSED`。

## GeoJSON

### 添加 GeoJSON

```ts
const areas = await map.layers.add({
  id: 'areas',
  type: 'geojson',
  data: '/data/areas.geojson',
  visible: true,
  style: {
    marker: { color: '#38d996', size: 14, symbol: 'circle' },
    stroke: '#dce7e1',
    strokeWidth: 2,
    fill: '#249b6a66',
    clampToGround: true,
  },
});
```

| 字段                    | 类型                | 必填 | 说明                                    |
| ----------------------- | ------------------- | ---- | --------------------------------------- |
| `id`                    | `string`            | 是   | 地图内唯一 ID                           |
| `type`                  | `'geojson'`         | 是   | 固定值                                  |
| `data`                  | `GeoJSON \| string` | 是   | GeoJSON 对象或可通过 `fetch` 访问的 URL |
| `visible`               | `boolean`           | 否   | 默认 `true`                             |
| `style.marker.color`    | `string`            | 否   | CSS 颜色                                |
| `style.marker.size`     | `number`            | 否   | 正有限数，单位 px                       |
| `style.marker.symbol`   | `string`            | 否   | Maki 图标名                             |
| `style.stroke` / `fill` | `string`            | 否   | CSS 颜色                                |
| `style.strokeWidth`     | `number`            | 否   | 正有限数，单位 px                       |
| `style.clampToGround`   | `boolean`           | 否   | 是否贴地                                |

URL 必须满足宿主页面 CORS 和 CSP。样式值非法时抛出 `INVALID_LAYER_STYLE`；下载、JSON 解析或 Cesium 加载失败抛出 `LAYER_LOAD_FAILED`。

### geoJsonLayer.setData(data, options?)

```ts
await areas.setData(nextFeatureCollection, {
  signal: abortController.signal,
});
```

接收 GeoJSON 对象或 URL，可选 `AbortSignal`，返回 `Promise<void>`。新数据会先完成解析并加入 Viewer，成功后才移除旧数据，因此失败或取消不会让现有图层消失。并发替换会抛出 `LAYER_BUSY`。

## WMS / GeoServer

### 添加 WMS

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
  parameters: {
    transparent: true,
    format: 'image/png',
    tiled: true,
  },
});
```

| 字段         | 类型                                          | 必填 | 默认值/说明                      |
| ------------ | --------------------------------------------- | ---- | -------------------------------- |
| `id`         | `string`                                      | 是   | 地图内唯一 ID                    |
| `type`       | `'wms'`                                       | 是   | 固定值                           |
| `url`        | `string`                                      | 是   | 非空 GetMap 服务地址             |
| `layers`     | `string \| string[]`                          | 是   | 一个、逗号分隔或多个服务端图层名 |
| `visible`    | `boolean`                                     | 否   | 默认 `true`                      |
| `opacity`    | `number`                                      | 否   | `0` 到 `1`，默认 `1`             |
| `style`      | `string`                                      | 否   | 服务端样式名                     |
| `filter`     | `WmsFilter`                                   | 否   | 类型化 CQL 过滤条件              |
| `parameters` | `Record<string, string \| number \| boolean>` | 否   | 附加 GetMap 参数                 |

`parameters` 不能包含 `layers`、`styles` 或 `cql_filter`，这些字段必须通过类型化配置传入。创建成功表示影像 Provider 已加入场景，不表示所有瓦片已经下载完成。

### roads.setOpacity(opacity)

接收 `0` 到 `1` 的有限数，无返回值。直接修改当前影像图层 alpha，不重建 Provider；非法值抛出 `INVALID_LAYER_OPACITY`。

### roads.setStyle(style?)

接收样式名；传 `undefined` 或空字符串表示清除。返回 `Promise<void>`。SDK 创建新 Provider、保持原索引/显隐/透明度，成功后释放旧 Provider。失败抛出 `LAYER_LOAD_FAILED` 并保留旧画面。

### roads.setFilter(filter?)

接收 `WmsFilter`；省略表示清除过滤。返回 `Promise<void>`，替换过程与 `setStyle()` 相同。CQL 是 GeoServer 扩展，其他 WMS 服务是否支持由服务端决定。

### roads.reload()

无参数，返回 `Promise<void>`。用当前 URL、样式、过滤和参数重新创建 Provider，适用于服务端数据更新后主动刷新。它不会改变 ID、顺序、显隐或透明度。

## wmsFilter

所有构造器都返回可组合的 `WmsFilter` 对象，序列化在创建/更新 Provider 时执行。

| 方法                      | 参数           | 生成语义                   |
| ------------------------- | -------------- | -------------------------- |
| `eq(property, value)`     | 属性名、标量   | `=`                        |
| `ne(property, value)`     | 属性名、标量   | `<>`                       |
| `lt/lte(property, value)` | 属性名、标量   | `<` / `<=`                 |
| `gt/gte(property, value)` | 属性名、标量   | `>` / `>=`                 |
| `like(property, value)`   | 属性名、字符串 | `LIKE`，通配符由服务端解释 |
| `isNull(property)`        | 属性名         | `IS NULL`                  |
| `not(filter)`             | 一个过滤器     | `NOT (...)`                |
| `and(...filters)`         | 至少两个过滤器 | `(...) AND (...)`          |
| `or(...filters)`          | 至少两个过滤器 | `(...) OR (...)`           |

```ts
const filter = wmsFilter.and(
  wmsFilter.eq('status', 'OPEN'),
  wmsFilter.gte('priority', 2),
  wmsFilter.not(wmsFilter.isNull('owner')),
);
```

属性名只允许字母、数字、下划线和点，且不能以数字开头；字符串中的单引号会被转义；数字必须有限。非法表达式抛出 `INVALID_WMS_FILTER`。

## GisError

```ts
import { GisError } from '@yanbobo/gis-sdk/core';

try {
  await map.layers.remove('roads');
} catch (error) {
  if (error instanceof GisError) {
    console.error(error.code, error.module, error.operation, error.retryable);
  }
}
```

| 字段        | 类型           | 用途                            |
| ----------- | -------------- | ------------------------------- |
| `code`      | `GisErrorCode` | 稳定的业务分支判断值            |
| `module`    | `string`       | 失败模块，例如 `layer` 或 `map` |
| `operation` | `string`       | 失败操作，例如 `add`、`destroy` |
| `retryable` | `boolean`      | 调用方是否可以重试当前操作      |
| `cause`     | `unknown`      | 原始异常，供日志和诊断使用      |

不要根据错误消息文本分支；消息可以改进，`code` 才是稳定判断入口。

## map.raw.viewer

```ts
map.raw.viewer.camera.flyHome(0.8);
map.raw.viewer.scene.requestRender();
```

`raw.viewer` 是 Cesium 原生 `Viewer`，用于 SDK 尚未覆盖的高级能力。只使用 Cesium 文档中的公共成员；访问 `_layers`、`_root`、`_materialCache` 等私有字段不属于 SDK 兼容承诺。

不要自行移除由 `map.layers` 创建的 `dataSources` 或 `imageryLayers`，否则 SDK 无法保证状态和资源清理。业务自行添加到 Viewer 的对象，也必须由业务自行释放。

## 尚未提供的 SDK 方法

以下领域处于规划中，当前包没有 `map.drawing`、`map.analysis`、`map.materials`、`map.diagnostics` 等公开入口，也没有 `3dtiles`、`model`、`wmts` 或动态数据图层类型。`map.camera`、`map.basemap`、`map.terrain` 和有界 `DataPipeline` 已发布，具体调用见[地图控制](/guide/map-controls)和[数据管线](/guide/data-pipeline)：

- TMS/WMTS、单图、3D Tiles、glTF/3D 模型和动态实体；
- Worker 数据解析、输入 Adapter、流式渲染、LOD 与 Primitive/Collection 大数据渲染；
- 绘制编辑、自定义材质、空间分析、插件机制和诊断面板；
- 官方 Vue / React 绑定层、旧项目兼容适配器与浏览器性能基线。

这些能力临时只能通过 `map.raw.viewer` 使用 Cesium 公共 API，资源创建方必须自行维护销毁。新增稳定封装后，本节会替换为具体方法说明，而不是保留模糊的“已支持”表述。
