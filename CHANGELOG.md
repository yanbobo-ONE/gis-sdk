# Changelog

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
