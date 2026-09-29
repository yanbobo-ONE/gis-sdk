# 空间分析与坐标转换选型实施方案

- 文档日期：2026-09-29
- 适用仓库：`gis-sdk`（本文的源码路径、命令、发布流程均以本仓库为准）
- 需求证据：取自下游仓库 `Plugin-web` 的现场卡点，逐条标注来源路径
- 体积口径：2026-09 实测（rolldown minify + gzip -9，含全部传递依赖），复现命令见 §8.4
- 状态：待评审；编码前需拍板 §9 的 6 项

## 1. 结论摘要

六个库逐条裁决。**加粗的是与常见说法不一致的实测结论。**

| 库                               | 定位                   | 裁决                                                                                                                             |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Turf.js**                      | 通用 GeoJSON 空间分析  | **采纳，主路径**。量算、范围判断、抽稀、最近点全是空缺；11 个核心子包实测仅 **12.0 KB gzip**                                     |
| **Delaunator**                   | 极速 Delaunay 三角剖分 | **采纳，限定用途**。3.0 KB gzip，依赖 robust-predicates；补散点三角化/凸包/Voronoi。**不能替换耳切**，同类替换品是 earcut        |
| **Proj4js**                      | 坐标转换事实标准       | **采纳**。全量 41.4 KB gzip，不做瘦身版（§3.2）。**不内置 CGCS2000 与国内高斯带**，必须自行注册 defs                             |
| **JSTS**                         | OGC 几何拓扑引擎       | **不直接引入主路径**，缓冲区/叠加阶段按 §3.3 三选一；按需引入的 JSTS 比 turf 的对应封装还小，但裸导入是坏的、谓词要 monkey-patch |
| **rayshon-high-performance-gis** | Cesium 海量渲染增强    | **架构参考，不引库**。SDK 自身已是 Cesium 封装层，再叠一个增强库等于两套对象生命周期；其 PBF 能力在本项目群没有数据源            |
| **lil-gui**                      | 轻量调试面板           | **不进 SDK 依赖**（8.4 KB gzip）。调参面板属于 `examples/` 的开发期工具，放 devDependency                                        |

另外澄清三处常见说法：

1. "Turf 的 buffer 基于 JSTS 裁剪版实现" —— 方向对，但要说清：`@turf/buffer` 依赖 `@turf/jsts@2.7.2`，那是一个**自包含的 264 KB JSTS 裁剪构建**（同时声明依赖 `jsts@2.7.1`，会在 node_modules 里再装一份但打包不使用）。**它与你直接引的 `jsts` 不共享代码**——两者同时引入就是两份 JSTS 血统。
2. "复杂几何运算不如 JSTS，所以用 JSTS 替换 Turf" —— **turf v7 的求交走的是 polyclip-ts，不是 JSTS**（实测 `@turf/intersect` 依赖 `polyclip-ts@^0.16.8`，15.1 KB gzip）。所以"替换"的对象是 polyclip-ts。
3. "JSTS 体积比 Turf 大" —— 分情况。预压缩整包 480 KB 确实大且不可 tree-shake；但按需走 ESM 源码，**buffer 只要 50.2 KB gzip，比 `@turf/buffer` 的 63.8 KB 还小**。

一句话定位：SDK 的能力状态表里"空间分析"标着**未发布**（`docs/guide/capability-status.md`：「尚无 `map.analysis`、任务模型、结果图层或 Worker 执行接口」），PRD 已把落点写清（`docs/cesium-sdk-prd.md` §14.2，`map.analysis.run()`）。**缺的不是算法，而是把算法装进 SDK 契约的那一层**。本文给出这个能力区的依赖选型、契约设计与分阶段路径。

## 2. 需求来源与 SDK 现状

### 2.1 需求来源：下游现场卡点（证据取自 `Plugin-web` 仓库）

下表每条都来自下游应用的现场问题，是 SDK 空间分析能力的需求来源与验收对象。**证据路径属于 `Plugin-web`，SDK 实现不得依赖该仓库的任何模块**（见 §2.4）。

