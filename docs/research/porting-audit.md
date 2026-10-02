# 移植审计：参照实现能力 × SDK 封装现状

- 文档日期：2026-09-30
- 审计对象：`Plugin-web/src/features/gis/`（参照实现）与 `gis-sdk/src/`（SDK 现状）
- 用途：回答"某项能力移植了吗、封装成什么 API 了、没移植的话差在哪、要多少工作量"
- 相关文档：`remaining-blocks-plan.md`（裁决与路径）、`spatial-analysis-plan.md`（空间计算选型）

状态口径：

| 标记       | 含义                                                        |
| ---------- | ----------------------------------------------------------- |
| **已封装** | SDK 有公开 API，有单测，文档与能力表已同步                  |
| **部分**   | 算法或契约已进 SDK，但上层的会话/加载/编排层未做            |
| **待拍板** | 技术可行、与 SDK 边界不冲突，但需要业务确认要不要（见文末） |
| **不封装** | 属于 UI、后端协议或 Cesium 私有字段，SDK 明确不做           |

## 1. 环境效果

| 能力                 | 参照实现                                                            | SDK 现状                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 环境效果总入口       | `environment/EnvironmentController.ts`（737 行，含互斥组）          | **已封装**：`map.environment.set / setEnabled / clear / clearAll / active`；雨雪互斥已实现                                                                          |
| 深度雾（距离+高度）  | `effects/DepthFogEffect.ts` + `shaders/depthFog.ts`（261 行）       | **已封装**：`set('depthFog', { density, startDistanceMeters, endDistanceMeters, color, heightFalloffMeters, topHeightMeters, brightness })`；二维降级说明           |
| 高度雾 / 基础雾      | `effects/HazeEffect.ts`（149 行，复用官方 `scene.fog`）             | **已封装**：`set('haze', { density, heightFalloff, maxHeight, brightnessFloor, screenSpaceErrorFactor })`；用 `FieldGuard` 记录原值并按"只覆盖自己最后写入的值"恢复 |
| 降水（雨雪共用参数） | `effects/PrecipitationEffect.ts` + shaders（338 行）                | **已封装**：`set('rain' \| 'snow', { intensity, density, speed, windDirection, windStrength, streakLength, flakeSize, brightness })`；两者共用一个后处理阶段        |
| 热力图               | `effects/HeatmapEffect.ts` + `HeatmapImageryProvider.ts`（650 行）  | **待拍板**：依赖时序栅格数据集（参照实现用 `public/gis/environment/heatmap-mock.*`）。技术上是公共 ImageryProvider，可移植；要先定数据集格式与加载策略              |
| 三维风场             | `effects/Wind3DEffect.ts` + `windSampling.ts`（570 行）             | **待拍板**：依赖 U/V/W 风场数据集；实现是 CPU 粒子平流 + PolylineCollection（公共 API）。同样先定数据格式                                                           |
| 空间闪电             | `effects/LightningEffect.ts` + `LightningFlashChannel.ts`（557 行） | **待拍板**：程序化生成，不依赖外部资产，纯几何 + 材质；可移植（用公共折线/材质类型实现）                                                                            |
| 云体积 / 水面        | `effects/CloudVolumeEffect.ts`、`WaterSurfaceEffect.ts`（635 行）   | **不封装**：体积纹理与水面网格依赖外部资产与自定义 shader，超出"不附带资产、不碰私有字段"的边界                                                                     |

## 2. 标绘与军用符号

