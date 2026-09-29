# 功能状态与路线图

本页是当前公开能力的唯一完整状态表。`可用` 表示已在当前 alpha 包中导出、具备测试覆盖并有使用文档；`未发布` 表示代码和 npm 包均没有可调用的稳定接口。alpha 阶段的已发布接口仍可能在后续预发布版本中调整。

## 当前可用能力

| 模块                | 状态 | 公开入口                                                                                   | 已验证的效果                                                                                                               |
| ------------------- | ---- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 地图运行时          | 可用 | `createMap()`、`map.resize()`、`map.destroy()`、`map.state`                                | 创建 Viewer、响应容器尺寸变化、并发幂等销毁与销毁状态保护                                                                  |
| 事件与错误          | 可用 | `map.events`、`EventHub`、`GisError`                                                       | 订阅 `map:error` / `map:destroy`，按稳定错误码处理失败                                                                     |
| 图层生命周期        | 可用 | `map.layers.add/get/list/remove/clear`                                                     | 图层 ID 预留、加载取消、资源释放和状态快照                                                                                 |
| GeoJSON             | 可用 | `type: 'geojson'`、`setData()`                                                             | URL 或对象加载、基础样式、取消加载后保留旧数据且不进入错误状态、原子数据替换                                               |
| WMS / GeoServer     | 可用 | `type: 'wms'`、`setOpacity()`、`setStyle()`、`setFilter()`、`reload()`                     | 加入影像图层并运行时更新透明度、样式、CQL 过滤或 Provider                                                                  |
| TMS / WMTS          | 可用 | `type: 'tms'`、`type: 'wmts'`、`ImageryLayerHandle`                                        | 类型化瓦片 Provider、显隐、透明度、取消加载和统一资源释放                                                                  |
| 单图影像            | 可用 | `type: 'single-image'`、`ImageryLayerHandle`                                               | WGS84 度数范围、异步加载、显隐、透明度、取消加载和统一资源释放                                                             |
| 3D Tiles            | 可用 | `type: '3d-tiles'`                                                                         | 加载标准 Tileset、显隐、基础 LOD 配置、取消后的延迟资源清理和释放                                                          |
| 静态模型            | 可用 | `type: 'model'`、`ModelLayerHandle`、`createMap({ quality })`                              | glTF / GLB 加载、WGS84 位置朝向与朝向补偿、颜色叠加、外观策略（提亮 / 无光照）、就地变换、取消加载、并发上限与统一资源释放 |
| 点位图层            | 可用 | `type: 'points'`、`PointsLayerHandle`、`MAX_POINT_LAYER_POINTS`                            | PointPrimitive 批量渲染、单层 20 万点、逐点样式覆盖、原子替换点位、整层样式调整与统一资源释放                              |
| 拾取交互            | 可用 | `map.picking.on('click' \| 'hover')`、`map.picking.setEnabled()`                           | 类型化命中信息（图层 / 对象 / 地球 / 原生对象）、地表经纬高、按帧合并悬停、相机变化期间暂停拾取、点击向下钻取              |
| 相机控制            | 可用 | `map.camera.setView()`、`flyTo()`、`cancelFlight()`                                        | 使用度和米定位、飞行、取消、切换视角时先取消进行中的飞行、退化旋转与 NaN 位姿兜底                                          |
| XYZ 底图            | 可用 | `createMap({ basemap })`、`map.basemap`                                                    | 单底图原子替换、透明度与显隐，始终位于业务影像图层下方                                                                     |
| 地形                | 可用 | `map.terrain.set()`、`TerrainSetOptions`                                                   | 椭球切换和 Cesium Terrain 异步加载，失败或超时（默认 30 秒）时保留旧地形并可立即重试                                       |
| 地形采样            | 可用 | `map.terrain.sample()`                                                                     | 批量高程采样、分批与并发上限、provider 级缓存、无数据不伪造 0、取消与错误码                                                |
| 坐标转换            | 可用 | `map.coordinates`                                                                          | 经纬高与世界坐标互转、投影到窗口像素、屏幕拾取地球表面；未命中返回 `undefined`                                             |
| 渲染质量            | 可用 | `map.quality`、`createMap({ quality })`、`RenderQualityMonitor`                            | 四档预设、分辨率/地形误差/模型并发联动、按帧率自动升降档与降档诊断                                                         |
| 图层错误可观测      | 可用 | `LayerHandle.errorCount`、`layer.events.on('error')`、`map.basemap.errorCount`             | 影像瓦片失败累计计数并只上报首个；底图首个失败经 `map:error` 上报                                                          |
| 空间量算            | 可用 | `measureDistance`、`measureArea`、`measureBBox`、`nearestPointOnPath` 等（包根或 `/core`） | 球面量算：距离、折线长度、面积（含洞）、方位、目标点、包围盒、质心、沿线取点、最近点                                       |
| 空间判断            | 可用 | `isPointInPolygon`、`filterPointsInPolygon`、`normalizeRingWinding`（包根或 `/core`）      | 外环 + 内环判断、边界归属可配、批量判断带包围盒预筛、绕向规范化                                                            |
| CSV 点位导入        | 可用 | `parseCsv`、`readPointCsv`、`guessCsvPointColumns`、`describeCsvColumn`（包根或 `/core`）  | RFC4180 解析、BOM 与编码校验、列数不一致拒绝、严格十进制坐标、列名显式映射与拒绝行样本                                     |
| CRS 坐标转换        | 可用 | `registerCrs`、`registerChinaCrs`、`transformGeoPoint/Path/Ring`、`listCrs`、`describeCrs` | proj4 封装、CGCS2000 高斯带按公式登记并校验带号、往返残差与基准值有单测锁定                                                |
| 数据管线核心        | 可用 | `DataPipeline`（包根或 `/core`）                                                           | 有界队列、同键最新值合并、溢出策略、批量读取和统计快照                                                                     |
| 消息输入适配器      | 可用 | `DataPipelineMessageAdapter`（包根或 `/core`）                                             | Worker / MessagePort 监听、业务解码转发、拒绝/丢弃统计与监听释放                                                           |
| 帧预算调度器        | 可用 | `DataPipelineFrameScheduler`（包根或 `/core`）                                             | 动画帧请求合并、每帧有界消费、自动续帧、取消、失败事件与统计                                                               |
| 实时水位线          | 可用 | `RealtimeWaterline`、`RealtimeTimestampGuard`（包根或 `/core`）                            | 乱序样本按时间释放、精确对象共同覆盖、过期/超限/窗口丢弃统计、双阈值追赶与倍率上限、断流与失活状态、超前样本隔离           |
| Cesium 公共原生访问 | 可用 | `map.raw.viewer`                                                                           | 调用 Cesium 文档中的公共成员；资源归业务代码所有                                                                           |
| 按需导入            | 可用 | `/core`、`/cesium`、`/layers`、`/styles.css`                                               | 将核心工具、Cesium 创建入口和图层工具拆分为独立子路径                                                                      |