| 场景                                | 下游现状（`Plugin-web` 仓库路径）                                                                                                | SDK 需要的算法                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 目标在不在警戒区 / 雷达覆盖圈内     | 页面已能画覆盖圈与告警区，但圈只是图形，没有"谁在圈里"的判断；全仓无任何点在多边形内实现                                         | `isPointInPolygon`                                      |
| 5 万行导入点位里有几个落在 A 区     | 点图层能存到单层 20 万点，但没有范围统计 API；只能页面自己逐个遍历                                                               | `filterPointsInPolygon`（bbox 预筛）                    |
| 任意两点距离、折线长度、多边形面积  | 全仓无对外量算；`plotGeometry` 的 `destination/distanceBetween` 是标绘内部近似，不对外；`ringSignedArea` 算的是度²，不是米制面积 | `measureDistance` / `measurePathLength` / `measureArea` |
| 画完图形定位过去                    | `GisManager.fitBounds:2303` 要求调用方自己算好 `{west,east,south,north}`                                                         | `measureBBox`                                           |
| 导入 CGCS2000 / 高斯投影 / UTM 点位 | `points/importPlan.ts:20` 把 `coordinateSystem` 类型写死成 `'EPSG:4326'`，非 4326 直接拒绝                                       | CRS 转换（proj4）                                       |
| 环境数据清单声明非 4326 基准        | `environment/validation.ts:504` 对 `horizontalCrs !== 'EPSG:4326'` 直接返回 `INVALID_DATA`                                       | CRS 转换（proj4）                                       |
| 轨迹按形状抽稀（保留急转弯拐点）    | `TrackLayer.ts:328 selectTrackNodes` 是等步长抽样，不是按形状误差                                                                | `simplifyPath`                                          |
| 禁区外扩 N 米（缓冲区）             | 全仓无任何缓冲实现                                                                                                               | 缓冲区（P2，§3.3 三选一）                               |
| 最近接近点 / 偏离航线判断           | `simulation/CollisionAnalysis.ts:17` 是业务自有近似解法，不通用                                                                  | `nearestPointOnPath`                                    |
| 电子围栏精确求交、多区域合并/裁剪   | 全仓无叠加分析实现                                                                                                               | 叠加分析（P2）                                          |

其中"点在多边形内"是**性价比最高的补丁**：覆盖圈已经画在图上，只差一次判断就能从"可视"变成"可用"。CRS 转换是**现场适配的真实卡点**：国内测绘成果大多是高斯平面坐标或 CGCS2000，而不是经纬度。

### 2.2 SDK 现状：已有什么、缺什么

已可用（`docs/guide/capability-status.md` + 源码走查，当前版本 `0.1.0-alpha.10`）：

| 能力                   | 公开入口                                         | 与本案的关系                                                                                                                                                              |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 坐标转换（内部三换算） | `map.coordinates`（`src/cesium/coordinates.ts`） | 只有 WGS84 体系内的换算：`toWorld` / `toGeoPosition` / `toWindow` / `pickGeoPosition`。**没有 CRS 投影转换**（EPSG:4326 ↔ CGCS2000 / 高斯带 / UTM），这是本案要补的第一块 |
| 地形采样               | `map.terrain.sample()`                           | 批量高程、分批与并发上限、provider 级缓存、`AbortSignal`、无数据不伪造 0——通视/视域/坡度坡向的现成地基                                                                    |
| 渲染质量               | `map.quality`、`createMap({ quality })`          | 分析结果图层的渲染开销可沿用质量档（P2 再谈）                                                                                                                             |
| 错误契约               | `GisError`（`src/core/errors.ts`）               | `code` / `module` / `operation` 三段结构，新能力的错误码沿用该契约                                                                                                        |
| 数据管线               | `DataPipeline`、帧预算调度器                     | 批量分析结果回流的调度可复用（P2 讨论）                                                                                                                                   |

缺什么（`capability-status.md` 原文）：

> 空间分析 | 未发布 | 坐标转换与地形采样已可用；尚无 `map.analysis`、任务模型、结果图层或 Worker 执行接口

源码搜索确认：全仓库无 `measure` / `distance` / `area` / `buffer` / `intersect` / `point-in-polygon` / `convexHull` / `simplify` / `turf` / `proj4` 的实现或依赖；`dependencies` 目前只有 `cesium@1.144.0` 与 `@types/geojson`。

### 2.3 PRD 已规划的落点（对齐即可，不另起名字）

- PRD §6.1 模块职责：`Analysis | 统一执行分析工具 | 地形采样、异步取消、临时结果图层`
- PRD §8.2 顶层接口：`readonly analysis: AnalysisController`
- PRD §14.2 分析：统一通过工具 ID 和类型化输入输出执行：

  ```ts
  const result = await map.analysis.run(
    'line-of-sight',
    {
      start,
      end,
      includeTerrain: true,
    },
    { signal },
  );
  ```

  一期内置：空间距离、地表距离、面积、方位角；地形高度采样；两点通视；视域分析基础版；坡度/坡向基础版；坐标转换。

- PRD §15.1 插件类型：含 `Analysis Tool` 与 `Coordinate Transform`——第三方分析工具与自定义 CRS 走插件注册，本案只做内置工具与 CRS 注册表底座。

### 2.4 能力边界：SDK 提供计算与契约，应用做交互

- **SDK 只到"纯计算 API + 分析任务"为止**：不新增交互 UI、不做量算面板、不做页面级状态；地图点选量算、范围统计面板属于下游应用的交互层。
- **下游应用只做调用与渲染交互**：其 GIS 层的存量实现（标绘几何、耳切、ENU 等）不动、不迁移、不替换；SDK 新能力与它们并列存在，是否收敛由下游另行决定。
- 跨仓库替换暂不讨论：SDK 构建时 `external: ['cesium']`（由消费方提供），下游 `Plugin-web` 用全局脚本方式加载 Cesium（`core/loadCesium.ts`），两边 Cesium 来源不同，跨仓库替换会牵动两套生命周期管理。