| 能力           | 参照实现                                                                                                                                | SDK 现状                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标绘会话与几何 | `plot/PlotController.ts` 797 + `geometry/plotGeometry.ts` 655 + `militaryGeometry.ts` 520 + `serialization.ts` 254 + `PlotLayer.ts` 208 | **待拍板**：几何是**纯数学、零 Cesium 依赖**（测地线、圆/椭圆、直箭头、攻击箭头、双箭头、燕尾、16 控制点战术箭头、队形与方向三种军标），可移植；但"军标语义是否进通用 GIS SDK"是产品决定 |
| 战术箭头       | 见上（`plotGeometry.ts:342-555`、`militaryGeometry.ts:72-520`）                                                                         | **待拍板**：同上，约 665 行纯几何                                                                                                                                                        |
| 队形与方向     | `militaryGeometry.ts`（`twoPointArrow` / `pathArrow` 等）                                                                               | **待拍板**：同上，与上两项共用同一批解算函数                                                                                                                                             |
| 标绘序列化     | `plot/serialization.ts`（版本化 `PlotDocument`）                                                                                        | **不封装**：存储格式属业务；SDK 只提供几何与渲染                                                                                                                                         |
| 绘制（非标绘） | `interaction/` 绘制与编辑                                                                                                               | **已封装**：`map.drawing` 绘制 / 编辑 / 顶点增删 / 吸附（见 [绘制](../guide/drawing.md)）                                                                                                |

## 3. 帧率、诊断与性能

| 能力               | 参照实现                                                                     | SDK 现状                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 帧率与自动降档     | `performance/RenderPerformanceMonitor.ts`（182 行）                          | **已封装**：`createMap({ quality, qualityAdaptive })`、`map.quality.snapshot.fps`、`RenderQualityMonitor`                                    |
| 诊断导出           | `useGisPerformance.ts:exportReport`（JSON Blob 下载）                        | **部分**：`map.diagnostics.snapshot()` 给出结构化快照（图层/质量/相机/环境/绘制），**文件下载**属浏览器 UI，由业务序列化即可                 |
| 帧率分位数与长任务 | `performance/CapacityRecorder.ts`（215 行：fpsP50/P95、长帧、长任务、积压）  | **待拍板**：SDK 目前只有滑动窗口均值；分位数统计是纯计算，可加进 `/core`，但需要确认指标口径                                                 |
| 浏览器内存诊断     | `BrowserMemoryDiagnostics.ts`（34 行，`performance.memory`）                 | **不封装**：非标准 API，只在 Chromium 可用；业务按需读宿主环境                                                                               |
| 启动阶段时间线     | `GisStartupTimeline.ts`（38 行）                                             | **部分**：SDK 有 `map:error`／图层 `state:changed` 与 `diagnostics`，没有启动阶段打点；属业务埋点                                            |
| 模型 LOD           | `layers/satellite/SatelliteLayer.ts:updateLod`（985 行中的 LOD 部分）        | **待拍板**：屏内筛选 + 遮挡 + Top-K 是与业务数据（星座/批次）耦合的调度；SDK 侧已有质量档与 `LoadLimiter`，通用 LOD 需要先定"选谁上屏"的口径 |
| 点聚合             | `points/pointLayerPlan.ts`（内置 clustering 仅 Entity 后端可用）             | **已封装（更通用）**：`clusterPoints()` 纯网格聚合任意点数 + `map.camera.metersPerPixel` 按屏幕像素驱动；标签用 `LabelCollection`            |
| 数据规模压测       | 无系统化结果                                                                 | **已交付**：`pnpm bench`（纯计算层）+ 验收台浏览器端矩阵探针与一次实测记录（[性能基准](../guide/performance.md)）；多浏览器 / 多机型对照仍缺 |
| Worker 化          | `core/frameQueue.ts` + 4 个 worker（realtime/orbit/positions/replay-parser） | **部分**：SDK 有分析 Worker 客户端/宿主/池；渲染与实时链路的主线程外移由业务编排                                                             |

## 4. 仿真与回放

