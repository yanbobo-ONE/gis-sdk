# Changelog

## 0.1.0-alpha.10

### Minor Changes

- 增加类型化静态模型图层，支持 glTF / GLB 加载、WGS84 位置朝向、颜色叠加、`setTransform()` 就地变换、取消加载、可配置并发上限和统一资源释放。
- 增加类型化坐标转换 `map.coordinates`、地形高度采样 `map.terrain.sample()`、渲染质量档与按帧率自动降档（`createMap({ quality })`、`map.quality`），并让模型并发上限统一由质量档控制。
- 增加影像图层与底图的远端失败可观测性：累计错误计数，只上报首个失败（图层事件 `error` 与 `map:error`）。
- 增加空间计算层（`/core`，零 Cesium 纯函数）：量算、空间判断与 CRS 坐标转换（含 CGCS2000 高斯带），并定稿 `map.analysis` 契约（尚未挂到地图实例）。
- 增加仿真 / 回放时钟 `SimulationClock`：播放状态机、倍率与方向、seek/step 与水位线限速。
- 增加 CZML 位置采样的生成与解析（含 ISO 时间戳、包级 epoch 与可用区间往返一致）。
- 增加最近接近预警 `findClosestApproaches()`：最近时刻与距离、半径阈值与告警排序。
- 增加轨道几何：锚点推导圆轨道与可渲染采样点（首尾重合、可直接交折线图层），越界取值校验抛错。
- 增加轨道与姿态数学：开普勒六根数求解、二体传播（二分法解开普勒方程）与四元数姿态积分。
- 增加交互绘制 `map.drawing`：点 / 折线 / 面绘制、预览、确认与取消，以及框架无关的绘制状态机。
- 增加绘制编辑 `map.drawing.edit()` / `commitEdit()` / `cancelEdit()`：对几何副本拖动顶点（左键命中屏幕 12 像素内最近顶点、点几何整体移动）、提交与回退，事件 `edit` / `editCommit` / `editCancel`，并导出框架无关的 `DrawingEditMachine` 与几何校验 `isEditableGeometry()`、`isValidDrawPosition()`。
- 增加相机只读快照 `map.camera.view` 与 `map.camera.viewRectangle`：读取当前位姿（角度为度，字段一定存在，可直接传回 `setView()`）与视口经纬四至；位姿退化抛 `CAMERA_VIEW_UNAVAILABLE`，看不到椭球或覆盖全球时四至为 `undefined`。
- 增加环境效果 `map.environment.set()`：深度雾、基础雾与雨 / 雪，含参数校验与默认值、二维降级说明、统一资源释放，以及零 Cesium 依赖的 `EnvironmentTimeline` 与 `FieldGuard`；着色器内联，不引用外部纹理资产。
- 增加回放时间轴 `ReplayTimeline`（`/core`）：按对象分组、时间排序与同刻去重、容量上限、按时刻插值查询、窗口与轨迹切片、有界外推；插值函数由调用方注入，不读数据源。
- 增加分析工具 `map.analysis`：13 个内置工具（量算 / 判断 / CRS / 地形采样 / 通视 / 视域 / 坡度坡向），算法与控制器都在 `/core` 零 Cesium 依赖，结果带算法版本，支持 `signal` 取消。
- 扩展 CZML 覆盖：`model` 报文（gltf + 最小像素尺寸）与 `tracksFromCzml()` 的姿态四元数采样与模型地址解析，`positionsFromCzml()` 输出不变。
- 增加位置批量归一化 `normalizePositions()`：坐标校验、按 id 合并最新、可转移的 Float64Array 输出。
- 增加折线图层与五种内置材质：PolylineCollection 批量渲染、逐条样式覆盖、原子替换与整层样式调整；画布快照契约改为可移植形状，core 层不再依赖 DOM 类型。
- 增加运行时场景模式切换 `map.scene.setMode()`：形变完成结算、同模式立即结算、被取代语义与销毁处理。
- 增加画布快照 `map.capture()`：postRender 同帧拷贝、降采样判空、重试与超时返回 undefined。
- 增加实时会话门禁与重同步控制器：旧会话迟到包丢弃、序列断档自动转入快照等待、重复请求合并与有界重试。
- 增加实时水位线与时间戳守卫：乱序样本按时间释放、精确对象共同覆盖、双阈值追赶、超前样本隔离与诊断统计。
- 增加拾取交互 `map.picking`：点击 / 悬停命中信息（图层与对象 id、地球、原生对象）、按帧合并的悬停节流与相机变化期间暂停拾取；点位图层与静态模型写入拾取标记。
- 增加点位图层与 CSV 点位导入：PointPrimitive 批量渲染（单层 20 万点）、逐点样式覆盖、原子替换与整层样式调整；CSV 解析遵循 RFC4180 并提供列名映射、编码校验与拒绝行样本。
- 模型图层补完：增加朝向补偿 `headingOffset` 与外观策略 `appearance` / `setAppearance()`（提亮、无光照），并导出 `ModelAppearanceOptions`。
- 空间计算引入 `proj4` 与 turf 子包：SDK 自身包体积仅 +4.6 KB gzip，但 `proj4` 未声明 `sideEffects`，从 `/core` 导入的消费方会带上约 42 KB gzip；实测数据见 `docs/research/spatial-analysis-plan.md` §3.5。
- 图层句柄新增 `errorCount`，底图新增 `errorCount`，取消中的 GeoJSON 数据替换不再把图层置为错误状态。