## 3. 依赖选型与实测体积

### 3.1 体积总表

| 依赖                     | min      | **gzip**     | 传递依赖                | 用途                             |
| ------------------------ | -------- | ------------ | ----------------------- | -------------------------------- |
| `proj4@2.22.0`（全量）   | 126.6 KB | **41.4 KB**  | wkt-parser、mgrs        | 坐标参考系转换                   |
| turf 核心 11 子包        | 35.3 KB  | **12.0 KB**  | 仅 @turf 自家包         | 量算/判断/抽稀                   |
| `delaunator@5.1.0`       | 7.9 KB   | **3.0 KB**   | robust-predicates       | Delaunay / 凸包 / Voronoi 底座   |
| `earcut@3.0.2`           | 5.9 KB   | **2.4 KB**   | 无                      | 备用（见 §3.3）                  |
| `lil-gui@0.20.0`         | 30.4 KB  | **8.4 KB**   | 无                      | 开发期调试面板（不进依赖，§3.4） |
| `@turf/buffer` 单独      | 283.5 KB | **63.8 KB**  | **@turf/jsts + d3-geo** | 缓冲区（P2）                     |
| `@turf/intersect` 单独   | 42.4 KB  | **15.1 KB**  | **polyclip-ts**         | 叠加求交（P2）                   |
| `jsts@2.12.1` 预压缩整包 | 480.2 KB | **105.8 KB** | fastpriorityqueue       | 见 §3.3，**不可 tree-shake**     |

turf 核心集 = `boolean-point-in-polygon`(1.6) + `area`(0.8) + `length`(1.6) + `distance` + `along` + `bbox` + `center-of-mass` + `simplify`(2.5) + `rewind` + `points-within-polygon`(2.5) + `nearest-point-on-line` + `helpers`。判断类子包都在 1–3 KB gzip 量级，**按需引入完全成立**。

### 3.2 两条选型结论

**结论一：proj4 不要做"瘦身版"。** 实测过 `proj4/lib/core` + 手动注册 `longlat/merc/tmerc/utm`：瘦身版仍有 34.5 KB gzip，相比全量 41.4 KB **只省 6.9 KB**（`defs.js` 连带拉入 `projString`、`wkt-parser`、`Proj`），却要自己接线 `Proj`/`Point`/`defs`/`transform` 并手动注册投影，升级易碎。用全量包。

**结论二：Delaunator 与耳切（earcut）不是替代关系，是按输入形态分工的两个工具。**

- 耳切：处理"给定一个简单多边形，切成三角形"，用于填充与网格化。同类替换品是 **earcut**（2.4 KB gzip），更快更鲁棒。
- **Delaunator 是 Delaunay 三角化**，处理"给一堆散点，连成三角网"，输入输出都不同，**不能互换**。

两者可共存，不要互相冒充。下游 `Plugin-web` 的现状印证这一点：它的耳切是现役实现（水面网格、标绘自交校验），若将来 SDK 也需要耳切，引入的是 earcut 而非 Delaunator。

### 3.3 JSTS 专节：四条实测与三种引法

"复杂叠加分析用 JSTS 替换 Turf"这个说法要成立，**前提比想象中多三条**：

| 引法                             | 结果                                                                                                       | 结论                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 裸导入 `import jsts from 'jsts'` | 打包产物 **0.05 KB**（空模块）                                                                             | **包缺 `main`/`module`/`exports` 字段，裸导入是坏的**，必须走具体文件路径                                                                                  |
| `jsts/dist/jsts.min.js`          | 480.2 KB min / **105.8 KB gzip**                                                                           | 预压缩整包，**完全不可 tree-shake**；消费方若做 legacy 转译还要对 480 KB 压缩产物再过一遍 babel，构建变慢                                                  |
| ESM 源码路径 `jsts/org/...` 按需 | buffer **50.2 KB** gzip；buffer + 叠加 **59.6 KB** gzip（buffer 增量近乎免费）；几何构造 + IO 18.8 KB gzip | **唯一推荐路径**。实测跑通：`buffer(2)` 面积 192.49（=100+40×2+π×2²，正确）、两多边形求交面积 25.00（正确）                                                |
| ESM 源码 + DE-9IM 谓词           | **71.4 KB** gzip                                                                                           | 谓词（`intersects`/`contains`）是 **monkey-patch**，必须显式 `import 'jsts/org/locationtech/jts/monkey.js'` 才存在，否则**运行时才报 `is not a function`** |

**重复打包警告**：`@turf/buffer` 内嵌 264 KB 的 `@turf/jsts` 自包含构建。若同时引 `@turf/buffer` 与 `jsts`，两份 JSTS 血统一起进包（63.8 + 59.6 ≈ 123 KB gzip，其中一半是重复功能）。**两者只能选一个。**

