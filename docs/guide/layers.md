# 图层使用导航

图层文档已按图层类型拆分，避免在一个页面混合要素、影像与三维瓦片参数。请从下面选择当前任务。

| 你要做什么                 | 页面                                | 主要方法                               |
| -------------------------- | ----------------------------------- | -------------------------------------- |
| 添加、查询、移除或清空图层 | [图层管理](./layer-management.md)   | `map.layers.add/get/list/remove/clear` |
| 加载或整体替换业务要素     | [GeoJSON 图层](./geojson-layer.md)  | `type: 'geojson'`、`setData()`         |
| 接入 WMS、TMS 或 WMTS 服务 | [影像图层](./imagery-layers.md)     | `type: 'wms' \| 'tms' \| 'wmts'`       |
| 加载城市模型、倾斜摄影等   | [3D Tiles 图层](./tiles3d-layer.md) | `type: '3d-tiles'`                     |

所有类型都使用 `map.layers.add()`，但返回的句柄能力不同：GeoJSON 返回 `GeoJsonLayerHandle`，WMS 返回 `WmsLayerHandle`，TMS/WMTS 返回 `ImageryLayerHandle`，3D Tiles 返回通用 `LayerHandle`。

图层由 SDK 管理资源所有权。不要直接移除 SDK 创建的 Cesium `dataSources`、`imageryLayers` 或 `scene.primitives` 项目；高级原生接入边界见[错误与原生出口](./errors-and-native.md)。
