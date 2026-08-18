# 快速开始

## 安装

安装当前 alpha 发布线：

```bash
pnpm add @yanbobo/gis-sdk@alpha
```

## 准备 Cesium 静态资源

Cesium 的 Worker、内置资源和控件图片必须由业务应用部署到同一个公共目录。SDK 提供跨平台复制命令，不依赖 npm、pnpm 或 yarn 的 `node_modules` 目录布局：

```bash
pnpm exec gis-sdk-copy-assets public/cesium
```

最终部署结构应为：

```text
/cesium/
  Workers/
  ThirdParty/
  Assets/
  Widgets/
```

`cesiumBaseUrl` 必须指向这四个目录的共同父路径：

```ts
const map = createMap({
  container: 'map',
  cesiumBaseUrl: '/cesium/',
});
```

该配置是 Cesium 进程级全局配置。首个 Viewer 创建后即锁定：后续地图可以省略或传入相同地址，但不能切换到另一个地址，否则 SDK 抛出 `CESIUM_BASE_URL_CONFLICT`。

基址必须只有一个配置入口：推荐始终通过 SDK 的 `cesiumBaseUrl` 配置。若宿主项目已经直接调用 Cesium `buildModuleUrl.setBaseUrl()`，创建地图时必须省略 `cesiumBaseUrl`，SDK 会沿用宿主配置；不要同时使用这两种配置方式。

## 创建与销毁

页面必须先准备一个有明确尺寸的容器：

```html
<div id="map"></div>
```

```css
#map {
  width: 100%;
  height: 100vh;
}
```

然后导入 SDK 和 Cesium 控件样式：

```ts
import { createMap } from '@yanbobo/gis-sdk';
import '@yanbobo/gis-sdk/styles.css';

const map = createMap({
  container: 'map',
  cesiumBaseUrl: '/cesium/',
  widgets: {
    fullscreenButton: true,
  },
});
```

SDK 默认设置 `baseLayer: false`，不会自动请求 Cesium ion 影像，因此创建空白地球不需要 ion token。GeoJSON 和 WMS 使用 [`map.layers`](./layers.md) 管理；尚未覆盖的影像、地形、3D Tiles 或 Primitive 可以暂时通过 `map.raw.viewer` 使用 Cesium 公共接口。

组件卸载、路由离开或场景切换时释放地图：

```ts
await map.destroy();
```

## 生命周期事件

```ts
const off = map.events.on('map:error', ({ error }) => {
  if (error.retryable) {
    console.warn(error.code, error);
  }
});

off();
```

地图销毁后调用 `resize()` 会抛出 `MAP_DISPOSED`。并发调用 `destroy()` 会共享同一个 Promise。

## 在不同框架中使用

SDK 核心不依赖 Vue 或 React。Vue 2、Vue 3、React 和原生页面都使用相同 `createMap()` 与 `destroy()`；框架组件只负责容器挂载和生命周期绑定，不应把业务 Store 或接口模型传入 SDK 核心。