P2 做缓冲区与叠加时，三选一（§9 待确认 4）：

| 方案                                                | gzip         | 取舍                                                                                                    |
| --------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| A. `@turf/buffer`                                   | 63.8 KB      | API 最简（GeoJSON 进 GeoJSON 出），但要接受与 jsts 不共享、以及跟 polyclip-ts 分家的现状                |
| B. **JSTS ESM 源码，一份覆盖 buffer + 叠加 + 谓词** | 59.6–71.4 KB | 体积最优、精度最高、一份依赖；代价是 Java 风格 API（先构造 Geometry）要包一层，且必须记得引 `monkey.js` |
| C. 自研局部 ENU 平面偏移                            | 0            | 零体积增量；但圆角、自交、退化 case 要自己兜，跨日期线不可靠                                            |

### 3.4 与 SDK 打包形态的适配

- **构建配置**（`tsup.config.ts`）：`format: ['esm', 'cjs']`、`target: es2022`、`splitting: false`、`external: ['cesium']`。**除 cesium 之外的依赖默认会被打进 dist**，所以"按需引子包"直接决定 SDK 包体积；`@turf/turf` 全量（≈78.5 KB gzip）一旦被引用就是全量进包，且 esm/cjs 双份。
- **动态 `import()` 的按需加载在当前构建下不成立**：`splitting: false` 时大依赖会内联进主 bundle，不产生独立 chunk。P2 的"大依赖按需加载"要么新增独立入口（如 `@yanbobo/gis-sdk/spatial`，见 §9 待确认 2），要么评估开启 splitting（仅 esm 有效，cjs 侧无法拆）。**该行为需在 P0 实测确认后再定方案。**
- **语法与运行时**：`target: es2022`，SDK 不承担消费方的 legacy 转换责任。turf 7.x 是 ESM + `sideEffects: false`；proj4 提供 cjs/umd 双形态；两者都不依赖 Node 专属 API，可在浏览器与 vitest（Node）下直接跑。
- **lil-gui 不进 `dependencies`**：库不带调试面板。若示例需要调参面板，放 `examples/` 的 devDependency 内动态加载；是否引入由示例需要决定，不阻塞本案。

### 3.5 P0 实测修正：依赖是 external，不会打进 dist（2026-09-29 补记）

§3.4 的前提需要修正。**tsup 默认把 `package.json` 的 `dependencies` 当作 external**，实测 `pnpm build` 后
`dist/core.js` 的首行就是 `import proj4 from 'proj4';` 与 `import along from '@turf/along';`——
turf 与 proj4 都**没有**被打进 dist，而是留给消费方的打包器解析。

SDK 自身包体积（gzip -9，基线与含 P0 的构建对比，基线为 `git worktree` 上的 HEAD）：

| 入口             | 基线     | 含 P0    | 增量         |
| ---------------- | -------- | -------- | ------------ |
| `dist/core.js`   | 6,160 B  | 10,791 B | **+4,631 B** |
| `dist/index.js`  | 25,963 B | 30,474 B | **+4,511 B** |
| `dist/cesium.js` | 22,646 B | 22,646 B | 0            |
| `dist/layers.js` | 454 B    | 454 B    | 0            |

即 SDK 侧的成本只有本仓库自己的代码（约 4.5 KB gzip），与 §3.1 的 53 KB 预测无关。

消费端成本（esbuild 打包 `dist/core.js`，`--external:cesium`，minify + gzip -9）：

| 探针                                                      | gzip        |
| --------------------------------------------------------- | ----------- |
| `import { measureDistance } from '@yanbobo/gis-sdk/core'` | 44,506 B    |
| 同上，但把 `proj4` 标记为 external                        | **1,418 B** |
| 仅 `import proj4 from 'proj4'`                            | 43,277 B    |

**结论：只要 CRS 模块与其余代码同处一个 chunk，任何从 `/core` 导入的消费方都会付出约 42 KB gzip 的 proj4，
即使完全不使用 CRS。** 原因是 `proj4` 的 `package.json` 没有声明 `sideEffects: false`，打包器必须保留其顶层副作用；
turf 一侧可忽略——`measureDistance` 的完整路径在去掉 proj4 后只有 **1.4 KB** gzip。

由此对 §9 待确认 2 的影响：入口选择不能只按"代码放哪边顺手"决定。可选做法：
(a) 把 `crs.ts` 单独出口（如 `@yanbobo/gis-sdk/crs`），`/core` 不静态引用 proj4；
(b) CRS 内部改用动态 `import('proj4')`，由消费方打包器拆成独立 chunk（代价是 `transform*` 变为异步）；
(c) 接受成本并在使用文档中写明。

P0 按已确认的"并入 `/core`"执行，并在 `docs/guide/spatial-analysis.md` 写明该成本；(a)/(b)/(c) 留待 P1/P2 拍板。

