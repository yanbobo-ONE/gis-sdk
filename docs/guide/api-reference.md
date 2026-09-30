# API 使用参考

这里按“你现在要做什么”分类，而不是按源码文件排列。每个页面都包含可复制的最小示例、参数、返回值、运行效果和异常边界；完整 TypeScript 签名见[类型索引](/api/)。

## 先选场景

| 目标                                             | 阅读页面                                    | 你会获得什么                                                       |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------ |
| 创建地图、监听事件、调整尺寸、抓取快照、释放资源 | [地图生命周期](./map-lifecycle.md)          | `createMap`、`resize`、`destroy`、`state`、`events`                |
| 加雾、霾或降水等环境氛围                         | [环境效果](./environment.md)                | `map.environment.set()`、内置参数与降级说明                        |
| 抓取当前画面用于导出或缩略图                     | [画布快照](./capture.md)                    | `map.capture()`、判空重试与超时语义                                |
| 添加、查询、移除或清空图层                       | [图层管理](./layer-management.md)           | `map.layers.add/get/list/remove/clear`、通用 `LayerHandle`         |
| 加载或替换业务要素数据                           | [GeoJSON 图层](./geojson-layer.md)          | GeoJSON 对象/URL、样式、`setData`、取消加载                        |
| 接入 WMS、TMS、WMTS 或单张配准影像               | [影像图层](./imagery-layers.md)             | 样式、CQL 过滤、透明度、瓦片/单图参数与释放                        |
| 加载城市/倾斜摄影等 3D Tiles                     | [3D Tiles 图层](./tiles3d-layer.md)         | 加载、显隐、基础 LOD、取消和释放                                   |
| 放置单个 glTF / GLB 模型                         | [静态模型图层](./model-layer.md)            | 位置/朝向、颜色叠加、外观策略、就地变换与并发加载限制              |
| 批量渲染点位或导入 CSV                           | [点位图层](./points-layer.md)               | `type: 'points'`、`setData()`、`parseCsv()`、`readPointCsv()`      |
| 画航线、轨迹、链路等批量线要素                   | [折线图层](./polyline-layer.md)             | `type: 'polyline'`、内置材质、`setData()` / `setStyle()`           |
| 点击 / 悬停拾取地图对象                          | [拾取交互](./picking.md)                    | `map.picking.on()`、`PickingHit`、拾取标记与悬停节流               |
| 交互绘制点、折线与面，拖动顶点或吸附             | [绘制与编辑](./drawing.md)                  | `map.drawing.start()`、`edit()` / `insertVertex()` / `removeVertex()`、`setSnap()` |
| 设置或读取相机、XYZ 底图、地形与采样             | [地图控制](./map-controls.md)               | `map.camera.view` / `viewRectangle`、`map.basemap`、`map.terrain`  |
| 运行时切换 2D / 3D 场景                          | [2D / 3D 场景切换](./scene-mode.md)         | `map.scene.setMode()`、`mode`、`morphing`                          |
| 经纬度、世界坐标与屏幕坐标互转                   | [坐标转换](./coordinates.md)                | `map.coordinates` 的四个转换方法及返回值语义                       |
| 调分辨率、地形精度或按帧率自动降档               | [渲染质量](./quality.md)                    | `map.quality`、`createMap({ quality })`、内置质量档                |
| 量算距离面积、判断点在区内、转换坐标系           | [空间计算与坐标转换](./spatial-analysis.md) | `measure*`、`isPointInPolygon`、`convexHull`、`simplifyPath`、`validatePolygon`、CRS 注册表 |
| 通视、视域、坡度坡向、凸包、抽稀                 | [分析工具](./analysis.md)                   | `map.analysis.run(tool, input)`、15 个内置工具与算法版本           |
| 计算轨道六根数、传播轨道、积分姿态               | [轨道与姿态数学](./orbit-math.md)           | `calculateOrbitalElements`、`propagateTwoBody`、`AttitudeDynamics` |
| 生成或解析 CZML（位置 / 姿态 / 模型）             | [CZML 生成与解析](./czml.md)                | `czmlFromPositions`、`positionsFromCzml`、`tracksFromCzml`          |
| 接长连接：重连、心跳与按类型分发                       | [实时链路](./realtime-socket.md)            | `RealtimeSocketClient` 的 `connect()` / `subscribe()` / `stats`    |
| 排查线上问题或做验收自检                           | [诊断快照](./diagnostics.md)                | `map.diagnostics.snapshot()` 一次拿到状态、质量、图层与错误计数     |
| 把重计算搬到 Worker 里执行                           | [Worker 执行接口](./analysis-worker.md)     | `createAnalysisWorkerClient()` / `createAnalysisWorkerHost()` 与消息协议 |
| 回放倍率、暂停、倒放与水线限速                   | [仿真 / 回放时钟](./simulation-clock.md)    | `SimulationClock`、`advance()`、`setWatermark()`                   |
| 按时刻取回放样本、插值与轨迹窗口                 | [回放时间轴](./replay-timeline.md)          | `ReplayTimeline` 的 `sampleAt()` / `window()` / `trackAt()`        |
| 消化高频业务消息                                 | [实时数据导航](./data-pipeline.md)          | 有界队列、Worker/MessagePort 输入、帧预算调度                      |
| 处理乱序实时样本与断流追赶                       | [实时水位线](./realtime-waterline.md)       | `RealtimeWaterline`、`RealtimeTimestampGuard`                      |
| 过滤无效坐标、按 id 合并高频位置                 | [位置批量归一化](./position-batch.md)       | `normalizePositions()`、可转移的 `Float64Array` 输出               |
| 丢弃旧会话消息、处理序列断档                     | [会话门禁与重同步](./realtime-session.md)   | `RealtimeSessionGate`、`RealtimeResyncController`                  |
| 判断和处理失败                                   | [错误与原生出口](./errors-and-native.md)    | `GisError`、错误码、`map.raw.viewer` 的边界                        |

## 统一调用规则

所有地图功能都从 `createMap()` 返回的 `map` 调用；图层从 `map.layers.add()` 返回的句柄调用。SDK 负责自己创建的 Cesium 资源，业务通过 `map.raw.viewer` 创建的原生对象仍由业务负责释放。

```ts
import { createMap } from '@yanbobo/gis-sdk/cesium';
import '@yanbobo/gis-sdk/styles.css';

const map = createMap({ container: 'map', cesiumBaseUrl: '/cesium/' });
const layer = await map.layers.add({
  id: 'areas',
  type: 'geojson',
  data: '/data/areas.geojson',
});

layer.setVisible(false);
await map.destroy();
```

## 已发布范围

当前 alpha 包已发布地图生命周期、画布快照、环境效果、分析工具、场景模式切换、折线图层、交互绘制与顶点编辑、CZML 生成与解析、GeoJSON、WMS、TMS、WMTS、单图影像、3D Tiles、静态模型、点位图层、拾取交互、实时水位线、XYZ 底图、相机、地形与地形采样、地图坐标转换、渲染质量、空间计算（量算 / 判断 / CRS 转换）、CSV 解析、数据管线。动态实体、Worker 池、大数据渲染器、自定义材质、体积类环境效果与分析结果图层尚未提供稳定 SDK 方法；准确状态以[功能状态与路线图](./capability-status.md)为准。
