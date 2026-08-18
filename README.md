# gis-sdk

基于 Cesium 1.144 的框架无关 GIS SDK。项目当前处于 alpha 阶段，npm 包通过 `alpha` dist-tag 发布。

当前首个可用切片提供：

- 类型化 `createMap()` 创建入口；
- ESM、CommonJS 和 TypeScript 声明；
- 幂等地图销毁与类型化生命周期事件；
- 受控的 Cesium 原生 `Viewer` 访问入口；
- 类型化图层生命周期以及 GeoJSON、WMS 图层；
- GeoServer 样式切换和类型化 CQL 过滤；
- 默认关闭在线底图和可选控件，无需 Cesium ion token 即可启动空白地球。

## 环境要求

- Node.js 22 或更高版本；
- pnpm 11.19.0；
- 现代浏览器，支持 WebGL 和 `crypto.randomUUID()`。

## 安装

安装 alpha 版本：

```bash
pnpm add @yanbobo/gis-sdk@alpha
pnpm exec gis-sdk-copy-assets public/cesium
```

## 创建地图

```ts
import { createMap } from '@yanbobo/gis-sdk';
import '@yanbobo/gis-sdk/styles.css';

const map = createMap({
  container: 'map',
  cesiumBaseUrl: '/cesium/',
  scene: { mode: '3d' },
});

map.events.on('map:error', ({ error }) => {
  console.error(error.code, error);
});

const roads = await map.layers.add({
  id: 'roads',
  type: 'wms',
  url: 'https://maps.example/geoserver/wms',
  layers: 'city:roads',
});

// 高级需求可受控访问 Cesium 原生对象
map.raw.viewer.scene.requestRender();
```

应用销毁页面或切换 GIS 场景时必须释放实例：

```ts
await map.destroy();
```

`destroy()` 支持并发和重复调用，不会重复销毁底层 `Viewer`。

## 文档

- [快速开始](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/getting-started.md)
- [图层管理](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/guide/layers.md)
- [公开接口说明](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/api.md)
- [产品需求文档](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/cesium-sdk-prd.md)
- [npm 发布流程](https://github.com/yanbobo-ONE/gis-sdk/blob/main/docs/publishing.md)
- [变更日志](https://github.com/yanbobo-ONE/gis-sdk/blob/main/CHANGELOG.md)

完整架构目标还包括海量数据管线、Worker 计算、材质、分析、诊断和 HGD 兼容层；这些能力按 PRD 里程碑逐步交付，不虚构尚未实现的能力。

## 本地开发

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm docs:build
pnpm pack:check
```

当前仓库使用 `UNLICENSED`，在明确开源或商业授权方案前不得把源码或 npm 包视为开放许可证软件。
