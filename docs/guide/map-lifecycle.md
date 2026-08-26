# 地图生命周期

本页说明如何创建地图、监听事件、响应容器变化以及安全销毁。页面或组件只应保存 `map`，不要自行保存 SDK 内部创建的 Cesium Provider、DataSource 或 ImageryLayer。

## 创建地图：createMap(options)

适用于页面首次挂载时。创建是同步的，返回时 Viewer、事件中心和 `map.layers` 都可立即使用。

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
import '@yanbobo/gis-sdk/styles.css';

const map = createMap({
  container: 'map',
  id: 'operations-map',
  cesiumBaseUrl: '/cesium/',
  scene: { mode: '3d' },
  widgets: { fullscreenButton: true, homeButton: true },
});
```

| 参数            | 类型                    | 必填 | 默认值/效果                                   |
| --------------- | ----------------------- | ---- | --------------------------------------------- |
| `container`     | `string \| HTMLElement` | 是   | 容器元素或元素 ID；必须非空且页面上存在       |
| `id`            | `string`                | 否   | `crypto.randomUUID()`；用于定位事件和错误     |
| `cesiumBaseUrl` | `string`                | 否   | Cesium 静态资源公共目录，例如 `/cesium/`      |
| `scene.mode`    | `'2d' \| '3d'`          | 否   | `'3d'`                                        |
| `basemap`       | `XyzBasemapSpec`        | 否   | 初始 XYZ 底图；模板必须含 `{z}`、`{x}`、`{y}` |
| `widgets`       | `CesiumWidgetOptions`   | 否   | 默认全部关闭；可开启全屏、Home 等 Cesium 控件 |

**返回：** `CesiumMap`。默认不请求在线底图，因此不需要 Cesium ion token。

**常见异常：** `INVALID_CONTAINER`、`INVALID_BASEMAP_CONFIG`、`INVALID_BASEMAP_OPACITY`、`CESIUM_BASE_URL_CONFLICT`。

::: tip 静态资源只配置一次
先执行 `pnpm exec gis-sdk-copy-assets public/cesium`，再将 `cesiumBaseUrl` 设为 `/cesium/`。同一页面进程的第一个 Viewer 创建后不能换成另一个基址。
:::

## 容器变化：map.resize()

侧栏折叠、Tab 切换或窗口变化后调用。它不加载数据，只让 Cesium 重新计算画布尺寸。

```ts
const observer = new ResizeObserver(() => map.resize());
observer.observe(document.querySelector('#map')!);

// 页面销毁前调用。
observer.disconnect();
```

无参数、无返回值。地图已销毁后调用会抛出 `MAP_DISPOSED`。

## 生命周期状态：map.state

| 值             | 含义                               |
| -------------- | ---------------------------------- |
| `'ready'`      | 地图可继续操作                     |
| `'destroying'` | 正在取消图层、释放资源             |
| `'destroyed'`  | 已释放，不能再调用控制器或图层方法 |

`state` 不代表网络瓦片是否全部下载完毕。

## 监听事件：map.events

使用 `on()` 返回的取消函数清理监听器。`once()` 参数相同，但只会执行一次。

```ts
const offError = map.events.on('map:error', ({ id, error }) => {
  console.error(id, error.code, error.operation, error.retryable);
});

const offDestroy = map.events.once('map:destroy', ({ id }) => {
  console.info(`${id} destroyed`);
});

offError();
offDestroy();
```

| 参数       | 类型                           | 说明         |
| ---------- | ------------------------------ | ------------ |
| `type`     | `'map:error' \| 'map:destroy'` | 事件名称     |
| `listener` | `(event) => void`              | 同步监听函数 |

## 销毁地图：map.destroy()

在组件卸载、路由离开或场景切换时调用。SDK 会取消加载、释放 SDK 图层、底图、监听器和 Viewer。

```ts
async function disposePage() {
  observer.disconnect();
  offError();
  await map.destroy();
}
```

**返回：** `Promise<void>`。并发或重复调用会复用同一次销毁，不会重复销毁 Viewer。

**可能拒绝：** `MAP_DESTROY_FAILED`。当 `retryable` 为 `true` 时，修复外部问题后可再次调用。
