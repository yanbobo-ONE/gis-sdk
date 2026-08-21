# 导入与包体积

SDK 同时提供便捷根入口和三个功能子路径。现代构建器通常可以对根入口做 tree-shaking；需要严格控制依赖图时，使用子路径入口。

## 推荐导入方式

```ts
// 创建 Cesium 地图
import { createMap } from '@yanbobo/gis-sdk/cesium';

// 图层类型和 WMS 过滤器
import { wmsFilter } from '@yanbobo/gis-sdk/layers';
import type {
  GeoJsonLayerSpec,
  ImageryLayerHandle,
  TmsLayerSpec,
  WmsLayerHandle,
  WmtsLayerSpec,
} from '@yanbobo/gis-sdk/layers';

// 不依赖具体地图引擎的事件和错误
import { EventHub, GisError } from '@yanbobo/gis-sdk/core';

// Cesium Widget 样式始终单独引入
import '@yanbobo/gis-sdk/styles.css';
```

## 子路径职责

| 入口                          | 导出内容                                      | 适合场景                                   |
| ----------------------------- | --------------------------------------------- | ------------------------------------------ |
| `@yanbobo/gis-sdk`            | 全部稳定接口                                  | 快速接入、构建器支持 tree-shaking          |
| `@yanbobo/gis-sdk/cesium`     | `createMap` 和地图配置类型                    | 创建地图的页面或适配器                     |
| `@yanbobo/gis-sdk/layers`     | 图层契约、`ImageryLayerHandle` 和 `wmsFilter` | 数据适配、瓦片配置、过滤条件构造、类型共享 |
| `@yanbobo/gis-sdk/core`       | `EventHub`、`GisError` 和核心类型             | 无 Cesium 的通用基础模块                   |
| `@yanbobo/gis-sdk/styles.css` | Cesium Widget CSS                             | 实际渲染 Viewer 的页面                     |

::: info 为什么图层方法不能逐个导入
`map.layers.add()`、`remove()` 和 `clear()` 依赖具体地图实例的资源所有权，不能变成无上下文的独立函数。按需导入解决的是模块依赖和包体积问题，不改变实例方法的生命周期约束。
:::

## 根入口仍然兼容

```ts
import { createMap, EventHub, wmsFilter } from '@yanbobo/gis-sdk';
```

根入口不会被删除。使用 Vite、Rollup 或支持 ESM tree-shaking 的 Webpack 配置时，可以继续使用根入口；需要在 Node 工具、类型共享包或精细拆包场景中隔离 Cesium 依赖时，优先使用子路径。
