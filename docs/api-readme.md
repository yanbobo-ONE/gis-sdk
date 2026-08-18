# gis-sdk API Reference

本页面由 TypeDoc 从 npm 包根入口 `src/index.ts` 自动生成，仅包含业务项目可以依赖的公共接口。

普通接入从 `createMap()` 开始，通过返回的 `CesiumMap` 管理生命周期；只有 SDK 尚未提供对应高级能力时，才使用 `map.raw.viewer` 调用 Cesium 公共 API。

```ts
const map = createMap({
  container: 'map',
  cesiumBaseUrl: '/cesium/',
});

await map.destroy();
```
