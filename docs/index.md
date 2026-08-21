# gis-sdk

<p class="doc-lead">面向业务项目的类型化 Cesium SDK。用稳定接口管理地图、相机、底图、地形和图层，同时保留访问 Cesium 公共 API 的能力。</p>

<div class="status-line">
  <span>alpha · 0.1.0-alpha.8</span>
  <span>Cesium 1.144</span>
  <span>ESM + CommonJS</span>
  <span>TypeScript</span>
</div>

::: tip 当前可用范围
当前源码支持地图生命周期、相机、XYZ 底图、椭球 / Cesium Terrain 地形、GeoJSON、WMS/GeoServer、TMS、WMTS、3D Tiles、类型化 CQL 过滤、图层资源清理，以及有界数据缓冲、批处理、Worker / MessagePort 消息输入转发和帧预算调度。Worker 池、Primitive 大数据渲染、材质与空间分析尚未发布，不应按已完成功能接入。
:::

## 为什么使用 gis-sdk

<div class="advantage-grid">
  <div>
    <strong>业务接口稳定</strong>
    <p>通过 createMap、map.layers 和能力化句柄调用，不把 Cesium 初始化、异步加载和资源销毁散落到页面。</p>
  </div>
  <div>
    <strong>框架无关</strong>
    <p>核心不依赖 Vue、React 或业务 Store，同一套接口可用于原生页面、组件应用和微前端。</p>
  </div>
  <div>
    <strong>资源所有权明确</strong>
    <p>地图拥有图层，图层拥有 Cesium 资源和异步任务。页面退出时一次 destroy 即可按顺序清理。</p>
  </div>
  <div>
    <strong>类型化能力句柄</strong>
    <p>GeoJSON 和 WMS 只暴露各自能稳定承诺的方法，3D Tiles 复用最小图层生命周期，IDE 能直接提示正确方法。</p>
  </div>
  <div>
    <strong>有界动态数据</strong>
    <p>通过 DataPipeline 合并同一对象的高频更新，并用明确的容量策略避免输入积压无限增长。</p>
  </div>
  <div>
    <strong>可按需导入</strong>
    <p>支持包根入口，也支持 /core、/cesium、/layers 子路径，过滤工具无需引入 Viewer 创建入口。</p>
  </div>
  <div>
    <strong>不封死底层</strong>
    <p>SDK 尚未覆盖的高级能力可通过 raw.viewer 调用 Cesium 公共 API，私有字段不在兼容承诺内。</p>
  </div>
</div>

## 3 分钟创建地图

```bash
pnpm add @yanbobo/gis-sdk@alpha
pnpm exec gis-sdk-copy-assets public/cesium
```

```ts
import { createMap } from '@yanbobo/gis-sdk/cesium';
import '@yanbobo/gis-sdk/styles.css';

const map = createMap({
  container: 'map',
  cesiumBaseUrl: '/cesium/',
});

const roads = await map.layers.add({
  id: 'roads',
  type: 'wms',
  url: 'https://maps.example.com/geoserver/wms',
  layers: 'city:roads',
});

roads.setOpacity(0.65);

// 页面卸载时释放图层、请求、监听器和 Viewer。
await map.destroy();
```

继续阅读[快速开始](/guide/getting-started)，或直接查看带参数、返回值、异常和完整流程的 [API 使用参考](/guide/api-reference)。自动生成的完整类型列表位于 [TypeScript 类型索引](/api/)；已完成与未完成能力以[功能状态与路线图](/guide/capability-status)为准。

## 能力状态

| 模块                 | 当前状态 | 说明                                              |
| -------------------- | -------- | ------------------------------------------------- |
| 地图运行时           | 可用     | 创建、尺寸更新、事件、并发幂等销毁                |
| GeoJSON              | 可用     | 对象/URL、基础样式、取消、原子数据替换            |
| WMS                  | 可用     | 透明度、样式、类型化过滤、Provider 重载           |
| 3D Tiles             | 可用     | 加载、显隐、基础 LOD 配置与资源释放               |
| TMS/WMTS             | 可用     | 类型化瓦片 Provider、显隐、透明度、取消和资源释放 |
| 原生出口             | 可用     | `map.raw.viewer`，仅承诺 Cesium 公共接口          |
| 相机/XYZ/地形        | 可用     | `map.camera`、`map.basemap`、`map.terrain`        |
| 数据管线核心         | 可用     | 有界更新、最新值合并、批量读取和统计              |
| 消息输入适配器       | 可用     | Worker / MessagePort 监听、解码转发和统计         |
| 帧预算调度器         | 可用     | 请求合并、每帧有界消费、取消和统计                |
| Worker 池/大数据渲染 | 规划中   | 尚无 Worker 池、渲染策略或性能承诺                |
| 材质/空间分析        | 规划中   | 尚未提供稳定 SDK 接口                             |

规划中的能力没有公开调用方法。功能完成后会同时更新[功能状态与路线图](/guide/capability-status)、API 使用参考、README/npm 包页面和变更日志，并发布新的 alpha 版本。
