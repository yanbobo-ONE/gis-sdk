# 剩余模块的选型与边界裁决

- 文档日期：2026-09-30
- 适用仓库：`gis-sdk`（本文的裁决与路径以本仓库为准）
- 参照实现：`Plugin-web/src/features/gis/`（行数按非测试文件统计）
- 状态：待评审；编码前需拍板 §6 的 4 项

## 1. 结论摘要

| 模块                                        | 行数     | 裁决                                                                                        |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `simulation/` 轨道与姿态数学                | 630      | **已落地**：六根数、二体传播、锚点轨道、采样、最近接近、姿态积分（见本仓库 `src/spatial`）  |
| `simulation/CzmlAdapter.ts`                 | 530      | **进 SDK（P1）**：CZML 是公开数据格式，生成/解析是纯函数；数据源加载仍走原生出口            |
| `interaction/` 绘制编辑与捕捉               | 约 800   | **进 SDK（P1）**：绘制已发布，编辑与吸附是自然延伸，需先定"编辑会话"契约                    |
| `playback/` 时间轴与播放时钟                | 约 700   | **部分进 SDK（P1）**：`ReplayTimeline` + `PlaybackClock` 是纯状态机；帧解析与数据源留在业务 |
| `view/CameraSynchronizer`                   | 约 200   | **进 SDK（P2）**：多视图相机同步是引擎无关的状态同步                                        |
| `environment/` 轻量效果（雾、霾、降水）     | 约 900   | **进 SDK（P2）**：参数可拆成 SDK 级与业务级；先做这三个，重效果后置                         |
| `environment/` 重效果（云体积、热力、风场） | 约 6,000 | **只定契约**：依赖 shader、纹理资产与数据集，先给端口与边界，不动实现                       |
| `plot/` 标绘                                | 2,484    | **只定契约**：几何含业务语义且参照实现仍在演进，SDK 提供图层与端口，几何留给业务            |
| `view/MapFragmentTransition`                | 559      | **留在业务**：双 Viewer + 截图过渡是页面级编排；SDK 已提供 `capture()` 与 `setMode()` 原语  |
| `materials/` 自定义 GLSL                    | 约 400   | **留在业务**：注册自定义材质要走 Cesium 私有材质缓存，版本敏感；SDK 只用公开材质类型        |
| `core/cesiumCompatibility`                  | 122      | **不移植**：SDK 锁定单一 Cesium 版本，兼容垫片没有意义                                      |

## 2. 判断标准

一条能力进 SDK 需要同时满足：

1. **引擎无关或可抽象成端口**：不依赖 Cesium 私有字段、不依赖具体页面框架；
2. **参数可分层**：能说清哪些是 SDK 稳定承诺（单位、范围、默认值），哪些属于业务取值；
3. **可验证**：能用单测或与独立实现交叉验证锁定行为，而不是"看起来对"；
4. **有明确的所有权**：资源的创建与释放都能归到 SDK 或业务的一方，不出现两不管。

不满足第 1 条的（私有 API、页面编排）留在业务；不满足第 2 条的（业务参数占主导）先只定契约。

## 3. 逐块裁决

### 3.1 CZML（`simulation/CzmlAdapter.ts`，530 行）

- **现状**：从采样点生成 CZML 文档、以及从 CZML 还原采样点；参照实现里带了不少业务字段（载荷、告警状态）。
- **裁决**：把**纯格式部分**搬进 `src/core/czml.ts`：
  - `czmlFromPositions(id, positions, options?)`：经纬高序列 → CZML 文档（`PositionProperty` + 采样时间）；
  - `positionsFromCzml(document)`：从 CZML 文档取回时间-位置序列（用于回放与对照）。
- **边界**：业务字段（载荷、告警、平台状态）**不**进 SDK；CZML 数据源加载仍走 `map.raw.viewer.dataSources.add(CzmlDataSource.load(...))`，`map.dataSources` 属未发布能力。
- **风险**：CZML 规范很大，本模块只覆盖 `position`/`cartographicDegrees` 与时间采样这两块最小集，其余属性透传。

### 3.2 绘制编辑与捕捉（`interaction/`，约 800 行）

- **现状**：`GisDrawEditController` 支持拖动顶点、增删顶点；绘制本体已发布（`map.drawing`）。
- **裁决**：进 SDK，复用已发布的绘制契约形状：
  - `map.drawing.edit(handle | geometryId)` 进入编辑会话；
  - 编辑事件：`vertex:move`、`vertex:add`、`vertex:remove`、`commit`、`cancel`；
  - 捕捉：`snap` 选项（顶点优先、边次之，阈值像素）。
- **边界**：只编辑 **SDK 自己创建且仍持有**的几何；不接管业务图层的编辑；不做拓扑校验（自交检测依赖 `@turf/boolean-valid`，排在更后）。
- **代价**：这是本轮剩余项里唯一的交互型能力，需要新的输入动作（左键按下拖拽）与预览几何，测试要覆盖"拖动中断""编辑中取消"等路径。

### 3.3 回放时间轴与播放时钟（`playback/`，约 700 行中的通用部分）