## 4. 算法清单（工具 → 算法 → 依赖 → 阶段）

| #   | 场景（下游驱动）           | 算法                | 依赖                                     | 阶段  | PRD 一期 |
| --- | -------------------------- | ------------------- | ---------------------------------------- | ----- | -------- |
| 1   | 目标是否在警戒区/覆盖圈    | 点在多边形内        | turf boolean-point-in-polygon            | P1    | 待确认 5 |
| 2   | 范围内目标统计             | 批量点 + bbox 预筛  | turf points-within-polygon               | P1    | 待确认 5 |
| 3   | 两点距离 / 折线长度        | 测地距离、路径长度  | turf distance / length                   | P1    | ✅       |
| 4   | 多边形面积                 | 球面面积            | turf area                                | P1    | ✅       |
| 5   | 方位角 / 目标点            | 方位角、destination | turf bearing / destination               | P1    | ✅       |
| 6   | 定位到标绘 / 点位集        | 包围盒、质心        | turf bbox / center-of-mass               | P1    | 待确认 5 |
| 7   | 两点通视                   | 地形采样 + 射线步进 | 现有 `map.terrain.sample()`              | P1    | ✅       |
| 8   | 视域分析基础版             | 视线球面扫描        | 现有地形采样 + 自研                      | P1/P2 | ✅       |
| 9   | 坡度/坡向基础版            | 邻域高程差          | 现有地形采样 + 自研                      | P1/P2 | ✅       |
| 10  | 导入 CGCS2000 / 高斯 / UTM | CRS 转换            | proj4                                    | P1    | ✅       |
| 11  | 轨迹抽稀                   | 按形状误差简化      | turf simplify                            | P2    | —        |
| 12  | 绘图合法性校验             | 多边形合法性        | turf boolean-valid（7.1 KB gzip）        | P2    | —        |
| 13  | 最近接近点 / 偏离航线      | 点到折线最近点      | turf nearest-point-on-line               | P2    | —        |
| 14  | 沿线等距取点               | 沿路径按距离取点    | turf along                               | P2    | —        |
| 15  | 目标群包围范围             | 凸包                | turf convex（6.3 KB gzip）               | P2    | —        |
| 16  | 覆盖划分 / 采样点建网      | Voronoi、TIN        | delaunator / turf voronoi（4.4 KB gzip） | P2    | —        |
| 17  | 禁区外扩 N 米              | 缓冲区              | 见 §3.3 三选一                           | P2    | —        |
| 18  | 电子围栏求交 / 区域合并    | 叠加分析            | JSTS 或 polyclip-ts                      | P2    | —        |

P0 全部为纯新增（`src/spatial/`），零公开行为变化；P1 起才挂 `map.analysis` 公开入口。

## 5. 契约设计（map.analysis）

### 5.1 顶层接口（对齐 PRD §8.2 / §14.2）

```ts
/** 内置分析工具 ID；插件注册的工具沿用同一命名规则。 */
export type AnalysisToolId =
  | 'distance'
  | 'surface-distance'
  | 'area'
  | 'bearing'
  | 'terrain-sample'
  | 'line-of-sight'
  | 'viewshed'
  | 'slope-aspect'
  | 'transform';

/** 类型化分析控制器。输入输出按工具 ID 窄化，取消走 AbortSignal。 */
export interface AnalysisController {
  /** 执行一个分析工具。 */
  run<T extends AnalysisToolId>(
    tool: T,
    input: AnalysisInputMap[T],
    options?: AnalysisRunOptions,
  ): Promise<AnalysisResultMap[T]>;
  /** 列出当前可用工具（内置 + 插件注册）。 */
  list(): readonly AnalysisToolDescriptor[];
}
```

`AnalysisInputMap` / `AnalysisResultMap` 是工具 ID 到输入/输出类型的映射表（P0 定稿时逐个写全）；`AnalysisRunOptions` 至少含 `signal?: AbortSignal`，与 `TerrainSampleOptions` 的取消语义保持一致。点面判断类（`point-in-polygon`、批量判断）是否进一期见 §9 待确认 5，若通过则一并加入上面的工具 ID 联合类型。

### 5.2 源码布局

```text
src/core/analysis.ts                契约：AnalysisController、工具输入输出类型、结果类型
src/spatial/                        纯计算层（零 Cesium，可单测、可 Worker）
  types.ts        GeoPoint / GeoRing / GeoPolygon / GeoBBox / 限额常量
  geojson.ts      内部转换：GeoPoint ↔ GeoJSON Position（不对外导出）
  crs.ts          proj4 封装：注册表 + 转换 + 高斯带
  measure.ts      量算：距离 / 长度 / 面积 / 方位 / 包围盒 / 质心 / 沿线取点 / 最近点
  predicate.ts    空间判断：包含 / 批量包含 / 合法性 / 绕向
  overlay.ts      派生几何：简化 / 凸包 / 缓冲区（P2）
  triangulate.ts  delaunator：Delaunay / TIN / Voronoi（P2）
src/cesium/analysis-controller.ts   Cesium 侧：地形采样接入、结果图层、取消（P1）
```