| 能力                | 参照实现                                                                            | SDK 现状                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 时钟与播放状态      | `playback/SimulationClock.ts`（202 行）                                             | **已封装**：`SimulationClock`（idle/playing/paused/ended/stalled、倍率、方向、seek/step、水位线限速）                                    |
| 事件调度            | `simulation/SimulationEvents.ts`（41 行，可正/反向遍历）                            | **待拍板**：小体量纯逻辑（给定时刻取"该触发的事件"），可移植；需要确认事件模型是否由 SDK 定义                                            |
| 轨道数学            | `simulation/OrbitMath.ts` + `CustomOrbitMath.ts`（559 行）                          | **已封装**：`calculateOrbitalElements`、`propagateTwoBody`、`sampleOrbitPositions`、`orbitalElementsFromAnchor`、`findClosestApproaches` |
| 姿态                | `simulation/AttitudeDynamics.ts`（61 行）                                           | **已封装**：`AttitudeDynamics` + 四元数 `slerp` / 与 Cesium 逐位一致的 HPR 互转                                                          |
| CZML                | `simulation/CzmlAdapter.ts`（530 行）                                               | **已封装**：生成/解析/轨迹时间轴桥 + **CZML 图层** `type: 'czml'`                                                                        |
| 回放时间轴          | `playback/ReplayTimeline.ts`（500 行）                                              | **已封装**：`ReplayTimeline`（排序、同刻去重、容量、插值查询、窗口切片、有界外推）                                                       |
| 回放窗口加载/帧解析 | `ReplayWindowLoader.ts` + `ReplayFrameParser.ts` + `ReplayDataAdapter.ts`（687 行） | **不封装**：窗口预取、Worker 解析、历史帧→实体的适配都依赖后端协议与 session token                                                       |
| 回放会话控制        | `ReplayController.ts` + `ReplaySession.ts`（191 行）                                | **部分**：SDK 有轨道桥 `createTrackTimeline()` + `sampleTrackPose()`；会话编排（暂停/跳转/导出）留业务                                   |
| 轨道控件与罗盘      | 无独立罗盘；`camera/PointerLookController.ts`（161 行）指针锁定                     | **不封装**：相机操控属 Cesium 原生（`screenSpaceCameraController`）或业务 UI；SDK 提供 `map.camera` 读数与 `setView`                     |

## 5. 点位导入

| 能力                          | 参照实现                                                  | SDK 现状                                                                                     |
| ----------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| CSV 解析                      | `points/csv.ts`（233 行）                                 | **已封装**：`parseCsv` / `readPointCsv` / `guessCsvPointColumns`（RFC4180、BOM、拒绝行样本） |
| 导入计划（列映射、CRS、预览） | `points/importPlan.ts`（257 行）                          | **部分**：SDK 有列名猜测与 `transformGeoPoint` CRS 转换；**"预览—提交/取消"的导入会话未做**  |
| 导入控制器                    | `points/PointImportController.ts`（231 行）               | **待拍板**：会话/进度/取消可移植，需要确认与 `map.layers` 的分工（导入直接落到点位图层？）   |
| 点位渲染与上限                | `CesiumPointLayerPort.ts` + `pointLayerPlan.ts`（389 行） | **已封装**：`type: 'points'` 单层 20 万点、逐点样式、原子替换、标签与 `labelCount`           |

## 6. 资源配置与交互

| 能力               | 参照实现                                                                      | SDK 现状                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 资源拖拽添加       | `views/gis/components/GisResourcePanel.vue`（406 行，HTML5 drag + MIME 协议） | **不封装**：这是页面交互与 MIME 协议，属应用层；SDK 提供 `map.layers.add()` 与拾取命中信息即可                                   |
| 图层拖拽排序       | 参照实现**也没有**（无 sortable 依赖）                                        | **待拍板**：SDK 的 `map.layers` 目前只有 add/remove/list，**没有层级调整 API**；要排序得先定语义（业务图层之间？与底图的关系？） |
| 画布快照与视图过渡 | `view/MapFragmentTransition.ts`（559 行，双 Viewer）                          | **不封装**：页面编排；SDK 已给 `map.capture()` 与 `map.scene.setMode()` 两个原语                                                 |
| 多视图相机同步     | `view/CameraSynchronizer.ts`（约 200 行）                                     | **部分**：SDK 有 `map.camera.view` / `viewRectangle` / `metersPerPixel` 只读快照；同步留给业务                                   |

## 7. 需要业务拍板的清单（按建议优先级）