- **现状**：`ReplayTimeline` 管时间窗口与切片，`PlaybackClock` 管播放倍率、暂停与拖拽定位；帧解析、窗口加载与数据源适配与协议强相关。
- **裁决**：把两个纯状态机搬进 `src/core/`：
  - `ReplayTimeline`：窗口起止、切片边界、按窗口取区间；
  - `PlaybackClock`：倍率（含负值倒放）、暂停/恢复、`seek(时间)`、`tick(nowMs)` 推进游标。
- **边界**：不做数据读取、不做 Worker 解析、不做缓存策略；与现有 `RealtimeWaterline` 的分工是"回放用显式时钟推进，实时用水位线限速"。
- **风险**：低。两者都是纯数字状态机，可用假时钟做确定性测试。

### 3.4 多视图相机同步（`view/CameraSynchronizer`，约 200 行）

- **现状**：把主视图的相机状态同步到副视图（分屏、鹰眼、快照视图）。
- **裁决**：进 SDK（P2），契约形状：
  - `map.camera.synchronize(source: CameraView, target?: 'secondary')`？—— **需要先定"第二视图"在 SDK 里是什么**（SDK 目前一个实例一个 Viewer）。
  - 更可能落地的形态是提供 `readonly view: CameraView`（读取当前相机）+ `setView()`（已有），让业务自己同步；只有当 SDK 提供多视图能力时才需要 `CameraSynchronizer`。
- **结论**：**降级为"先提供 `map.camera.view` 只读快照"**，多视图同步留给业务。

### 3.5 环境效果（`environment/`，9,486 行）

- **现状**：云体积、深度雾、霾、热力、闪电、降水、水面、三维风场，含 shader、纹理生成与采样；参数里既有物理量（密度、能见度）也有业务量（数据集、时间轴、强度曲线）。
- **裁决**：分两档。
  - **P2 做轻量三件**：深度雾、霾、降水。它们的参数可以完全落在 SDK 侧（范围、密度、颜色、每帧推进量），实现是 shader + 少量状态，且不依赖外部数据资产。
  - **重效果只定契约**：云体积、热力图、三维风场需要体积纹理/数据集/采样网格，先定义 `map.environment` 的端口（`apply(effect, options)` / `remove` / `list`）与参数边界，实现由业务提供或后续按需落地。
- **边界**：SDK 不内置纹理资产；shader 与 Cesium 版本绑定，升级需要回归清单。

### 3.6 标绘（`plot/`，2,484 行）

- **裁决**：**只定契约**。理由是参照实现仍在演进，且几何（军标）本身是业务语义。建议 SDK 侧只提供：
  - `PlotGeometryPort`：业务实现"控制点 → 经纬高序列"，SDK 负责渲染与生命周期（复用[折线图层](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/polyline-layer.md) 与[点位图层](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/points-layer.md)）；
  - 序列化（保存/加载标绘）留在业务，SDK 不定义存储格式。

### 3.7 自定义 GLSL 材质（`materials/`，约 400 行中的注册部分）

- **裁决**：**不封装**。参照实现通过 `Material` 的私有材质缓存注册自定义类型，属于版本敏感的内部接口（SDK 只用 Cesium 公开材质类型，见[折线图层](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/polyline-layer.md) 的说明）。业务确有需要时在 `map.raw.viewer` 上自行注册，并在升级 Cesium 时自行回归。

## 4. 不建议做的事

| 不做                                        | 理由                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| 为 `view/MapFragmentTransition` 造双 Viewer | 页面编排属于应用层；SDK 已给 `map.capture()` 与 `map.scene.setMode()` |
| 把 `GisManager` 式总入口搬进 SDK            | SDK 是契约 + 控制器，不做页面级状态机                                 |
| 用 Cesium 私有 API 换取体积或性能           | 升级即碎；宁可少一个能力也不碰私有字段                                |
| 定义标绘的存储格式                          | 业务存储格式演进频繁，SDK 不应固化                                    |

## 5. 建议路径

| 阶段 | 内容                                                     | 预估       |
| ---- | -------------------------------------------------------- | ---------- |
| P1-a | CZML 生成与解析（`src/core/czml.ts`）                    | 300–400 行 |
| P1-b | 回放时间轴与播放时钟（`src/core/replay-timeline.ts` 等） | 250–350 行 |
| P1-c | 绘制编辑与吸附（`map.drawing.edit`）                     | 500–700 行 |
| P2-a | 轻量环境效果（雾、霾、降水）                             | 600–900 行 |
| P2-b | `map.camera.view` 只读快照与文档补强                     | 100 行     |
| 待定 | `map.environment` 端口与标绘 `PlotGeometryPort` 契约     | 契约先行   |

每一阶段的验收与既有流程一致：单测与交叉验证、`pnpm lint` / `typecheck` / `test` / `build` / `pack:check` / `docs:build` 全绿、能力状态表与 README 同步、新增 changeset。

## 6. 待确认项

1. **CZML 的范围**：只做 `position`（`cartographicDegrees`）与时间采样，还是要把 `billboard`/`label` 等常用属性也纳入？
2. **绘制编辑是否本期做**：它是剩余项里唯一的交互能力，工作量大且需要新输入动作（拖拽）；也可以先只做吸附。
3. **环境效果的资产策略**：轻量三件不依赖外部资产；重效果若要做，纹理与数据集由业务提供还是 SDK 附带？
4. **标绘端口是否值得**：如果业务已经有成熟的标绘实现，SDK 只提供图层即可，`PlotGeometryPort` 可以不做。
