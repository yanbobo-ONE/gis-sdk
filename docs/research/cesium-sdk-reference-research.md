# Cesium SDK 文档体系参考研究

- 查询日期：2026-08-17
- 研究目的：为 HGD GIS 独立 SDK 的 PRD 提供文档信息架构、API 页面规范、版本策略和工具选型依据。
- 资料范围：Mars3D、CesiumJS、TypeDoc、VitePress 的官方文档与官方源码。

## 1. 结论摘要

1. Mars3D 最值得借鉴的不是某一个 API 页面，而是“开发指南 + 类型化 API + 可运行示例 + 项目模板 + 更新日志”的完整开发者路径。其开发者中心明确把 SDK、功能示例、项目模板和 API 文档作为配套交付物，并提供 400 多个功能示例。[Mars3D 开发者中心](https://mars3d.cn/docs/)、[平台整体介绍](https://mars3d.cn/docs/guide/)
2. API 文档必须从 SDK 的 TypeScript 公共导出自动生成，源码中的局部函数、私有字段和内部实现不得进入用户 API。用户给出的 [`addAttribute`](http://mars3d.cn/api/cesium/global.html#addAttribute) 页面正好是反例：页面只有函数名和源码链接；对应 Cesium 1.142 源码表明它是 `VertexArray.js` 内部的局部辅助函数，并不是公共导出。[Cesium 1.142 `VertexArray.js`](https://github.com/CesiumGS/cesium/blob/1.142/packages/engine/Source/Renderer/VertexArray.js#L19)
3. Mars3D 与 Cesium 不是平行的两套 API。Mars3D 在 Cesium 上提供一致化封装，同时保留 `mars3d.Cesium.*` 原生访问入口；它还使用经过修改的 `mars3d-cesium` 核心依赖。因此其文档同时链接 Mars3D API 和 Cesium API。[Mars3D 基础类说明](https://mars3d.cn/docs/basis/base/)、[`mars3d-cesium` 库介绍](https://mars3d.cn/docs/advanced/mars3d-cesium/)
4. HGD SDK 可以借鉴这种“双层文档”，但不建议 fork 或修改 Cesium 源码作为默认架构。应将自有稳定接口作为主要文档，将 Cesium 原生对象作为明确标注的高级逃生口，并公布 SDK 与 Cesium 的兼容矩阵。
5. 文档工具建议采用“TypeDoc 生成 API + VitePress 承载指南、示例和版本文档”。TypeDoc 能从 TypeScript 导出生成类型、继承、源码链接、导航和版本信息，并可排除 internal/private/未文档化符号；VitePress 适合 Markdown 技术内容、交互式 Vue 示例、静态部署和全文导航。[TypeDoc 配置能力](https://typedoc.org/documents/Overview.html)、[VitePress 官方介绍](https://vitepress.dev/guide/what-is-vitepress)

## 2. 用户给出的 `addAttribute` 页面说明

目标页面为 [Global - Cesium Documentation / `addAttribute`](http://mars3d.cn/api/cesium/global.html#addAttribute)，不是 Mars3D 自有业务 API 页面。

页面观察：

- 页面标题是 `Global - Cesium Documentation`，顶部提供“查阅 Mars3D API”的反向链接。
- 该站当前镜像的是 Cesium 1.142；`addAttribute` 的源码链接指向 Cesium 1.142 的 `packages/engine/Source/Renderer/VertexArray.js`。
- 页面仅显示 `addAttribute()` 和源码位置，没有说明、参数、返回值、示例、稳定性或可用入口。
- 实际源码签名为 `function addAttribute(attributes, attribute, index, context)`，它是文件内函数，不是 Cesium 模块的公共导出。[Cesium 1.142 源码](https://github.com/CesiumGS/cesium/blob/1.142/packages/engine/Source/Renderer/VertexArray.js#L19)

对 PRD 的直接启示：

- 可借鉴：锚点直达、源码行跳转、类型链接、统一的属性/方法页面布局、与底层 Cesium 文档互链。
- 不应照搬：把构建工具扫描到的所有符号都发布为 API。
- 文档生成入口必须是包的 `public exports`，而不是整个 `src` 目录。
- CI 必须阻止未说明的公共导出，同时禁止 `@internal`、私有字段和未导出的局部函数进入站点。
- API 页面必须显示稳定性标签：`stable`、`beta`、`experimental`、`deprecated`；`internal` 只在内部开发文档中出现。

## 3. Mars3D 文档信息架构

### 3.1 开发者学习路径

Mars3D 的资料不是只有 API 索引，而是按以下路径组织：[Mars3D 开发者中心](https://mars3d.cn/docs/)、[平台整体介绍](https://mars3d.cn/docs/guide/)

1. 平台与 SDK 介绍。
2. 安装、环境配置和快速上手。
3. 基础概念与进阶扩展。
4. 数据处理与常见问题。
5. API 文档。
6. 在线功能示例及源码。
7. 不同技术栈的项目模板。
8. 版本更新日志。

这种结构解决了三种不同诉求：

- 新人找“第一张地图怎么跑起来”。
- 业务开发者按功能找“图层、标绘、材质、分析怎么调用”。
- SDK 扩展开发者查“继承关系、底层类型和扩展入口”。

### 3.2 API 导航

[Mars3D API 首页](http://mars3d.cn/api/) 当前显示 SDK 版本 `V3.11.4`，提供按类名过滤的入口。类名使用命名空间表达领域边界，例如：

- `mars3d.Map`
- `mars3d.layer.*`
- `mars3d.graphic.*`
- `mars3d.control.*`
- `mars3d.effect.*`
- `mars3d.thing.*`
- `mars3d.query.*`
- `*Util` 工具类与常量枚举

API 首页本身更接近“全量符号索引”；[API 文档引导](https://mars3d.cn/docs/guide/api/) 再按地图核心类、基础类、枚举、图层、矢量对象、特效、分析等业务类别组织，并把类名映射到功能示例。这个“自动索引 + 人工任务导航”的组合比单一类列表更易用。

### 3.3 单个 API 页面的信息

以 [`mars3d.Map`](http://mars3d.cn/api/Map.html)、[`GraphicLayer`](http://mars3d.cn/api/GraphicLayer.html)、[`BaseClass`](http://mars3d.cn/api/BaseClass.html) 和 [`MaterialType`](http://mars3d.cn/api/MaterialType.html) 为例，页面包含：

- 完整命名空间和构造签名。
- 简短职责说明。
- 源文件及行号。
- 参数名称、类型、是否可选、默认值和描述。
- `options` 的嵌套属性表。
- 属性的只读、静态、常量等修饰信息。
- 方法参数与返回类型。
- 使用示例。
- `See also` 关联项。
- 继承自哪个基类。
- 支持的事件类型入口。
- 对 Cesium 原生类型的链接和顶部“查阅 Cesium API”入口。

`GraphicLayer#addGraphic` 还体现了实用的调用文档：同时说明接收对象、数组和配置对象，并说明返回添加后的 `Graphic`。[`GraphicLayer#addGraphic`](http://mars3d.cn/api/GraphicLayer.html#addGraphic)

### 3.4 事件与继承

Mars3D 将 `BaseClass` 作为多数 SDK 类的事件基类，公开 `on`、`off`、`once`、`fire`、事件传播和销毁等统一方法。[`BaseClass`](http://mars3d.cn/api/BaseClass.html)

具体类页会显示：

- `继承自` 区块。
- 类级 `EventType`。
- 构造说明中的“支持的事件类型”链接。

对 HGD SDK 的启示是：事件不应散落为不同类的任意字符串。应定义类型化事件映射，并在每个类页自动列出事件名、payload 类型、触发时机、是否冒泡、取消订阅方式和销毁行为。

### 3.5 示例体系

Mars3D 将 API 与功能示例分开：API 负责精确契约，示例负责可运行流程。官方示例项目支持单功能页面、源码查看和实时编辑；Vue、React、原生 JS 版本可复用同一地图逻辑。[Vue 版功能示例说明](https://mars3d.cn/docs/guide/example-vue/)、[开源仓库清单](https://mars3d.cn/docs/guide/open/)

值得借鉴的连接方式：

- 指南中的功能表提供“类名 -> 功能示例”。
- API 页提供最小代码示例。
- 在线示例提供完整上下文、资源、交互和源码。
- 项目模板解决工程接入，而不是让用户自己拼构建配置。

### 3.6 材质文档

[`MaterialType`](http://mars3d.cn/api/MaterialType.html) 将材质做成稳定枚举，并为每种材质列出参数属性、类型和示例。这种方式比让业务代码直接传任意 GLSL 字符串更适合团队复用。

HGD SDK 文档应把材质分成三层：

1. 内置材质目录：类型、效果预览、适用 Graphic/Primitive、参数、默认值和性能等级。
2. 自定义材质扩展协议：注册、schema、uniform、生命周期、资源释放和兼容要求。
3. Cesium 原生 `Material`/`MaterialProperty`/`CustomShader` 高级入口：明确不属于 SDK 稳定兼容承诺。

Mars3D 的进阶文档也单列了自定义矢量对象、自定义材质、自定义矢量图层和自定义瓦片图层，说明扩展点需要教程，而不能只给类型定义。[Mars3D 自定义材质](https://mars3d.cn/docs/advanced/plugins/material/)、[自定义矢量图层](https://mars3d.cn/docs/advanced/plugins/graphic-layer/)

### 3.7 版本呈现

Mars3D API 在页面标题和页脚展示自身版本；当前查询结果为 `V3.11.4`。[Mars3D API 首页](http://mars3d.cn/api/)

[Mars3D 更新日志](https://mars3d.cn/docs/guide/change/) 按版本区分新增、优化、修复、弃用/API 重构，并记录底层 `mars3d-cesium` 的升级版本。这一点对 Cesium SDK 尤其重要，因为底层 Cesium 的异步工厂方法、事件和私有接口会随版本变化。

HGD 文档应固定展示：

- SDK 版本。
- 构建所针对的 Cesium 版本或兼容范围。
- 文档对应的 Git commit/tag。
- 发布日期。
- 稳定性状态。
- 历史版本切换器。
- 迁移指南和弃用移除版本。

## 4. Mars3D API 与 Cesium API 的关系

官方资料给出的关系是：

- Mars3D 对 Cesium 类做一致性封装，统一 API 风格，并统一处理部分事件和调度。[Mars3D 基础类](https://mars3d.cn/docs/basis/base/)
- `mars3d` 的安装依赖中包含 `mars3d-cesium` 和 `@turf/turf`。[Mars3D 开发者中心](https://mars3d.cn/docs/)
- `mars3d-cesium` 是 Mars3D 的核心依赖；官方说明其修改了部分 Cesium 源码，原则是主要扩展留在 Mars3D 类库，只有无法外部扩展时才改 Cesium，并尽量通过参数控制行为。[`mars3d-cesium` 库介绍](https://mars3d.cn/docs/advanced/mars3d-cesium/)
- 用户仍可通过 `mars3d.Cesium.*` 使用 Cesium 原生类。[`mars3d-cesium` 库介绍](https://mars3d.cn/docs/advanced/mars3d-cesium/)
- Mars3D 的 `Map` 等类公开属性会直接返回 `Cesium.Viewer`、`Cesium.Camera`、`Cesium.Clock`、`Cesium.DataSourceCollection` 等原生对象。[`mars3d.Map`](http://mars3d.cn/api/Map.html)
- Mars3D 官方将 `Map / Layer / Graphic / Thing / Control / Effect` 等封装对象与 Cesium 原生对象的对应关系单独成文，进一步说明“高层统一接口 + 原生对象逃生口”是其有意设计。[Mars3D 与 Cesium 的关系](https://mars3d.cn/docs/advanced/cesium/)

因此，Mars3D 的“封装”不是完全屏蔽 Cesium，而是：

```text
业务功能 API（Map / Layer / Graphic / Thing）
        ↓
统一事件、配置、生命周期和工具层
        ↓
mars3d-cesium（经调整的 Cesium）
        ↓
WebGL / 浏览器
```

给 HGD SDK 的建议：

- 主路径只依赖 SDK 的稳定接口，业务层不要直接依赖 Cesium 私有字段。
- 通过 `map.native` 或独立 `@hgd-gis/cesium-adapter` 暴露原生对象，并标记为高级 API。
- 原生访问只保证“返回当前 Cesium 对象”，不承诺跨 Cesium 大版本保持行为一致。
- 优先使用 Adapter 和公开扩展点，不修改 Cesium 源码；确需补丁时必须维护补丁清单、上游 issue、回归测试和退出计划。
- API 文档中同时链接 HGD 抽象和对应 Cesium 官方类型，但不能把 Cesium 全量文档复制成 HGD 自有 API。

## 5. Cesium 官方 API 文档可借鉴点

[CesiumJS API 索引](https://cesium.com/learn/cesiumjs/ref-doc/) 将公共类型按 `packages/engine` 和 `packages/widgets` 分组，提供搜索并按类/函数直达。

Cesium 官方整体学习路径是“[教程与 Quickstart](https://cesium.com/learn/cesiumjs-learn/) -> [Sandcastle 可运行示例](https://sandcastle.cesium.com/) -> [API Reference](https://cesium.com/learn/cesiumjs/ref-doc/) -> [CHANGES](https://github.com/CesiumGS/cesium/blob/main/CHANGES.md)”。这与 Mars3D 的分层方式一致：教程、示例、精确契约和版本变化分别维护。

[`Cesium.Model`](https://cesium.com/learn/cesiumjs/ref-doc/Model.html) 页面体现了较完整的 API 契约：

- 明确构造器是 `internal`，并指示用户使用 `Model.fromGltfAsync`。
- 说明类型职责、支持的 glTF 扩展、Demo 和关联 API。
- 属性包含类型、默认值、只读状态、实验性标记、限制条件、示例和源码链接。
- 事件作为 `Event` 类型属性呈现，并说明触发条件和 listener 参数。
- 方法包含参数、嵌套 options、默认值、返回 Promise 类型和资源就绪语义。

Cesium 官方文档规范要求：

- 所有函数参数都要有文档；可选参数要说明默认值。
- `options` 的每个属性分别记录。
- 返回值和异常单独记录。
- 示例要简洁但有足够上下文；官方指南指出开发者通常先看示例。
- 私有成员不生成公共文档；没有公共文档注释的标识符不应出现。
- JSDoc 同时用于生成官方 TypeScript 类型定义。[Cesium Documentation Guide](https://github.com/CesiumGS/cesium/blob/1.142/Documentation/Contributors/DocumentationGuide/README.md)

这些规则比用户给出的 `addAttribute` 镜像页更适合作为 HGD API 页面验收基准。

### 5.1 当前版本与 1.140-1.144 的升级信号

截至查询日 2026-08-17，CesiumGS 官方 GitHub Releases 的最新稳定版是 **CesiumJS 1.144**，发布日期为 2026-08-03；1.143 是 2026-07-01 的上一个版本。因此 Mars3D `/api/cesium` 当前展示的 1.142 只是它所绑定的 Cesium 文档镜像，不能当作 Cesium 当前最新版。[CesiumJS 1.144 Release](https://github.com/CesiumGS/cesium/releases/tag/1.144)、[CesiumJS Releases](https://github.com/CesiumGS/cesium/releases)

对 SDK 设计直接相关的近期变化：

- 1.140 新增实验性的 `BufferPointCollection`、`BufferPolylineCollection`、`BufferPolygonCollection`，定位是高性能矢量 Primitive API；同一版本还提高了 billboard/label 的图形能力要求，并只增加了将 `OffscreenCanvas` 作为影像类型传入的能力。[Cesium `CHANGES.md`](https://github.com/CesiumGS/cesium/blob/1.144/CHANGES.md)
- 1.141 将 CesiumJS 的最低 Node.js 要求提升到 22，并对 `BufferPrimitiveCollection` 的部分属性做了 breaking change。[Cesium `CHANGES.md`](https://github.com/CesiumGS/cesium/blob/1.144/CHANGES.md)
- 1.142 再次修改 Buffer 集合的 `boundingVolume` 语义为世界坐标，并增加预计算包围体、透明混合、`GeoJsonPrimitive` 和 MVT/3D Tiles 等能力。[CesiumJS 1.142 Release](https://github.com/CesiumGS/cesium/releases/tag/1.142)、[Cesium `CHANGES.md`](https://github.com/CesiumGS/cesium/blob/1.144/CHANGES.md)
- 1.144 增强了经地形贴合的海量分块矢量线面渲染、逐要素样式以及 CAD 模型能力。[CesiumJS 1.144 Release](https://github.com/CesiumGS/cesium/releases/tag/1.144)

`BufferPrimitiveCollection` 官方页面仍明确标记为 Experimental，可能不遵循 Cesium 标准弃用策略；其文档同时要求使用 flyweight 模式避免为 N 个图元分配 N 组 JS 对象。[`BufferPrimitiveCollection`](https://cesium.com/learn/cesiumjs/ref-doc/BufferPrimitiveCollection.html)

对 PRD 的约束：

- 第一版稳定公共接口不能直接等同于 Buffer 集合的当前 Cesium 签名；应放在 `experimental` 能力包或内部 renderer adapter 后面。
- SDK 发布必须锁定并记录 Cesium 版本，持续跑升级测试，不能用 `^` 自动吸收未经验证的 Cesium breaking change。
- Node 22 是构建、开发和文档工具链基线，不等同于浏览器运行时要求；浏览器兼容性要单独定义和验证。
- 兼容矩阵必须区分 SDK、Cesium、Node、浏览器/WebGL、框架适配器五个维度。

### 5.2 Entity/DataSource 与 Primitive/Model 的职责分层

Cesium 官方把渲染 API 明确分成两类：Entity 是数据驱动可视化的高层 API，Primitive 是面向图形开发的低层 API。[Creating Entities](https://cesium.com/learn/cesiumjs-learn/cesiumjs-creating-entities/)

- `Entity` 聚合 position、orientation、billboard、label、model、polyline、polygon 等多种可视化，并支持时间属性和 `definitionChanged`，适合业务对象、交互编辑和中小规模动态数据。[`Entity`](https://cesium.com/learn/cesiumjs/ref-doc/Entity.html)
- `CustomDataSource` 用于手工管理一组 Entity，提供 loading/error/changed 事件、时钟和聚合配置，适合按业务图层隔离 Entity 生命周期。[`CustomDataSource`](https://cesium.com/learn/cesiumjs/ref-doc/CustomDataSource.html)
- 批量改 Entity 时，官方建议用 `EntityCollection.suspendEvents()`/`resumeEvents()` 将大量修改合成一次通知，但这只是降低 Entity 管理开销，不会把 Entity 自动变成真正的 GPU 批处理格式。[Creating Entities](https://cesium.com/learn/cesiumjs-learn/cesiumjs-creating-entities/)
- `Primitive` 将多个 `GeometryInstance` 与 `Appearance`/`Material` 解耦；官方明确说明将多个实例合为一个 Primitive 的 batching 能显著改善静态数据性能，并仍可逐实例拾取。[`Primitive`](https://cesium.com/learn/cesiumjs/ref-doc/Primitive.html)
- `PointPrimitiveCollection` 和 `BillboardCollection` 建议采用“少量 collection、每个包含大量对象”，并按更新频率分组；频繁逐条增删会重写顶点缓冲，临时隐藏通常优于移除再添加。[`PointPrimitiveCollection`](https://cesium.com/learn/cesiumjs/ref-doc/PointPrimitiveCollection.html)、[`BillboardCollection`](https://cesium.com/learn/cesiumjs/ref-doc/BillboardCollection.html)
- `Model` 是直接加载 glTF 的 Scene Primitive，当前必须通过 `Model.fromGltfAsync` 创建，适合需要直接模型矩阵、动画、拾取、shader 和资源生命周期控制的场景；它比 Entity/`ModelGraphics` 更低层，但“每个目标一个 Model”本身不等于海量数据方案。[`Model`](https://cesium.com/learn/cesiumjs/ref-doc/Model.html)

SDK 不应让业务方直接决定 Cesium 后端，而应由 renderer policy 根据数据规模、更新频率、交互需求和数据格式选择 Entity、Collection、Primitive、Model 或 3D Tiles，并允许高级用户显式覆盖。

### 5.3 大数据主路径：集合批处理与 3D Tiles

3D Tiles 规范的目标就是流式传输海量、异构的三维地理数据。其核心是空间层级、包围体、HLOD、几何误差和屏幕空间误差，运行时只选择当前视图所需的瓦片。[3D Tiles Specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc)

CesiumJS 的 `Cesium3DTileset` 提供 `maximumScreenSpaceError`、`cacheBytes`、`maximumCacheOverflowBytes`、视锥/移动请求裁剪、foveated SSE 和加载进度等公开调优点；屏幕空间误差越大通常性能越好、视觉质量越低。[`Cesium3DTileset`](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)

因此 SDK 的大数据策略至少要区分：

| 数据形态 | 推荐主路径 | 说明 |
| --- | --- | --- |
| 少量、强交互、复杂时间属性 | Entity/DataSource | 优先开发效率、编辑和语义 |
| 大量同类点、图标、简单动态对象 | Point/Billboard/Buffer collection | 合批、按更新频率分组；Buffer API 先标实验性 |
| 大量静态同构几何 | batched Primitive/GeometryInstance | 控制 draw call、拾取和材质 |
| 单体精细 glTF、少量动态模型 | Model | 直接模型矩阵、动画和 shader |
| 城市、倾斜摄影、BIM/CAD、点云、超大模型/矢量 | 3D Tiles | 离线分块、HLOD、按视域流式加载 |

“支持大数据量”不能只写一个数量口号。PRD 还必须定义数据预处理/切片、可视范围、更新频率、显存/内存预算、屏幕空间误差、最大待处理队列、丢弃/合并策略和基准数据集。

### 5.4 `requestRenderMode` 的正确边界

`Scene.requestRenderMode` 在场景变化时才渲染，并要求未被自动检测的变化调用 `Scene.requestRender()`；`maximumRenderTimeChange` 决定时间变化何时触发渲染。[`Scene`](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html)

Cesium 官方性能文章显示它主要降低**空闲场景**的 CPU 使用；相机移动、资源加载、动态数据持续更新时仍会产生帧。它不是实时海量数据的批处理或降采样替代品。[Improving Performance with Explicit Rendering](https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/)

SDK 应由统一 render scheduler 管理 `requestRender()`，图层、材质、Worker 回传和交互模块只提交 dirty reason，避免每个模块自行启动 render loop 或遗漏刷新。

### 5.5 Worker 与 OffscreenCanvas 边界

Cesium 的 `TaskProcessor` 是 Web Worker 包装器，支持 transferable objects，并用 `maximumActiveTasks` 限制并发；达到上限时 `scheduleTask` 返回 `undefined`，这正是明确背压而不是无限排队的官方示例。[`TaskProcessor`](https://cesium.com/learn/cesiumjs/ref-doc/TaskProcessor.html)

但 `Viewer` 构造器明确要求 DOM `Element|string`，并持有 `HTMLCanvasElement`；Cesium 1.140 的 OffscreenCanvas 变更仅说明它可作为影像输入类型，不能据此宣称官方支持在应用 Worker 中运行完整 Viewer。[`Viewer`](https://cesium.com/learn/cesiumjs/ref-doc/Viewer.html)、[Cesium `CHANGES.md`](https://github.com/CesiumGS/cesium/blob/1.144/CHANGES.md)

因此当前可审慎确认的 SDK 边界是：

- Worker：协议解析、校验、坐标归一化、排序、去重、抽稀、聚合、网格生成、队列合并和 transferable buffer。
- 主线程：Viewer/Scene 生命周期、Cesium 对象创建与变更、拾取、相机和 WebGL 渲染。
- 这不是“数据管线 = Web Worker”；Worker 只是接入、归一化、状态、调度和渲染整条管线中的计算执行器。

### 5.6 材质、自定义 Shader 与稳定性

Cesium `Material` 通过 Fabric JSON 组合 diffuse、specular、normal、emission、alpha 等材质分量，并可声明 uniforms 或 GLSL source；这是 Primitive/Appearance 层的材质机制。[`Material`](https://cesium.com/learn/cesiumjs/ref-doc/Material.html)

`CustomShader` 可作用于 `Model` 和 `Cesium3DTileset`，支持 uniforms、varyings、vertex/fragment shader，并要求调用方正确销毁 GPU 资源；但官方仍将其标为 Experimental，而且与 `Cesium3DTileStyle` 同时使用可能产生未定义行为。[`CustomShader`](https://cesium.com/learn/cesiumjs/ref-doc/CustomShader.html)、[`Model`](https://cesium.com/learn/cesiumjs/ref-doc/Model.html)

SDK 材质系统应把 Cesium 实现隐藏在稳定的 `MaterialDefinition`/`MaterialInstance` 接口后：内置材质稳定、自定义材质注册 beta、原生 GLSL/CustomShader 入口 experimental。每个材质都要声明支持的 renderer、uniform schema、透明度、时间依赖、资源释放、WebGL 要求和 Cesium 兼容范围。

### 5.7 版本升级、弃用与私有 API

Cesium 官方 `CHANGES.md` 按版本列出 Breaking Changes、Deprecated、Additions 和 Fixes，是升级审计的主要依据。[Cesium `CHANGES.md`](https://github.com/CesiumGS/cesium/blob/1.144/CHANGES.md)

典型迁移包括：`createWorldTerrain` 改为 `createWorldTerrainAsync`、`Model.fromGltf` 改为 `Model.fromGltfAsync`、`Cesium3DTileset` 构造/`readyPromise` 改为 `Cesium3DTileset.fromUrl` 等；这些旧 API 在 1.104 弃用并计划于 1.107 移除。[Cesium `CHANGES.md`](https://github.com/CesiumGS/cesium/blob/1.144/CHANGES.md)、[`Model`](https://cesium.com/learn/cesiumjs/ref-doc/Model.html)

SDK 的升级策略应包含：

1. 只依赖 Cesium public API，禁止 `_root`、`_materialCache` 等私有字段进入稳定实现。
2. `@hgd-gis/cesium-adapter` 单独承担版本差异，自有 core/contracts 不导入 Cesium 类型。
3. 每次升级逐版本阅读 `CHANGES.md`，扫描 deprecated/private 用法，运行类型、单元、浏览器、视觉和性能基准。
4. Cesium 实验性能力必须被能力检测和 feature flag 隔离，文档同步显示风险。
5. 对业务只发布 HGD SDK 的迁移指南，不要求每个项目分别处理 Cesium breaking changes。

### 5.8 包与类型基础

CesiumJS 从 1.100 起同时发布 `cesium`、`@cesium/engine`、`@cesium/widgets`，使用 ES modules 并提供官方 TypeScript definitions；生产构建推荐从模块入口导入以便 tree shaking，而不是依赖全局 `Cesium`。[Cesium `CHANGES.md`](https://github.com/CesiumGS/cesium/blob/1.144/CHANGES.md)、[Cesium Build Guide](https://github.com/CesiumGS/cesium/blob/main/Documentation/Contributors/BuildGuide/README.md)

这支持 HGD SDK 采用 TypeScript public contracts、按包拆分和 ESM-first 发行；如需兼容遗留项目，再额外发布受限的 UMD/IIFE compatibility bundle，而不是让全局变量成为核心架构。

## 6. TypeDoc 与 VitePress 工具建议

### 6.1 TypeDoc 负责 API 真相

TypeDoc 应从每个 npm package 的公共 TypeScript entry point 生成 API。官方配置支持：[TypeDoc Overview](https://typedoc.org/documents/Overview.html)

- 排除 external、internal、private、protected 和未文档化符号。
- 生成继承层级摘要。
- 将 package 版本加入项目名。
- 配置导航、分组、排序和跨包链接。
- 通过外部符号映射把 `Cesium.Model` 等类型直接链接到 Cesium 官方 API，避免复制底层文档。
- 自动生成 Git 源码链接，并固定 Git revision。
- 同时输出 HTML 和结构化 JSON。
- 对缺失文档、无效链接和类型问题执行验证，并可把警告视为错误。

TypeDoc 支持 TSDoc/JSDoc 标签、Markdown 代码块和语法高亮；`@example` 会生成示例，`@event` 可把成员归入 Events 分组。[Doc Comments](https://typedoc.org/documents/Doc_Comments.html)、[`@example`](https://typedoc.org/documents/Tags._example.html)、[`@event`](https://typedoc.org/documents/Tags._event.html)

外部类型映射、导航/搜索和校验均有官方配置入口。[TypeDoc Comments options](https://typedoc.org/documents/Options.Comments.html)、[Output options](https://typedoc.org/documents/Options.Output.html)、[Validation options](https://typedoc.org/documents/Options.Validation.html)

推荐做法：API 的签名、参数、返回值、继承和源码链接只从代码生成，不在手写 Markdown 中复制维护。

### 6.2 VitePress 负责学习与任务文档

VitePress 是面向内容的静态站点生成器，使用 Markdown 生成静态 HTML，并在加载后提供 SPA 导航。其默认主题面向技术文档，支持全文导航、代码高亮、Frontmatter、多语言和在 Markdown 中嵌入 Vue 交互组件。[VitePress 官方介绍](https://vitepress.dev/guide/what-is-vitepress)

官方默认主题提供顶部导航、分组侧边栏和本地/Algolia 搜索；Markdown 支持从真实源码导入代码片段和代码组，Vue 增强 Markdown 可承载交互式 Cesium Demo。[导航](https://vitepress.dev/reference/default-theme-nav)、[侧边栏](https://vitepress.dev/reference/default-theme-sidebar)、[搜索](https://vitepress.dev/reference/default-theme-search)、[Markdown 扩展](https://vitepress.dev/guide/markdown)、[在 Markdown 中使用 Vue](https://vitepress.dev/guide/using-vue)

适合承载：

- 快速上手和概念教程。
- 框架集成指南。
- 可运行 Cesium 地图 Demo。
- 性能指南和大数据决策表。
- 插件、材质和自定义渲染扩展教程。
- 迁移指南、兼容矩阵和更新日志。

推荐组合：

```text
TypeScript 源码 + TSDoc
        │
        ├── TypeDoc HTML/JSON -> /api
        │
        └── VitePress Markdown + 交互示例 -> /guide /examples /cookbook
                                      │
                                      └── 同一版本、同一域名、双向导航
```

### 6.3 推荐的发布拓扑

不依赖社区插件的稳妥基线是让 VitePress 与 TypeDoc 各自构建，在同一版本目录下并列发布：

```text
/v1.0/guide/      VitePress
/v1.0/examples/   VitePress
/v1.0/api/        TypeDoc
/latest/          重定向到当前稳定版本
/versions.json    版本、发布日期、Cesium 范围、commit、状态
```

TypeDoc 用 `includeVersion` 显示 package 版本，用 `gitRevision` 固定源码链接，并通过 `navigationLinks` 返回指南和示例；VitePress 用 nav/sidebar/outline 组织任务文档，并增加读取 `versions.json` 的版本切换组件。[TypeDoc Input options](https://typedoc.org/documents/Options.Input.html)、[TypeDoc Output options](https://typedoc.org/documents/Options.Output.html)、[VitePress Default Theme Config](https://vitepress.dev/reference/default-theme-config.html)

两套工具默认各有自己的导航和搜索，不会自动形成跨站统一搜索。第一阶段可分别搜索并互链；需要全站检索时，再用 VitePress 官方支持的 Algolia DocSearch 对 `/guide`、`/examples`、`/api` 一并建索引。[VitePress Search](https://vitepress.dev/reference/default-theme-search)

VitePress 官方文档没有提供开箱即用的 SDK 多版本发布方案，因此历史版本应由 CI/CD 的不可变目录和 `versions.json` 管理，不能把“版本切换”误写成 VitePress 默认能力。

## 7. 建议写入 PRD 的文档信息架构

```text
开发者中心
├── 开始使用
│   ├── 安装
│   ├── 5 分钟创建地图
│   ├── 静态/CDN 接入
│   └── Vue / React / 原生 JS 集成
├── 核心概念
│   ├── Map / Scene / Camera
│   ├── Layer / Graphic / Overlay
│   ├── Entity / Primitive / 3D Tiles 选型
│   ├── 坐标系与时间
│   └── 生命周期和资源释放
├── 数据管线
│   ├── 数据接入与类型化协议
│   ├── Worker、批处理、背压和抽稀
│   ├── LOD、聚合和分块
│   └── 性能预算与监控
├── 功能指南
│   ├── 图层与数据源
│   ├── 标绘与编辑
│   ├── 模型与轨迹
│   ├── 材质与特效
│   ├── 空间分析
│   └── 交互与控件
├── 扩展 SDK
│   ├── 自定义 Layer / Graphic
│   ├── 自定义 Material / Shader
│   ├── 数据适配器
│   ├── 渲染后端适配器
│   └── Cesium 原生逃生口
├── API Reference
│   ├── Core
│   ├── Map
│   ├── Layers
│   ├── Graphics
│   ├── Pipeline
│   ├── Materials
│   ├── Analysis
│   ├── Interaction
│   ├── Adapters
│   └── Diagnostics
├── Examples
├── 性能手册
├── 兼容矩阵
├── 迁移指南
├── 更新日志
└── 常见问题
```

## 8. 单个 API 页面最低字段规范

每个 class/function/type/event 页面至少包含：

| 字段 | 要求 |
| --- | --- |
| 完整名称 | 包名、命名空间、导入路径 |
| 状态 | stable / beta / experimental / deprecated |
| Since | 首次发布版本 |
| 职责 | 一句话说明解决什么问题 |
| 签名 | TypeScript 完整签名与泛型 |
| 参数 | 类型、是否可选、默认值、单位、坐标系、边界条件 |
| 返回值 | 类型、Promise 就绪时机、是否可取消 |
| 错误 | 错误码/异常类型、触发条件、恢复方式 |
| 生命周期 | 创建、挂载、更新、移除、销毁和资源释放 |
| 线程 | main thread / worker；是否可传输、是否支持批量 |
| 性能 | 推荐规模、复杂度、批处理方式、已知上限 |
| 事件 | payload 类型、时机、频率、取消订阅 |
| 继承/实现 | 基类、接口、实现类与替代方案 |
| 示例 | 最小可复制 TS 示例 + 在线运行示例 |
| 关联项 | 指南、示例、相关 API、对应 Cesium 类型 |
| 源码 | 固定到当前 Git tag/commit 的文件和行号 |
| 兼容性 | 支持的 Cesium、浏览器、WebGL、框架适配器版本 |

对于大数据 API，还必须增加：

- 单次/持续数据量建议。
- 内存与 GPU 资源估算方式。
- Entity、Primitive collection、instance、3D Tiles 等后端选择。
- 更新频率、合批、背压、降级和丢帧策略。
- Worker 输入输出 schema 和 transferable 使用说明。

## 9. 文档验收标准建议

1. `100%` 公共导出有 API 页面，`0` 个 internal/private/local 符号进入公共 API。
2. `100%` 公共方法记录参数、返回值、异常或错误结果、生命周期。
3. `100%` 事件有类型化 payload 和取消订阅示例。
4. 所有示例在 CI 中编译；核心示例执行浏览器 smoke test。
5. 文档构建对断链、未解析类型、未文档化公共导出和失效源码链接失败。
6. 每次 SDK 发布同时发布同版本文档、兼容矩阵、Changelog 和迁移说明。
7. 文档首页始终显示 SDK 版本、Cesium 兼容范围和构建 commit。
8. 每个核心能力至少有“API 最小示例 + 可运行完整示例 + 一篇任务指南”。
9. 在线示例不得依赖业务项目的后端、登录态或全局变量；示例资源必须可替换并说明来源。
10. 每次发布生成不可变版本快照，例如 `/v1.2/docs/`、`/v1.2/api/`，另以 `/latest/` 指向当前稳定版；旧项目可切换到其锁定版本查阅。

## 10. 研究资料索引

- [Mars3D 开发者中心](https://mars3d.cn/docs/)
- [Mars3D 平台整体介绍](https://mars3d.cn/docs/guide/)
- [Mars3D API 文档引导](https://mars3d.cn/docs/guide/api/)
- [Mars3D API 首页](http://mars3d.cn/api/)
- [Mars3D `Map` API](http://mars3d.cn/api/Map.html)
- [Mars3D `GraphicLayer` API](http://mars3d.cn/api/GraphicLayer.html)
- [Mars3D `BaseClass` API](http://mars3d.cn/api/BaseClass.html)
- [Mars3D `MaterialType` API](http://mars3d.cn/api/MaterialType.html)
- [Mars3D Vue 功能示例说明](https://mars3d.cn/docs/guide/example-vue/)
- [Mars3D 版本更新日志](https://mars3d.cn/docs/guide/change/)
- [`mars3d-cesium` 库介绍](https://mars3d.cn/docs/advanced/mars3d-cesium/)
- [CesiumJS 1.144 Release](https://github.com/CesiumGS/cesium/releases/tag/1.144)
- [CesiumJS 1.142 Release](https://github.com/CesiumGS/cesium/releases/tag/1.142)
- [CesiumJS `CHANGES.md`](https://github.com/CesiumGS/cesium/blob/1.144/CHANGES.md)
- [CesiumJS API Reference](https://cesium.com/learn/cesiumjs/ref-doc/)
- [CesiumJS Creating Entities](https://cesium.com/learn/cesiumjs-learn/cesiumjs-creating-entities/)
- [CesiumJS `Primitive`](https://cesium.com/learn/cesiumjs/ref-doc/Primitive.html)
- [CesiumJS `Model` API](https://cesium.com/learn/cesiumjs/ref-doc/Model.html)
- [CesiumJS `Cesium3DTileset`](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html)
- [3D Tiles Specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc)
- [CesiumJS `Scene`](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html)
- [CesiumJS `TaskProcessor`](https://cesium.com/learn/cesiumjs/ref-doc/TaskProcessor.html)
- [CesiumJS `Material`](https://cesium.com/learn/cesiumjs/ref-doc/Material.html)
- [CesiumJS `CustomShader`](https://cesium.com/learn/cesiumjs/ref-doc/CustomShader.html)
- [CesiumJS Build Guide](https://github.com/CesiumGS/cesium/blob/main/Documentation/Contributors/BuildGuide/README.md)
- [Cesium Documentation Guide](https://github.com/CesiumGS/cesium/blob/1.142/Documentation/Contributors/DocumentationGuide/README.md)
- [TypeDoc Overview](https://typedoc.org/documents/Overview.html)
- [TypeDoc Doc Comments](https://typedoc.org/documents/Doc_Comments.html)
- [TypeDoc Input Options](https://typedoc.org/documents/Options.Input.html)
- [TypeDoc Output Options](https://typedoc.org/documents/Options.Output.html)
- [VitePress 官方介绍](https://vitepress.dev/guide/what-is-vitepress)
- [VitePress 默认主题配置](https://vitepress.dev/reference/default-theme-config.html)
- [VitePress 搜索](https://vitepress.dev/reference/default-theme-search)
- [VitePress Markdown 扩展](https://vitepress.dev/guide/markdown)
