# 功能状态与路线图

本页是当前公开能力的唯一完整状态表。`可用` 表示已在当前 alpha 包中导出、具备测试覆盖并有使用文档；`未发布` 表示代码和 npm 包均没有可调用的稳定接口。alpha 阶段的已发布接口仍可能在后续预发布版本中调整。

## 当前可用能力

| 模块                | 状态 | 公开入口                                                                                                                                                           | 已验证的效果                                                                                                                       |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 地图运行时          | 可用 | `createMap()`、`map.resize()`、`map.destroy()`、`map.state`                                                                                                        | 创建 Viewer、响应容器尺寸变化、并发幂等销毁与销毁状态保护                                                                          |
| 画布快照            | 可用 | `map.capture()`、`FrameCapture`、`CaptureOptions`                                                                                                                  | 在 postRender 同帧拷贝绘图缓冲区（无需 preserveDrawingBuffer）、降采样判空、重试与超时返回 undefined                               |
| 场景模式切换        | 可用 | `map.scene.setMode()`、`map.scene.mode`、`map.scene.morphing`                                                                                                      | 运行时 2D / 3D 形变、同模式立即结算、连续切换时前一次以 SCENE_MORPH_SUPERSEDED 拒绝、销毁时拒绝在途形变                            |
| 事件与错误          | 可用 | `map.events`、`EventHub`、`GisError`                                                                                                                               | 订阅 `map:error` / `map:destroy`，按稳定错误码处理失败                                                                             |
| 图层生命周期        | 可用 | `map.layers.add/get/list/remove/clear`                                                                                                                             | 图层 ID 预留、加载取消、资源释放和状态快照                                                                                         |
| GeoJSON             | 可用 | `type: 'geojson'`、`setData()`                                                                                                                                     | URL 或对象加载、基础样式、取消加载后保留旧数据且不进入错误状态、原子数据替换                                                       |
| WMS / GeoServer     | 可用 | `type: 'wms'`、`setOpacity()`、`setStyle()`、`setFilter()`、`reload()`                                                                                             | 加入影像图层并运行时更新透明度、样式、CQL 过滤或 Provider                                                                          |
| TMS / WMTS          | 可用 | `type: 'tms'`、`type: 'wmts'`、`ImageryLayerHandle`                                                                                                                | 类型化瓦片 Provider、显隐、透明度、取消加载和统一资源释放                                                                          |
| 单图影像            | 可用 | `type: 'single-image'`、`ImageryLayerHandle`                                                                                                                       | WGS84 度数范围、异步加载、显隐、透明度、取消加载和统一资源释放                                                                     |
| 3D Tiles            | 可用 | `type: '3d-tiles'`                                                                                                                                                 | 加载标准 Tileset、显隐、基础 LOD 配置、取消后的延迟资源清理和释放                                                                  |
| 静态模型            | 可用 | `type: 'model'`、`ModelLayerHandle`、`createMap({ quality })`                                                                                                      | glTF / GLB 加载、WGS84 位置朝向与朝向补偿、颜色叠加、外观策略（提亮 / 无光照）、就地变换、取消加载、并发上限与统一资源释放         |
| 点位图层            | 可用 | `type: 'points'`、`PointsLayerHandle`、`MAX_POINT_LAYER_POINTS`                                                                                                    | PointPrimitive 批量渲染、单层 20 万点、逐点样式覆盖、原子替换点位、整层样式调整与统一资源释放                                      |
| 折线图层            | 可用 | `type: 'polyline'`、`PolylineLayerHandle`、`MAX_POLYLINES_PER_LAYER`                                                                                               | PolylineCollection 批量渲染、五种内置材质（solid / glow / outline / arrow / dash）、逐条样式覆盖、原子替换、整层样式调整与拾取标记 |
| 拾取交互            | 可用 | `map.picking.on('click' \| 'hover')`、`map.picking.setEnabled()`                                                                                                   | 类型化命中信息（图层 / 对象 / 地球 / 原生对象）、地表经纬高、按帧合并悬停、相机变化期间暂停拾取、点击向下钻取                      |
| 交互绘制与编辑      | 可用 | `map.drawing`、`DrawingStateMachine`、`DrawRendererPort`、`DrawingEditMachine`、`setSnap()`、`insertVertex()` / `removeVertex()`                                    | 点 / 折线 / 面绘制、预览与确认、完成图形管理、顶点拖动 / 插入 / 删除、提交与回退、顶点与线段吸附（像素阈值）                        |
| 相机控制与读取      | 可用 | `map.camera.view`、`viewRectangle`、`setView()`、`flyTo()`、`cancelFlight()`                                                                                       | 读取当前位姿与视口四至、使用度和米定位、飞行、取消、切换视角时先取消进行中的飞行、退化旋转与 NaN 位姿兜底                          |
| XYZ 底图            | 可用 | `createMap({ basemap })`、`map.basemap`                                                                                                                            | 单底图原子替换、透明度与显隐，始终位于业务影像图层下方                                                                             |
| 地形                | 可用 | `map.terrain.set()`、`TerrainSetOptions`                                                                                                                           | 椭球切换和 Cesium Terrain 异步加载，失败或超时（默认 30 秒）时保留旧地形并可立即重试                                               |
| 地形采样            | 可用 | `map.terrain.sample()`                                                                                                                                             | 批量高程采样、分批与并发上限、provider 级缓存、无数据不伪造 0、取消与错误码                                                        |
| 坐标转换            | 可用 | `map.coordinates`                                                                                                                                                  | 经纬高与世界坐标互转、投影到窗口像素、屏幕拾取地球表面；未命中返回 `undefined`                                                     |
| 环境效果            | 可用 | `map.environment.set()`、`setEnabled()`、`clear()`、`clearAll()`                                                                                                   | 深度雾（距离与高度双衰减）、基础雾（接管官方 Fog 并可恢复）、雨 / 雪（程序化屏幕粒子、风向与强度）；参数越界抛错、二维降级说明与统一资源释放 |
| 回放时间轴          | 可用 | `ReplayTimeline`（`/core`，零 Cesium）                                                                                                                             | 按对象分组、时间排序与同刻去重、容量上限、按时刻查询与插值、窗口与轨迹切片、有界外推                    |
| 渲染质量            | 可用 | `map.quality`、`createMap({ quality })`、`RenderQualityMonitor`                                                                                                    | 四档预设、分辨率/地形误差/模型并发联动、按帧率自动升降档与降档诊断                                                                 |
| 图层错误可观测      | 可用 | `LayerHandle.errorCount`、`layer.events.on('error')`、`map.basemap.errorCount`                                                                                     | 影像瓦片失败累计计数并只上报首个；底图首个失败经 `map:error` 上报                                                                  |
| 诊断快照            | 可用 | `map.diagnostics.snapshot()`（`/core` 契约 + 适配器读数）                                                                                                          | 一次调用汇总生命周期、相机（含安全网恢复次数）、质量与帧率、图层与错误计数、底图、地形、场景、环境与绘制状态；读不到不抛错 |
| 分析工具            | 可用 | `map.analysis.run(tool, input)`、`map.analysis.list()`、`createAnalysisController()`                                                                             | 15 个内置工具（含凸包与轨迹抽稀）、按工具窄化的输入输出、算法版本、地形采样端口、无数据不伪造、`signal` 取消与稳定错误码 |
| 空间量算            | 可用 | `measureDistance`、`measureArea`、`measureBBox`、`nearestPointOnPath` 等（包根或 `/core`）                                                                         | 球面量算：距离、折线长度、面积（含洞）、方位、目标点、包围盒、质心、沿线取点、最近点                                               |
| 空间判断            | 可用 | `isPointInPolygon`、`filterPointsInPolygon`、`normalizeRingWinding`（包根或 `/core`）                                                                              | 外环 + 内环判断、边界归属可配、批量判断带包围盒预筛、绕向规范化                                                                    |
| CSV 点位导入        | 可用 | `parseCsv`、`readPointCsv`、`guessCsvPointColumns`、`describeCsvColumn`（包根或 `/core`）                                                                          | RFC4180 解析、BOM 与编码校验、列数不一致拒绝、严格十进制坐标、列名显式映射与拒绝行样本                                             |
| CRS 坐标转换        | 可用 | `registerCrs`、`registerChinaCrs`、`transformGeoPoint/Path/Ring`、`listCrs`、`describeCrs`                                                                         | proj4 封装、CGCS2000 高斯带按公式登记并校验带号、往返残差与基准值有单测锁定                                                        |
| 轨道与姿态数学      | 可用 | `calculateOrbitalElements`、`propagateTwoBody`、`sampleOrbitPositions`、`AttitudeDynamics`、`slerp` 等                                                                  | 六根数求解、二体传播、锚点轨道与采样、最近接近、四元数姿态积分，以及与 Cesium 逐位一致的四元数 ↔ 航向/俯仰/翻滚互转与最短弧插值 |
| CZML 生成与解析     | 可用 | `czmlFromPositions`、`czmlFromSamples`、`positionsFromCzml`、`tracksFromCzml`                                                                                      | 位置采样与可用区间往返一致、姿态四元数采样（按时间匹配）与 `model` 报文（gltf + 最小像素尺寸）、epoch 覆盖规则；不加载数据源 |
| 仿真 / 回放时钟     | 可用 | `SimulationClock`（包根或 `/core`）                                                                                                                                | 播放状态机（idle/playing/paused/ended/stalled）、倍率与方向、seek/step、水位线限速、停滞原因与订阅                                 |
| 数据管线核心        | 可用 | `DataPipeline`（包根或 `/core`）                                                                                                                                   | 有界队列、同键最新值合并、溢出策略、批量读取和统计快照                                                                             |
| 消息输入适配器      | 可用 | `DataPipelineMessageAdapter`（包根或 `/core`）                                                                                                                     | Worker / MessagePort 监听、业务解码转发、拒绝/丢弃统计与监听释放                                                                   |
| 帧预算调度器        | 可用 | `DataPipelineFrameScheduler`（包根或 `/core`）                                                                                                                     | 动画帧请求合并、每帧有界消费、自动续帧、取消、失败事件与统计                                                                       |
| 实时水位线          | 可用 | `RealtimeWaterline`、`RealtimeTimestampGuard`（包根或 `/core`）                                                                                                    | 乱序样本按时间释放、精确对象共同覆盖、过期/超限/窗口丢弃统计、双阈值追赶与倍率上限、断流与失活状态、超前样本隔离                   |
| 位置批量归一化      | 可用 | `normalizePositions()`、`PositionBatch`（包根或 `/core`）                                                                                                          | 坐标校验与越界过滤、按 id 保留最新（可切换历史模式）、输出可转移的 Float64Array 与丢弃统计                                         |
| 会话门禁与重同步    | 可用 | `RealtimeSessionGate`、`RealtimeResyncController`（包根或 `/core`）                                                                                                | 会话切换只认首条消息与显式控制消息、旧会话迟到包丢弃、序列断档自动转入快照等待、重复请求合并与请求上限                             |
| 实时链路（长连接）  | 可用 | `RealtimeSocketClient`（`/core`，零终端依赖）                                                                                                                      | 连接状态机、有上限退避重连与抖动、心跳存活判断、按类型路由与通配订阅、解码与订阅方异常隔离、链路统计 |
| Cesium 公共原生访问 | 可用 | `map.raw.viewer`                                                                                                                                                   | 调用 Cesium 文档中的公共成员；资源归业务代码所有                                                                                   |
| 按需导入            | 可用 | `/core`、`/cesium`、`/layers`、`/styles.css`                                                                                                                       | 将核心工具、Cesium 创建入口和图层工具拆分为独立子路径                                                                              |

