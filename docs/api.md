# TypeScript 类型索引

具体调用方式、参数含义和运行效果请先阅读 [API 使用参考](/guide/api-reference)。完整签名和源码链接由 TypeDoc 从公开入口自动生成：

[打开 API Reference](/api/)

## 当前入口

| 接口                         | 用途                                                  | 稳定性     |
| ---------------------------- | ----------------------------------------------------- | ---------- |
| `createMap(options)`         | 创建 Cesium 地图                                      | alpha 可用 |
| `GisMap` / `CesiumMap`       | 地图实例与生命周期                                    | alpha 可用 |
| `EventHub`                   | 类型化事件订阅                                        | alpha 可用 |
| `GisError`                   | 结构化错误处理                                        | alpha 可用 |
| `map.layers`                 | GeoJSON、WMS、TMS、WMTS、单图影像与 3D Tiles 图层     | alpha 可用 |
| `map.camera`                 | 类型化视角、飞行和取消                                | alpha 可用 |
| `map.basemap`                | XYZ 底图、透明度和显隐                                | alpha 可用 |
| `map.terrain`                | 椭球 / Cesium Terrain 地形                            | alpha 可用 |
| `DataPipeline`               | 有界更新、同键合并、批量读取和统计                    | alpha 可用 |
| `DataPipelineMessageAdapter` | Worker / MessagePort 消息监听、业务解码转发和输入统计 | alpha 可用 |
| `DataPipelineFrameScheduler` | 动画帧请求合并、每帧有界批量消费、取消和统计          | alpha 可用 |
| `wmsFilter`                  | 类型化 CQL 过滤                                       | alpha 可用 |
| `map.raw.viewer`             | Cesium 原生高级能力                                   | advanced   |

包根不会导出 `MapRuntime`、`MapEngineAdapter`、`createMapWithFactory` 或归一化辅助函数。业务代码只应依赖本页列出的稳定出口。

未发布能力及后续完成记录见[功能状态与路线图](/guide/capability-status)。
