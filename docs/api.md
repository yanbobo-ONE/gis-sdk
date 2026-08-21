# TypeScript 类型索引

具体调用方式、参数含义和运行效果请先阅读 [API 使用参考](/guide/api-reference)。完整签名和源码链接由 TypeDoc 从公开入口自动生成：

[打开 API Reference](/api/)

## 当前入口

| 接口                   | 用途                | 稳定性    |
| ---------------------- | ------------------- | --------- |
| `createMap(options)`   | 创建 Cesium 地图    | pre-alpha |
| `GisMap` / `CesiumMap` | 地图实例与生命周期  | pre-alpha |
| `EventHub`             | 类型化事件订阅      | pre-alpha |
| `GisError`             | 结构化错误处理      | pre-alpha |
| `map.layers`           | GeoJSON 与 WMS 图层 | pre-alpha |
| `wmsFilter`            | 类型化 CQL 过滤     | pre-alpha |
| `map.raw.viewer`       | Cesium 原生高级能力 | advanced  |

包根不会导出 `MapRuntime`、`MapEngineAdapter`、`createMapWithFactory` 或归一化辅助函数。业务代码只应依赖本页列出的稳定出口。