`src/spatial/**` 不 import `cesium`；`src/cesium/analysis-controller.ts` 依赖前者，反向不成立。纯计算层的出口走哪个入口见 §9 待确认 2。

### 5.3 约定

1. **输入输出统一用对象** `{ longitude, latitude, height? }`，与 SDK 现有 `GeoPosition`（`src/core/controls.ts`）同构、可直接互传，**不用 `[lng, lat]` 数组**。
2. **失败语义沿用 `GisError`**：非法输入抛 `INVALID_COORDINATES`（`coordinates.ts` 已有先例）；"没有结果"返回 `undefined`（不返回 0,0 之类伪值）；未注册 CRS 新增 `UNSUPPORTED_CRS` 错误码；异步取消走 `AbortSignal`（与 `map.terrain.sample()` 一致）。
3. **GeoJSON 只活在 `spatial/geojson.ts` 之内。** turf 只吃 GeoJSON，公开层不该看见它。坐标顺序转换与经纬范围断言都在这一层完成，**并用北半球 / 南半球 / 跨日期变更线样例在单测里锁死顺序**——经纬颠倒不会报错，只会静默算错，这是本层最危险的失效模式。
4. **纯函数、零 Cesium、零 DOM**：接收普通数据、返回普通数据 + `Float64Array`，为 P2 的 Worker 执行接口预留。
5. **注释按仓库规范**：所有导出接口、方法写中文 JSDoc（`/** ... */`，含 `@param` / `@returns`），与 `src/core/controls.ts` 的现有风格一致。
6. **算法版本号**：空间分析结果携带 `SPATIAL_ALGORITHM_VERSION = 1`，便于下游记录与回归对照。

### 5.4 方法表（`src/spatial/` 纯函数层）

**crs.ts —— 坐标参考系**

| 方法                                                                      | 说明                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `registerCrs(code, definition)`                                           | 注册一条 CRS（proj4 字符串或 WKT）；重复注册需显式覆盖            |
| `registerChinaCrs(options?)`                                              | 注册 CGCS2000 地理坐标 + 调用方指定号段的高斯带（**不预设全集**） |
| `listCrs()` / `describeCrs(code)`                                         | 列出已注册 / 返回中央经线、带号、单位、是否地理坐标               |
| `transformGeoPoint(point, from, to)`                                      | 单点转换；未注册 CRS 抛 `UNSUPPORTED_CRS`                         |
| `transformGeoPath(points, from, to)` / `transformGeoRing(ring, from, to)` | 批量转换（导入预览用）                                            |

**measure.ts —— 量算**

| 方法                                                                         | 说明                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `measureDistance(from, to, options?)`                                        | 返回 `{ meters }`；`options.units` 支持米/公里/海里 |
| `measurePathLength(points)`                                                  | 折线总长                                            |
| `measureArea(ring)`                                                          | 球面面积，返回 `{ squareMeters, squareKilometers }` |
| `measureBearing(from, to)` / `measureDestination(origin, bearing, distance)` | 方位角 / 目标点                                     |
| `measureBBox(input)`                                                         | `{ west, east, south, north }`，可直接喂相机飞行    |
| `measureCenterOfMass(input)`                                                 | 质心点                                              |
| `pointAlongPath(points, distanceMeters)`                                     | 沿线等距取点                                        |
| `nearestPointOnPath(points, target)`                                         | `{ point, index, distanceMeters, alongMeters }`     |

**predicate.ts —— 空间判断**

| 方法                                               | 说明                                           |
| -------------------------------------------------- | ---------------------------------------------- |
| `isPointInPolygon(point, polygon, options?)`       | 支持外环 + 内环（洞）、边界点归属可配          |
| `filterPointsInPolygon(points, polygon, options?)` | 命中索引 + 命中点 + 计数；万级点位走 bbox 预筛 |
| `isPolygonValid(ring, options?)`                   | `{ valid, reason }`，自交给出可读原因          |
| `normalizeRingWinding(ring, direction)`            | 环绕向规范化                                   |

**overlay.ts / triangulate.ts —— 派生几何（P2）**

`simplifyPath`、`buildConvexHull`、`buildGeoBuffer`、`buildDelaunay`、`buildTin`、`buildVoronoi`。

### 5.5 下游对接（示意）

```ts
import { createMap } from '@yanbobo/gis-sdk';

const map = await createMap({ container: 'map', basemap: { type: 'xyz', url } });

/** 距离量算：SDK 给纯计算结果，交互由应用自己做 */
const { meters } = await map.analysis.run('distance', { from, to });

/** 告警区判断：下游拿到布尔结果后自行驱动业务 UI */
const hit = await map.analysis.run('point-in-polygon', { point, polygon });

/** CRS 转换：注册表在 SDK 侧维护，下游只声明号段 */
await map.analysis.run('transform', {
  point: gaussPoint,
  from: 'CGCS2000-GK-3D-117E',
  to: 'EPSG:4490',
});
```

