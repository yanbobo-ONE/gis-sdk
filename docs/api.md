# 公开接口

完整签名、参数、返回值、异常和源码链接由 TypeDoc 从 `src/index.ts` 自动生成：

[打开 API Reference](/api/)

## 当前入口

| 接口                   | 用途                | 稳定性    |
| ---------------------- | ------------------- | --------- |
| `createMap(options)`   | 创建 Cesium 地图    | pre-alpha |
| `GisMap` / `CesiumMap` | 地图实例与生命周期  | pre-alpha |
| `EventHub`             | 类型化事件订阅      | pre-alpha |
| `GisError`             | 结构化错误处理      | pre-alpha |
| `map.raw.viewer`       | Cesium 原生高级能力 | advanced  |

包根不会导出 `MapRuntime`、`MapEngineAdapter`、`createMapWithFactory` 或归一化辅助函数。业务代码只应依赖本页列出的稳定出口。