| #   | 事项                       | 体量        | 拍板要点                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 标绘 + 战术箭头 + 队形方向 | 约 1,200 行 | **部分交付（2026-10-01）**：通用几何先进 SDK——`buildCircle` / `buildEllipse` / `buildStraightArrow`（`/core`，控制点 → 顶点环，零 Cesium），见[绘制](../guide/drawing.md#程序化构造图形)。**军标几何（战术 / 钳击箭头、队形方向）仍待拍板**：依赖具体标准与业务语义，SDK 不定义；序列化也留在业务                                                                                                       |
| 2   | 空间闪电                   | 约 560 行   | 是否要内置"闪电"这类演出效果；不依赖外部资产，纯几何 + 公共材质可做                                                                                                                                                                                                                                                                                                                                     |
| 3   | 热力图 / 三维风场          | 约 1,200 行 | 数据集格式与加载策略（SDK 不附带资产）：业务提供端口，还是 SDK 定义 manifest 契约                                                                                                                                                                                                                                                                                                                       |
| 4   | 回放会话编排               | 约 190 行   | **已交付（2026-10-01）**：`ReplaySession`（`/core`）订阅时钟提交快照并**按修订号合并**（连跳只提交最后一次、在途提交可被中止），提供播放 / 暂停 / 跳转 / 步进 / 停止 / 换时间轴 / 区间取数；**数据源仍留业务**——不预取、不缓存、不做窗口加载，参照实现里与业务实体模型绑定的结构检查点也未移植。详见[回放时间轴](../guide/replay-timeline.md)                                                           |
| 5   | 仿真事件调度               | 约 40 行    | 事件模型由 SDK 定义还是业务自定义后注入                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | 导入会话（预览/提交/取消） | 约 230 行   | 与 `map.layers` 的分工：导入直接落点位图层，还是只产出解析结果                                                                                                                                                                                                                                                                                                                                          |
| 7   | 帧率分位数与长任务统计     | 约 200 行   | **已交付（2026-10-01）**，口径按最简可复现选取：分位用最近秩（P50/P95）、长帧阈值默认 50 毫秒（与浏览器 Long Tasks 对齐，可按 `createMap({ quality: { longFrameMs } })` 调整）、统计进 `/core` 纯计算层 `FrameStatistics` 并接入 `map.quality.snapshot`；长任务本身只在验收台读浏览器 API（Chromium 独有）。详见[性能基准](../guide/performance.md)与[渲染质量](../guide/quality.md)                    |
| 8   | 图层排序 API               | 约 100 行   | **已交付（2026-10-01）**，语义按"只在有定义的地方给接口"选取：仅影像通道提供句柄级顺序控制（`stackIndex` / `raise` / `lower` / `raiseToTop` / `lowerToBottom`），**底图恒在最底层**且序号按业务影像图层计；图元（点位 / 折线 / 模型 / 3D Tiles）与数据源（CZML / GeoJSON）不提供——可见性由几何与深度决定，集合顺序不决定谁盖住谁；不做跨通道排序。详见[图层管理](../guide/layer-management.md#堆叠顺序) |
| 9   | 模型 LOD                   | 约 300 行   | "选谁上屏"的业务口径（屏内筛选、遮挡、Top-K 或按距离分档）                                                                                                                                                                                                                                                                                                                                              |
| 10  | WebGL 端到端性能矩阵       | 验证项目    | 矩阵探针与测法已就绪（[性能基准](../guide/performance.md)），仍需指定浏览器与机型，以及可接受的性能阈值                                                                                                                                                                                                                                                                                                 |

## 8. 明确不封装的部分

- **Cesium 私有字段**：`Scene.context`、`Scene.frameState`、`Material._materialCache`、自定义 `DrawCommand`。参照实现的环境适配、闪电材质、风场绘制依赖它们；SDK 只用公共 API，因此这些能力若移植需要按公共 API 重写（热力图/风场/闪电都已确认可用公共接口实现）。
- **页面交互与 UI**：资源拖拽、图层面板、相机面板、性能面板、诊断文件下载。
- **后端协议与凭证**：历史帧窗口加载、session token、CZML 数据源拉取（SDK 只解析文档）。
- **存储格式**：标绘序列化、快照持久化。
- **外部资产**：体积云 / 水面的纹理与网格；SDK 不附带任何纹理资产。