页面级量算面板、点选交互、结果标注样式都留在下游应用；SDK 不接管这些。

## 6. 分阶段实施

### P0：纯计算层 + 契约定稿（零公开行为变化）

1. 依赖：`pnpm add proj4@^2.22.0 @turf/boolean-point-in-polygon @turf/area @turf/length @turf/distance @turf/bearing @turf/destination @turf/along @turf/bbox @turf/center-of-mass @turf/helpers`
2. 新建 `src/spatial/`（`types` / `geojson` / `crs` / `measure` / `predicate`）
3. `src/core/analysis.ts` 契约定稿（`AnalysisController` + 类型映射），**先不挂到 `GisMap`**
4. `tests/`：已知点对回归、南北半球/跨日期变更线、CRS 往返残差、边界与退化输入、错误码
5. 实测确认 §3.4 的动态 import 分包行为，定 P2 的入口方案

退出条件：`pnpm typecheck`、`pnpm lint`、`pnpm test` 全绿；`pnpm build` 后核对新增 gzip 体积与 §3.1 同量级；`pnpm pack:check` 通过。

### P1：公开 `map.analysis`（PRD 一期工具）

1. `src/cesium/analysis-controller.ts` + `GisMap.analysis`（PRD §8.2）
2. 工具：`distance` / `surface-distance` / `area` / `bearing` / `terrain-sample`（接现有地形采样）/ `line-of-sight` / `transform`；点面判断类是否同期见 §9 待确认 5
3. 文档与发布（按 `capability-status.md` 的 6 步规范）：`docs/guide/analysis.md`、`guide/api-reference` 增补、能力状态表改行、README 能力表同步、Changeset + `CHANGELOG.md`、发布 npm alpha
4. 下游接入验证：`examples/vanilla` 可跑；`Plugin-web` 用 alpha 包验证两条真实卡点（CGCS2000 点位导入、告警区判断）

退出条件：上述发布规范齐备；示例与下游集成验证无回退。

### P2：缓冲区 / 叠加 / Worker / 结果图层

1. 缓冲区与叠加按 §3.3 三选一落地
2. Worker 执行接口：批量点在多边形内、长轨迹抽稀、缓冲区等重计算挪进 Worker（Transferable `Float64Array` 模式）——对应能力状态表里"Worker 执行接口"的半句
3. 分析结果图层：缓冲面、视域面等结果以受管图层呈现（PRD §6.1"临时结果图层"）
4. 视域/坡度坡向基础版若未在 P1 完成，在此收口

## 7. 不做清单

| 不做                                   | 理由                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 引入全量 `@turf/turf`                  | 会把 buffer/jsts/d3-geo 一次性拖进主 chunk（≈78.5 KB gzip），且除 cesium 外依赖全部进包                                |
| 同时引入 `@turf/buffer` 与 `jsts`      | 两份 JSTS 血统重复打包（§3.3）                                                                                         |
| 按"用 JSTS 全面替换 turf"的路线做      | 判断类子包 1–3 KB gzip 已足够，JSTS 只在叠加与缓冲场景才有优势，且要用对引法                                           |
| 引入 rayshon 或类似 Cesium 增强库      | SDK 自身是封装层，叠一层增强库等于两套对象与资源生命周期；其 PBF 能力在本项目群没有数据源                              |
| 把 GeoJSON 泄漏到公开 API              | 公开层继续只用 `GeoPosition` 与 SDK 自有类型                                                                           |
| lil-gui 进 `dependencies`              | 库不带调试面板；示例需要时放 devDependency                                                                             |
| 承诺厘米级基准转换                     | CGCS2000 与 WGS84 在现有业务尺度按恒等处理；厘米级需要七参数或格网改正（`nadgrids` + `.gsb` 资产），会引入外部资产依赖 |
| P0/P1 改动 `GisMap` 之外的既有成员签名 | 顶层接口加 `analysis` 是 PRD 既有规划；其余既有成员不动                                                                |
| 在 SDK 内做交互（量算面板、点选工具）  | 属下游应用层；SDK 只到纯计算与分析任务为止                                                                             |

## 8. 验证方案

### 8.1 单测（`tests/`，vitest）

- 已知点对回归：北京 / 赤道 / 南半球 / 跨日期变更线 / 高纬（|lat| > 80°）；**南半球样例专用于抓经纬颠倒**。
- CRS 往返一致性：`A→B→A` 残差断言；每个用到的 EPSG 号写一条带权威基准值的用例（§8.3）。
- 边界与退化输入：空数组、单点、重复点、未闭合环、自交环、非法坐标、未注册 CRS 码——断言抛出 `GisError` 且错误码正确，或返回 `undefined`。
- 若走 JSTS 路径：额外断言 `monkey.js` 已生效（谓词存在），防止运行时才炸。

