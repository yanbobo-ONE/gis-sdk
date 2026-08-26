# API 使用参考

这里按“你现在要做什么”分类，而不是按源码文件排列。每个页面都包含可复制的最小示例、参数、返回值、运行效果和异常边界；完整 TypeScript 签名见[类型索引](/api/)。

## 先选场景

| 目标                                   | 阅读页面                                 | 你会获得什么                                               |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| 创建地图、监听事件、调整尺寸、释放资源 | [地图生命周期](./map-lifecycle.md)       | `createMap`、`resize`、`destroy`、`state`、`events`        |
| 添加、查询、移除或清空图层             | [图层管理](./layer-management.md)        | `map.layers.add/get/list/remove/clear`、通用 `LayerHandle` |
| 加载或替换业务要素数据                 | [GeoJSON 图层](./geojson-layer.md)       | GeoJSON 对象/URL、样式、`setData`、取消加载                |
| 接入 WMS、TMS、WMTS 或单张配准影像     | [影像图层](./imagery-layers.md)          | 样式、CQL 过滤、透明度、瓦片/单图参数与释放                |
| 加载城市/倾斜摄影等 3D Tiles           | [3D Tiles 图层](./tiles3d-layer.md)      | 加载、显隐、基础 LOD、取消和释放                           |
| 设置 XYZ 底图、相机或地形              | [地图控制](./map-controls.md)            | `map.basemap`、`map.camera`、`map.terrain`                 |
| 消化高频业务消息                       | [实时数据导航](./data-pipeline.md)       | 有界队列、Worker/MessagePort 输入、帧预算调度              |
| 判断和处理失败                         | [错误与原生出口](./errors-and-native.md) | `GisError`、错误码、`map.raw.viewer` 的边界                |

## 统一调用规则

所有地图功能都从 `createMap()` 返回的 `map` 调用；图层从 `map.layers.add()` 返回的句柄调用。SDK 负责自己创建的 Cesium 资源，业务通过 `map.raw.viewer` 创建的原生对象仍由业务负责释放。

```ts
import { createMap } from '@yanbobo/gis-sdk/cesium';
import '@yanbobo/gis-sdk/styles.css';

const map = createMap({ container: 'map', cesiumBaseUrl: '/cesium/' });
const layer = await map.layers.add({
  id: 'areas',
  type: 'geojson',
  data: '/data/areas.geojson',
});

layer.setVisible(false);
await map.destroy();
```

## 已发布范围

当前 alpha 包已发布地图生命周期、GeoJSON、WMS、TMS、WMTS、单图影像、3D Tiles、XYZ 底图、相机、地形与数据管线。模型、动态实体、Worker 池、大数据渲染器、绘制、材质和空间分析尚未提供稳定 SDK 方法；准确状态以[功能状态与路线图](./capability-status.md)为准。
