# API 使用参考

这里按“你现在要做什么”分类，而不是按源码文件排列。每个页面都包含可复制的最小示例、参数、返回值、运行效果和异常边界；完整 TypeScript 签名见[类型索引](/api/)。

## 先选场景

| 目标                                   | 阅读页面                                    | 你会获得什么                                                    |
| -------------------------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| 创建地图、监听事件、调整尺寸、释放资源 | [地图生命周期](./map-lifecycle.md)          | `createMap`、`resize`、`destroy`、`state`、`events`             |
| 添加、查询、移除或清空图层             | [图层管理](./layer-management.md)           | `map.layers.add/get/list/remove/clear`、通用 `LayerHandle`      |
| 加载或替换业务要素数据                 | [GeoJSON 图层](./geojson-layer.md)          | GeoJSON 对象/URL、样式、`setData`、取消加载                     |
| 接入 WMS、TMS、WMTS 或单张配准影像     | [影像图层](./imagery-layers.md)             | 样式、CQL 过滤、透明度、瓦片/单图参数与释放                     |
| 加载城市/倾斜摄影等 3D Tiles           | [3D Tiles 图层](./tiles3d-layer.md)         | 加载、显隐、基础 LOD、取消和释放                                |
| 放置单个 glTF / GLB 模型               | [静态模型图层](./model-layer.md)            | 位置/朝向、颜色叠加、外观策略、就地变换与并发加载限制           |
| 批量渲染点位或导入 CSV                 | [点位图层](./points-layer.md)               | `type: 'points'`、`setData()`、`parseCsv()`、`readPointCsv()`   |
| 设置 XYZ 底图、相机、地形或采样高程    | [地图控制](./map-controls.md)               | `map.basemap`、`map.camera`、`map.terrain`、`sample()`          |
| 经纬度、世界坐标与屏幕坐标互转         | [坐标转换](./coordinates.md)                | `map.coordinates` 的四个转换方法及返回值语义                    |
| 调分辨率、地形精度或按帧率自动降档     | [渲染质量](./quality.md)                    | `map.quality`、`createMap({ quality })`、内置质量档             |
| 量算距离面积、判断点在区内、转换坐标系 | [空间计算与坐标转换](./spatial-analysis.md) | `measure*`、`isPointInPolygon`、`transformGeoPoint`、CRS 注册表 |
| 消化高频业务消息                       | [实时数据导航](./data-pipeline.md)          | 有界队列、Worker/MessagePort 输入、帧预算调度                   |
| 判断和处理失败                         | [错误与原生出口](./errors-and-native.md)    | `GisError`、错误码、`map.raw.viewer` 的边界                     |

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

当前 alpha 包已发布地图生命周期、GeoJSON、WMS、TMS、WMTS、单图影像、3D Tiles、静态模型、点位图层、XYZ 底图、相机、地形与地形采样、地图坐标转换、渲染质量、空间计算（量算 / 判断 / CRS 转换）、CSV 解析、数据管线。动态实体、CZML、Worker 池、大数据渲染器、绘制、材质和空间分析尚未提供稳定 SDK 方法；准确状态以[功能状态与路线图](./capability-status.md)为准。