### 8.2 与独立实现交叉验证

用与 turf 无关的第二实现做对照，给出量化容差而不是"看起来对"：

- Cesium 的 `EllipsoidGeodesic`、`Transforms.eastNorthUpToFixedFrame`（SDK 直接依赖 cesium，可作为参照实现）；
- 注意：仓库现有测试对 `cesium` 是 `vi.mock`（见 `tests/coordinates.test.ts`），交叉验证需要**独立测试文件直连真实 Cesium 数学模块**；纯数学类在 Node 下可用，但**该做法需在 P0 先实测确认**（vitest 环境、Cesium 导入开销）。
- proj4 高斯投影与 UTM 的同点对照（§8.3 已有一条实测记录）。

### 8.3 CRS 核对要求

**高斯带号与中央经线必须逐条核对，不许按模式猜。** 3 度带中央经线 = 3n，`x_0` 分"不带带号 500000"与"带带号 n×1000000+500000"两套，对应两组 EPSG 号段。proj4 内置定义只有 WGS84 / NAD83 / Web Mercator / 法国 Lambert 等少数几条，**没有 CGCS2000、没有中国高斯带**，必须自行注册。已实测可行：

```js
proj4.defs('EPSG:4490', '+proj=longlat +ellps=GRS80 +no_defs');
// 下方 code 为示意用的自定义键；正式落地时换成核对过的 EPSG 号，中央经线与 x_0 一并照抄注册表
proj4.defs(
  'CGCS2000-GK-3D-117E',
  '+proj=tmerc +lat_0=0 +lon_0=117 +k=1 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs',
);
proj4('EPSG:4490', 'CGCS2000-GK-3D-117E', [116.39, 39.9]); // → 447833.66, 4418603.79
proj4('CGCS2000-GK-3D-117E', 'EPSG:4490', [447833.66, 4418603.79]); // → 116.39, 39.9（回算精确）
```

（示意值已交叉验证：同点 UTM zone 50 为 447854.5, 4416836.4，与高斯 3 度带结果接近而不相等，差异来自比例因子与椭球，符合预期。）

落库时以 EPSG 注册表 / GB/T 22021 为准，并把每个用到的号写进单测基准值。CGCS2000 与 WGS84 在现有业务尺度按恒等处理——这是显示尺度的工程取舍，不是测地学结论。

### 8.4 体积测量复现

```bash
mkdir -p /tmp/geo-size && cd /tmp/geo-size && npm init -y
npm i proj4 delaunator earcut lil-gui jsts @turf/buffer @turf/intersect @turf/area @turf/length
echo "import f from 'proj4'; export const g = f" > e.js
node_modules/.bin/rolldown e.js -o o.js --format esm --minify
gzip -9 -c o.js | wc -c
```

JSTS 按需引入（唯一推荐路径）：

```js
import BufferOp from 'jsts/org/locationtech/jts/operation/buffer/BufferOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
import WKTReader from 'jsts/org/locationtech/jts/io/WKTReader.js';
import 'jsts/org/locationtech/jts/monkey.js'; // 不引则 intersects/contains 运行时才报错
```

### 8.5 打包与发布门禁

- `pnpm build`：核对新增依赖的 gzip 增量与 §3.1 同量级；超限即视为引入方式回退（例如误引了 `@turf/turf` 或整包 jsts）。
- `pnpm pack:check`（publint + attw）：新依赖不得改变 `exports` 契约与类型解析（含 cjs/esm 双出口）。
- `pnpm docs:build`：文档站可构建。
- 发布按 `docs/guide/capability-status.md` 的 6 步规范执行；未完成不得把"空间分析"改为"可用"。

## 9. 待确认项

编码前需要拍板 6 件事：

1. **契约时点**：P0 是否直接定 `map.analysis` 契约（推荐，PRD §14.2 已规划），还是先只落纯函数、契约后置？
2. **纯计算层出口**：走现有 `/core` 子路径，还是新增 `@yanbobo/gis-sdk/spatial`（要动 tsup entry 与 `exports`）；同时决定 P2 大依赖的按需加载方案（§3.4）。
3. **依赖引入范围**：turf 核心一次引齐（12.0 KB gzip），还是先只引 P0 用到的子包？
4. **缓冲区/叠加引法**：§3.3 的 A（turf buffer，63.8 KB）/ B（JSTS 源码，59.6–71.4 KB，一份覆盖三类，**推荐**）/ C（自研局部平面偏移，0 体积但边界不可靠）？
5. **点面判断是否进一期**：`point-in-polygon`、批量判断、bbox/质心不在 PRD 一期清单里，但需求强度最高（§2.1 前两行），是否随 P1 一起发布？
6. **视域/坡度坡向排期**：PRD 一期清单含这两项，但计算量与地形采样依赖较重；放 P1 还是 P2（需与能力状态表口径同步）？