完整调用代码见 [API 使用参考](/guide/api-reference)，子路径选择与包体积边界见[导入与包体积](/guide/imports)。

## 未发布能力

| 模块                                 | 当前状态 | 在完成前的边界                                                                                                                         |
| ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 企业影像服务                         | 未发布   | 当前未封装企业鉴权、服务专属参数或凭证更新策略；可临时使用原生出口                                                                     |
| 动态实体与模型动画                   | 未发布   | CZML 生成 / 解析、静态模型与外观策略已可用；CZML 数据源加载、动态实体、动画播放与实体级拾取事件仍无 SDK 方法                        |
| Worker 池                            | 未发布   | 分析的 Worker 执行接口（协议 + 客户端 + 宿主）与 WebSocket 链路已可用；多 Worker 调度、SSE / MQTT / 二进制协议解码与校验尚未发布        |
| 实时协议与 Worker 池                 | 未发布   | 长连接链路、水位线、时间戳守卫、会话门禁与重同步已可用；SSE / MQTT / 二进制协议解码与 Worker 池尚未发布                                |
| 海量数据渲染（聚合 / 标签 / Worker） | 未发布   | 尚无动态渲染器、Primitive / Collection 批处理、自动 LOD 或基准数据承诺                                                                 |
| 绘制交互手势                         | 未发布   | 顶点增删已提供程序化 API 与纯函数；SDK 不绑定右键菜单 / 双击线段等手势，交互由业务自己接                                               |
| 体积类环境效果与自定义材质           | 未发布   | 深度雾、基础雾与降水已可用；体积云、热力图、三维风场、闪电、水面与自定义 GLSL 材质尚无 SDK 方法                                        |
| 分析任务模型与结果图层               | 未发布   | `map.analysis`（15 个工具）与 Worker 执行接口已可用；任务队列、进度上报与结果图层尚未发布                                                |
| 插件与框架绑定                       | 未发布   | 错误计数、首个失败事件与 `map.diagnostics` 快照已可用；插件注册协议与官方 Vue / React 组件尚未发布                                     |
| 多浏览器性能验证                     | 未完成   | 尚未建立真实 WebGL 端到端矩阵、性能阈值和公开压测结果                                                                                  |
| 旧项目迁移适配                       | 未完成   | 尚未提供兼容层；接入以当前公开 SDK 契约为准                                                                                            |

未发布不代表不重要，而是不能以“已支持”对外承诺。业务若临时通过原生 Cesium API 接入，必须自行管理对象所有权、资源销毁和 Cesium 升级兼容性。

## 后续完成时如何更新

每项能力完成并准备对外发布时，维护者必须在同一次变更中完成以下事项：

1. 实现公开契约并补充单元、集成或发布包验证；
2. 将本页对应行从“未发布”改为“可用”，写明首次发布版本、实际公开入口和已验证效果；
3. 在 [API 使用参考](/guide/api-reference)新增参数表、返回值、异常、运行效果和可复制示例；
4. 需要时同步 [README](https://github.com/yanbobo-ONE/gis-sdk#readme) 的能力表，保证 npm 包页面与本站一致；
5. 增加 Changeset、更新 `CHANGELOG.md`，并发布新的 npm alpha 版本。

没有完成以上文档和发布项的实现，不得把状态改为“可用”。
