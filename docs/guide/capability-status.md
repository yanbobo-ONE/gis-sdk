# 功能状态与路线图

本页是当前公开能力的唯一完整状态表。`可用` 表示已在当前 alpha 包中导出、具备测试覆盖并有使用文档；`未发布` 表示代码和 npm 包均没有可调用的稳定接口。alpha 阶段的已发布接口仍可能在后续预发布版本中调整。

## 当前可用能力

| 模块                | 状态 | 公开入口                                                               | 已验证的效果                                                      |
| ------------------- | ---- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 地图运行时          | 可用 | `createMap()`、`map.resize()`、`map.destroy()`、`map.state`            | 创建 Viewer、响应容器尺寸变化、并发幂等销毁与销毁状态保护         |
| 事件与错误          | 可用 | `map.events`、`EventHub`、`GisError`                                   | 订阅 `map:error` / `map:destroy`，按稳定错误码处理失败            |
| 图层生命周期        | 可用 | `map.layers.add/get/list/remove/clear`                                 | 图层 ID 预留、加载取消、资源释放和状态快照                        |
| GeoJSON             | 可用 | `type: 'geojson'`、`setData()`                                         | URL 或对象加载、基础样式、取消加载和原子数据替换                  |
| WMS / GeoServer     | 可用 | `type: 'wms'`、`setOpacity()`、`setStyle()`、`setFilter()`、`reload()` | 加入影像图层并运行时更新透明度、样式、CQL 过滤或 Provider         |
| 3D Tiles            | 可用 | `type: '3d-tiles'`                                                     | 加载标准 Tileset、显隐、基础 LOD 配置、取消后的延迟资源清理和释放 |
| 相机控制            | 可用 | `map.camera.setView()`、`flyTo()`、`cancelFlight()`                    | 使用度和米定位、飞行、取消和生命周期保护                          |
| XYZ 底图            | 可用 | `createMap({ basemap })`、`map.basemap`                                | 单底图原子替换、透明度与显隐，始终位于业务影像图层下方            |
| 地形                | 可用 | `map.terrain.set()`                                                    | 椭球切换和 Cesium Terrain 异步加载，失败时保留旧地形              |
| 数据管线核心        | 可用 | `DataPipeline`（包根或 `/core`）                                       | 有界队列、同键最新值合并、溢出策略、批量读取和统计快照            |
| 消息输入适配器      | 可用 | `DataPipelineMessageAdapter`（包根或 `/core`）                         | Worker / MessagePort 监听、业务解码转发、拒绝/丢弃统计与监听释放  |
| 帧预算调度器        | 可用 | `DataPipelineFrameScheduler`（包根或 `/core`）                         | 动画帧请求合并、每帧有界消费、自动续帧、取消、失败事件与统计      |
| Cesium 公共原生访问 | 可用 | `map.raw.viewer`                                                       | 调用 Cesium 文档中的公共成员；资源归业务代码所有                  |
| 按需导入            | 可用 | `/core`、`/cesium`、`/layers`、`/styles.css`                           | 将核心工具、Cesium 创建入口和图层工具拆分为独立子路径             |

完整调用代码见 [API 使用参考](/guide/api-reference)，子路径选择与包体积边界见[导入与包体积](/guide/imports)。

## 未发布能力

| 模块                            | 当前状态 | 在完成前的边界                                                         |
| ------------------------------- | -------- | ---------------------------------------------------------------------- |
| TMS、WMTS、单图与企业影像服务   | 未发布   | 当前只封装 XYZ；可临时使用 `map.raw.viewer`，资源由业务清理            |
| glTF / 3D 模型、CZML、动态实体  | 未发布   | 没有 SDK 图层类型、加载策略或生命周期承诺                              |
| Worker 池与专用动态输入 Adapter | 未发布   | 尚无 Worker 池、WebSocket/SSE/CZML/二进制协议适配、校验和标准化        |
| 海量数据渲染                    | 未发布   | 尚无动态渲染器、Primitive / Collection 批处理、自动 LOD 或基准数据承诺 |
| 绘制与编辑                      | 未发布   | 尚无 `map.drawing`、编辑状态、捕捉或交互事件 API                       |
| 自定义材质与效果                | 未发布   | 尚无材质注册、着色器、特效或版本兼容策略                               |
| 空间分析                        | 未发布   | 尚无 `map.analysis`、任务模型、结果图层或 Worker 执行接口              |
| 插件、诊断和框架绑定            | 未发布   | 尚无插件协议、监控/诊断 API 或官方 Vue / React 组件                    |
| 多浏览器性能验证                | 未完成   | 尚未建立真实 WebGL 端到端矩阵、性能阈值和公开压测结果                  |
| 旧项目迁移适配                  | 未完成   | 尚未提供兼容层；接入以当前公开 SDK 契约为准                            |

未发布不代表不重要，而是不能以“已支持”对外承诺。业务若临时通过原生 Cesium API 接入，必须自行管理对象所有权、资源销毁和 Cesium 升级兼容性。

## 后续完成时如何更新

每项能力完成并准备对外发布时，维护者必须在同一次变更中完成以下事项：

1. 实现公开契约并补充单元、集成或发布包验证；
2. 将本页对应行从“未发布”改为“可用”，写明首次发布版本、实际公开入口和已验证效果；
3. 在 [API 使用参考](/guide/api-reference)新增参数表、返回值、异常、运行效果和可复制示例；
4. 需要时同步 [README](https://github.com/yanbobo-ONE/gis-sdk#readme) 的能力表，保证 npm 包页面与本站一致；
5. 增加 Changeset、更新 `CHANGELOG.md`，并发布新的 npm alpha 版本。

没有完成以上文档和发布项的实现，不得把状态改为“可用”。