完整调用代码见 [API 使用参考](/guide/api-reference)，子路径选择与包体积边界见[导入与包体积](/guide/imports)。

## 未发布能力

| 模块                                 | 当前状态 | 在完成前的边界                                                                                                                         |
| ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 企业影像服务                         | 未发布   | 当前未封装企业鉴权、服务专属参数或凭证更新策略；可临时使用原生出口                                                                     |
| CZML、动态实体与模型动画             | 未发布   | 静态 glTF / GLB 已通过 `type: 'model'` 发布；CZML、动态实体、动画、拾取事件与外观策略仍无 SDK 方法                                     |
| Worker 池与专用动态输入 Adapter      | 未发布   | 尚无 Worker 池、WebSocket/SSE/CZML/二进制协议适配、校验和标准化                                                                        |
| 实时协议与重同步                     | 未发布   | 水位线与时间戳守卫已可用；Worker 池、WebSocket/SSE/二进制协议适配、会话门禁与重连重同步尚未发布                                        |
| 海量数据渲染（聚合 / 标签 / Worker） | 未发布   | 尚无动态渲染器、Primitive / Collection 批处理、自动 LOD 或基准数据承诺                                                                 |
| 绘制与编辑                           | 未发布   | 尚无 `map.drawing`、编辑状态、捕捉或交互事件 API                                                                                       |
| 自定义材质与效果                     | 未发布   | 尚无材质注册、着色器、特效或版本兼容策略                                                                                               |
| `map.analysis` 分析任务              | 未发布   | 量算、判断、CRS 转换与地形采样已可用；`map.analysis` 控制器及其通视 / 视域 / 坡度坡向工具、任务模型、结果图层、Worker 执行接口尚未发布 |
| 插件、诊断和框架绑定                 | 未发布   | 图层与底图已提供错误计数与首个失败事件；尚无插件协议、完整监控 API 或官方 Vue / React 组件                                             |
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
