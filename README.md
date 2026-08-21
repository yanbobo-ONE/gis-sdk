# gis-sdk

基于 Cesium 1.144 的框架无关 GIS SDK。项目当前处于 alpha 阶段，npm 包通过 `alpha` dist-tag 发布；当前可安装版本以 npm 的 `alpha` 标签为准。

当前首个可用切片提供：

- 类型化 `createMap()` 创建入口；
- ESM、CommonJS 和 TypeScript 声明；
- 幂等地图销毁与类型化生命周期事件；
- 受控的 Cesium 原生 `Viewer` 访问入口；
- 类型化图层生命周期以及 GeoJSON、WMS、3D Tiles 图层；
- GeoServer 样式切换和类型化 CQL 过滤；
- 有界动态更新管线，支持同键最新值合并、溢出策略、批量读取和统计；
- Worker / MessagePort 消息输入适配器，支持业务解码转发、拒绝/丢弃统计与监听释放；
- 帧预算调度器，支持动画帧请求合并、每帧有界批处理、取消和统计；
- 默认关闭在线底图和可选控件，无需 Cesium ion token 即可启动空白地球。

## 环境要求

- Node.js 22 或更高版本；
- pnpm 11.19.0；
- 现代浏览器，支持 WebGL 和 `crypto.randomUUID()`。

## 安装

安装 alpha 版本：

```bash
pnpm add @yanbobo/gis-sdk@alpha
pnpm exec gis-sdk-copy-assets public/cesium
```

## 从安装到页面销毁

页面需要一个有明确尺寸的容器，并且 Cesium 样式与静态资源路径必须同时配置：

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
  cesiumBaseUrl: '/cesium/',
  scene: { mode: '3d' },
  basemap: {
    type: 'xyz',
    url: 'https://tiles.example.com/{z}/{x}/{y}.png',
  },
});

const roads = await map.layers.add({
  id: 'roads',
  type: 'wms',
  url: 'https://maps.example.com/geoserver/wms',
  layers: 'city:roads',
  opacity: 0.7,
});

// 立即改变已加入场景的影像透明度，不会重建服务提供器。
roads.setOpacity(0.65);

await map.camera.flyTo({ longitude: 116.39, latitude: 39.9, height: 30_000, duration: 1 });
await map.terrain.set({ type: 'ellipsoid' });

// 容器尺寸变化时让 Cesium 重新计算画布大小。
const observer = new ResizeObserver(() => map.resize());
observer.observe(document.querySelector('#map')!);

// 监听可恢复的 SDK 错误；监听函数返回取消订阅函数。
const offError = map.events.on('map:error', ({ error }) => {
  console.error(error.code, error.operation, error.retryable);
});

// 高级需求可受控访问 Cesium 原生对象
map.raw.viewer.scene.requestRender();

// 在组件卸载、路由离开或场景切换时调用，释放图层、请求、监听器和 Viewer。
async function disposeMap() {
  offError();
  observer.disconnect();
  await map.destroy();
}
```

`destroy()` 支持并发和重复调用，不会重复销毁底层 `Viewer`。创建地图时，`cesiumBaseUrl` 必须与 `gis-sdk-copy-assets` 的目标目录一致；首个 Viewer 创建后，同一页面进程不能切换到另一个基址。

## 文档

- [快速开始](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/getting-started.md)
- [导入与包体积](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/imports.md)
- [地图控制](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/map-controls.md)
- [数据管线](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/data-pipeline.md)
- [API 使用参考](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/api-reference.md)
- [图层管理](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/layers.md)
- [功能状态与路线图](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/capability-status.md)
- [TypeScript 类型索引](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/api.md)
- [变更日志](https://github.com/yanbobo-ONE/gis-sdk/blob/main/CHANGELOG.md)

## 当前能力与未完成项

| 能力                                           | 状态                   | 现在怎样使用                                                                                           |
| ---------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| 地图创建、尺寸更新、事件与销毁                 | 可用                   | `createMap()`、`map.resize()`、`map.events`、`map.destroy()`                                           |
| GeoJSON                                        | 可用                   | `map.layers.add({ type: 'geojson', ... })`，并可用 `setData()` 原子替换数据                            |
| WMS / GeoServer                                | 可用                   | `map.layers.add({ type: 'wms', ... })`，并可用 `setOpacity()`、`setStyle()`、`setFilter()`、`reload()` |
| 3D Tiles                                       | 可用                   | `map.layers.add({ type: '3d-tiles', url, ... })`，支持显隐、基础 LOD 配置与统一资源释放                |
| Cesium 公共原生能力                            | 可用，但由业务负责资源 | `map.raw.viewer`；只调用 Cesium 文档中的公共成员                                                       |
| XYZ 底图、相机、椭球 / Cesium Terrain 地形     | 可用                   | `createMap({ basemap })`、`map.basemap`、`map.camera`、`map.terrain`                                   |
| 数据管线核心                                   | 可用                   | `DataPipeline`：有界队列、最新值合并、溢出策略、批量读取和统计                                         |
| Worker / MessagePort 消息输入                  | 可用                   | `DataPipelineMessageAdapter`：消息监听、业务解码转发、统计和监听释放                                   |
| 帧预算调度                                     | 可用                   | `DataPipelineFrameScheduler`：请求合并、每帧有界消费、取消和统计                                       |
| TMS/WMTS、模型                                 | 未完成                 | 当前没有 SDK 方法；临时使用 `map.raw.viewer`，由业务自行清理资源                                       |
| Worker 池、专用动态输入和 Primitive 大数据渲染 | 未完成                 | 当前没有 Worker 池、协议 Adapter、吞吐量、数据规模或性能承诺                                           |
| 绘制编辑、自定义材质、空间分析、插件与诊断     | 未完成                 | 当前没有稳定公开 API                                                                                   |

功能完成后会在[功能状态与路线图](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/capability-status.md)将状态改为“可用”，补充可运行示例、API 参数页和变更日志，并以新的 npm alpha 版本发布。规划能力不是已发布 API，不能按名称直接调用。

## 本地开发

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm docs:build
pnpm pack:check
pnpm example:build
```

`example:build` 会把当前 SDK 打成 `.tgz`，安装到隔离的 Vanilla 应用，复制 Cesium
Workers、Assets 和 Widgets 后再执行 Vite 构建，避免示例误用仓库源码掩盖发布包问题。

当前仓库使用 `UNLICENSED`，在明确开源或商业授权方案前不得把源码或 npm 包视为开放许可证软件。