### Patch Changes

- 加固相机与图层运行稳定性：安装退化旋转与 NaN 位姿兜底、切换视角时取消进行中的飞行、地形加载超时保护，以及 GeoJSON 取消加载后保持旧数据并回到稳定状态。

## 0.1.0-alpha.9

### Minor Changes

- 增加类型化单图影像图层，支持 WGS84 度数范围、异步加载、显隐、透明度、取消加载和统一资源释放。

## 0.1.0-alpha.8

### Minor Changes

- 增加类型化 TMS 和 WMTS 影像图层，支持显隐、透明度、取消加载和统一资源释放。

## 0.1.0-alpha.7

### Minor Changes

- 增加有界数据管线的帧预算调度器，支持请求合并、批量消费、取消和调度统计。

## 0.1.0-alpha.6

### Minor Changes

- 增加可将 Worker 或 MessagePort 消息接入有界数据管线的类型化适配器，支持业务解码、输入统计和监听释放。

## 0.1.0-alpha.5

### Minor Changes

- 增加受生命周期管理的 3D Tiles 图层，支持加载、显隐、基础 LOD 配置和资源释放。

## 0.1.0-alpha.4

### Minor Changes

- 增加框架无关的有界数据管线，支持最新值合并、溢出策略、批量读取和统计快照。

## 0.1.0-alpha.3

### Minor Changes

- 增加类型化相机、XYZ 底图和椭球 / Cesium Terrain 地形控制器，补充构造失败清理、业务影像图层隔离和完整使用文档。

## 0.1.0-alpha.2

### Patch Changes

- 补充可运行的 API 使用说明、功能状态页和 npm 包 README，并明确未发布能力的边界。

## 0.1.0-alpha.1

### Minor Changes

- 4ab21ec: 增加类型化 Layer Runtime、Cesium GeoJSON/WMS 图层适配器，以及 `core`、`cesium`、`layers` 按需导入入口；同步提供面向使用者的完整 API 文档。

本项目遵循 [Semantic Versioning](https://semver.org/)。pre-alpha 阶段的公共接口仍可能调整。

## 0.1.0-alpha.0 - 2026-08-18

### Added

- 建立独立 `gis-sdk` 仓库和 `@yanbobo/gis-sdk` npm 包结构。
- 锁定 Cesium 1.144.0，提供 ESM、CommonJS、类型声明和样式入口。
- 添加 `createMap()`、`GisMap`、`EventHub`、`GisError` 和类型化生命周期事件。
- 提供 Cesium `Viewer` 适配器和 `raw.viewer` 高级访问入口。
- 提供 `gis-sdk-copy-assets` 跨平台 Cesium 静态资源复制命令。
- 添加 VitePress 指南、TypeDoc API、发布护栏和持续集成。

### Compatibility

- Node.js 22 及以上。
- pnpm 11.19.0。
- 浏览器端需要 WebGL 和 `crypto.randomUUID()`。

### Known Limitations

- 尚未实现图层管理、海量数据管线、Worker、材质和空间分析模块。
- 尚未执行 npm 首次发布。
- 真实浏览器 WebGL 场景和既有业务页面接入验证属于后续里程碑。
