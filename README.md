# gis-sdk

基于 Cesium 1.144 的框架无关 GIS SDK。项目当前处于 alpha 阶段，npm 包通过 `alpha` dist-tag 发布；当前可安装版本以 npm 的 `alpha` 标签为准。

当前首个可用切片提供：

- 类型化 `createMap()` 创建入口；
- ESM、CommonJS 和 TypeScript 声明；
- 幂等地图销毁与类型化生命周期事件；
- 受控的 Cesium 原生 `Viewer` 访问入口；
- 类型化图层生命周期以及 GeoJSON、WMS、TMS、WMTS、单图影像、3D Tiles、静态 glTF / GLB 模型图层；
- TMS/WMTS 影像图层统一透明度、显隐、取消加载和资源释放；
- GeoServer 样式切换和类型化 CQL 过滤；
- 有界动态更新管线，支持同键最新值合并、溢出策略、批量读取和统计；
- Worker / MessagePort 消息输入适配器，支持业务解码转发、拒绝/丢弃统计与监听释放；
- 帧预算调度器，支持动画帧请求合并、每帧有界批处理、取消和统计；
- 模型图层支持位置/朝向就地变换、颜色叠加和可配置的并发加载上限；
- 类型化坐标转换（`map.coordinates`）与批量地形采样（`map.terrain.sample()`）；
- 渲染质量档与按帧率自动降档（`map.quality`），联动分辨率、地形误差与模型并发；
- 影像图层与底图的远端失败可观测：累计错误计数，并只上报首个失败；
- 纯计算的空间能力：量算（距离/面积/方位/包围盒/质心/最近点）、点面判断与 CRS 转换（含 CGCS2000 高斯带）；
- 轨道与姿态数学：开普勒六根数、二体传播、锚点推导轨道与采样、最近接近预警、四元数姿态积分；
- CZML 位置采样的生成与解析（支持 ISO 时间戳与包级 epoch，数据源仍走原生出口）；
- 仿真 / 回放时钟 `SimulationClock`：播放状态机、倍率与方向、seek/step 与水位线限速；
- 分析工具 `map.analysis`：距离 / 地表距离 / 面积 / 方位角 / 地形采样 / 通视 / 视域 / 坡度坡向 / CRS 转换 / 点在面内 / 包围盒 / 质心，算法全部在 `/core`；
- 回放时间轴 `ReplayTimeline`：按对象分组、同刻去重、按时刻查询与插值、轨迹窗口切片（不含数据源读取）；
- 点位图层（PointPrimitive 批量渲染，单层 20 万点）与 CSV 点位导入解析；
- 折线图层（PolylineCollection 批量渲染，五种内置材质、逐条样式覆盖与拾取标记）；
- 环境效果 `map.environment`：深度雾、基础雾（接管官方 Fog 并可恢复）与雨 / 雪，参数全在 SDK 侧且不依赖外部纹理资产；
- 类型化拾取交互（`map.picking`）：点击与悬停命中信息、地表经纬高，悬停按帧合并避免卡顿；
- 交互绘制与编辑 `map.drawing`：点 / 折线 / 面绘制，完成后可拖动顶点并提交 / 回退，纯状态机 + 可替换端口（不绑定 Cesium）；
- 实时水位线与时间戳守卫：乱序样本按时间释放、精确对象共同覆盖、双阈值追赶与超前样本隔离；
- 实时会话门禁与重同步控制器：旧会话迟到包丢弃、序列断档合并请求与有界重试；
- 位置批量归一化 `normalizePositions()`：坐标校验、按 id 合并最新、可转移类型化数组；
- 画布快照 `map.capture()`：同帧拷贝绘图缓冲区、判空重试与超时语义；
- 运行时 2D / 3D 场景切换 `map.scene.setMode()`：形变完成结算与被取代语义；
- 相机退化旋转与 NaN 位姿兜底、切换视角时取消飞行，以及地形加载超时保护；
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
- [实时数据导航](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/data-pipeline.md)
- [有界数据管线](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/data-pipeline-core.md)
- [Worker / MessagePort 输入](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/data-pipeline-message-input.md)
- [帧预算调度](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/data-pipeline-frame-scheduler.md)
- [API 使用参考](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/api-reference.md)
- [图层管理](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/layer-management.md)
- [GeoJSON 图层](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/geojson-layer.md)
- [WMS、TMS 与 WMTS](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/imagery-layers.md)
- [3D Tiles 图层](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/tiles3d-layer.md)
- [静态模型图层](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/model-layer.md)
- [坐标转换](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/coordinates.md)
- [渲染质量与自动降档](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/quality.md)
- [空间计算与坐标转换](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/spatial-analysis.md)
- [轨道与姿态数学](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/orbit-math.md)
- [CZML 生成与解析](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/czml.md)
- [仿真 / 回放时钟](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/simulation-clock.md)
- [点位图层与 CSV 导入](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/points-layer.md)
- [折线图层与内置材质](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/polyline-layer.md)
- [拾取交互](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/picking.md)
- [绘制](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/drawing.md)
- [实时水位线](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/realtime-waterline.md)
- [会话门禁与重同步](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/realtime-session.md)
- [位置批量归一化](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/position-batch.md)
- [画布快照](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/capture.md)
- [2D / 3D 场景切换](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/scene-mode.md)
- [功能状态与路线图](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/capability-status.md)
- [TypeScript 类型索引](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/api.md)
- [变更日志](https://github.com/yanbobo-ONE/gis-sdk/blob/main/CHANGELOG.md)

## 当前能力与未完成项

| 能力                                           | 状态                   | 现在怎样使用                                                                                                                                                                    |
| ---------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 地图创建、尺寸更新、事件与销毁                 | 可用                   | `createMap()`、`map.resize()`、`map.events`、`map.destroy()`                                                                                                                    |
| 画布快照                                       | 可用                   | `map.capture()`：在 postRender 同帧拷贝（无需 preserveDrawingBuffer），判空重试与超时返回 `undefined`                                                                           |
| 场景模式切换                                   | 可用                   | `map.scene.setMode('2d' \| '3d')`：形变完成结算，连续切换时前一次以 `SCENE_MORPH_SUPERSEDED` 拒绝                                                                               |
| GeoJSON                                        | 可用                   | `map.layers.add({ type: 'geojson', ... })`，并可用 `setData()` 原子替换数据                                                                                                     |
| WMS / GeoServer                                | 可用                   | `map.layers.add({ type: 'wms', ... })`，并可用 `setOpacity()`、`setStyle()`、`setFilter()`、`reload()`                                                                          |
| TMS / WMTS                                     | 可用                   | TMS/WMTS 分别使用 `map.layers.add({ type: 'tms', ... })` 或 `map.layers.add({ type: 'wmts', ... })`，返回 `ImageryLayerHandle`                                                  |
| 单图影像                                       | 可用                   | `map.layers.add({ type: 'single-image', url, rectangle?, ... })`，范围使用 WGS84 度数，返回 `ImageryLayerHandle`                                                                |
| 3D Tiles                                       | 可用                   | `map.layers.add({ type: '3d-tiles', url, ... })`，支持显隐、基础 LOD 配置与统一资源释放                                                                                         |
| 静态模型                                       | 可用                   | `map.layers.add({ type: 'model', url, position, ... })`，支持 `setTransform()`、`setColor()`、`setAppearance()` 与 `headingOffset`，并发上限由 `createMap({ quality })` 控制    |
| 点位图层与 CSV 导入                            | 可用                   | `map.layers.add({ type: 'points', points })` 支持 `setData()` / `setStyle()`；`@yanbobo/gis-sdk/core` 的 `parseCsv()`、`readPointCsv()` 解析点位表                              |
| 折线图层                                       | 可用                   | `map.layers.add({ type: 'polyline', polylines })`：五种内置材质（solid/glow/outline/arrow/dash）、`setData()` / `setStyle()`                                                    |
| 拾取交互                                       | 可用                   | `map.picking.on('click' \| 'hover')`，命中信息含图层与对象 id；悬停按帧合并、相机移动期间暂停                                                                                   |
| 交互绘制与编辑                                 | 可用                   | `map.drawing.start('point' \| 'polyline' \| 'polygon')`：左键落点、移动预览、右键/双击确认、Esc 取消；`edit()` / `commitEdit()` / `cancelEdit()` 拖动顶点                                                                            |
| 坐标转换                                       | 可用                   | `map.coordinates`：`toWorld`、`toGeoPosition`、`toWindow`、`pickGeoPosition`，未命中返回 `undefined`                                                                            |
| 地形采样                                       | 可用                   | `map.terrain.sample(points, options?)`：分批并发、缓存、取消与错误码                                                                                                            |
| 渲染质量                                       | 可用                   | `createMap({ quality })`、`map.quality`：四档预设与按帧率自动升降档                                                                                                             |
| 环境效果                                       | 可用                   | `map.environment.set('depthFog' \| 'haze' \| 'rain' \| 'snow', options)`：内置参数、降级说明与统一资源释放                                                                       |
| 远端失败可观测                                 | 可用                   | `layer.events.on('error')`、`layer.errorCount`、`map.basemap.errorCount` 与 `map:error` 上的首个失败                                                                            |
| 空间计算（量算 / 判断 / CRS）                  | 可用                   | `@yanbobo/gis-sdk/core` 的 `measure*`、`isPointInPolygon`、`filterPointsInPolygon`、`registerChinaCrs`、`transformGeoPoint`；零 Cesium 依赖                                     |
| 分析工具                                       | 可用                   | `map.analysis.run('distance' \| 'line-of-sight' \| 'viewshed' \| 'slope-aspect' \| ...)`：13 个内置工具、算法版本与 `signal` 取消                                  |
| 轨道与姿态数学                                 | 可用                   | `calculateOrbitalElements()`、`propagateTwoBody()`、`orbitalElementsFromAnchor()`、`sampleOrbitPositions()`、`findClosestApproaches()`、`AttitudeDynamics`（纯计算，零 Cesium） |
| CZML 生成与解析                                | 可用                   | `czmlFromPositions()` / `czmlFromSamples()` / `positionsFromCzml()`：位置采样与可用区间往返一致                                                                                 |
| 仿真 / 回放时钟                                | 可用                   | `SimulationClock`：倍率、暂停、倒放、seek/step 与水位线限速，可订阅状态                                                                                                         |
| 回放时间轴                                     | 可用                   | `ReplayTimeline`：按对象分组、同刻去重、`sampleAt()` 插值、`window()` / `trackAt()` 切片、有界外推                                                                                |
| Cesium 公共原生能力                            | 可用，但由业务负责资源 | `map.raw.viewer`；只调用 Cesium 文档中的公共成员                                                                                                                                |
| XYZ 底图、相机、椭球 / Cesium Terrain 地形     | 可用                   | `createMap({ basemap })`、`map.basemap`、`map.camera`（含 `view` / `viewRectangle` 只读快照）、`map.terrain`                                                                     |
| 数据管线核心                                   | 可用                   | `DataPipeline`：有界队列、最新值合并、溢出策略、批量读取和统计                                                                                                                  |
| Worker / MessagePort 消息输入                  | 可用                   | `DataPipelineMessageAdapter`：消息监听、业务解码转发、统计和监听释放                                                                                                            |
| 帧预算调度                                     | 可用                   | `DataPipelineFrameScheduler`：请求合并、每帧有界消费、取消和统计                                                                                                                |
| 实时水位线                                     | 可用                   | `RealtimeWaterline` 与 `RealtimeTimestampGuard`：乱序样本按时间释放、双阈值追赶、超前样本隔离与诊断统计                                                                         |
| 位置批量归一化                                 | 可用                   | `normalizePositions()`：坐标校验、按 id 合并最新、输出可转移的 `Float64Array`                                                                                                   |
| 实时会话门禁与重同步                           | 可用                   | `RealtimeSessionGate`（丢弃旧会话迟到包）与 `RealtimeResyncController`（序列断档→有界快照请求）                                                                                 |
| CZML、动态实体与模型动画                       | 未完成                 | 静态 glTF / GLB 模型已可用；CZML、动态实体、动画与模型外观策略当前没有 SDK 方法，临时使用 `map.raw.viewer` 时由业务自行清理资源                                                 |
| Worker 池、专用动态输入和 Primitive 大数据渲染 | 未完成                 | 当前没有 Worker 池、协议 Adapter、吞吐量、数据规模或性能承诺                                                                                                                    |
| 绘制捕捉、自定义材质、插件与诊断               | 未完成                 | 绘制与顶点编辑、分析工具已可用；捕捉、顶点增删、自定义材质、分析结果图层、插件与诊断当前没有稳定公开 API                                                                          |

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
