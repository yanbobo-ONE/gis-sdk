---
layout: home

hero:
  name: gis-sdk
  text: 可复用的 Cesium GIS SDK
  tagline: 简单场景开箱即用，复杂场景保留原生能力，业务项目不再重复维护地图底座。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/

features:
  - title: 稳定入口
    details: 通过 createMap、实例方法和类型化事件使用地图能力，隔离 Cesium 初始化细节。
  - title: 框架无关
    details: 核心不依赖 Vue 或 React，可被 HGD、仿真平台及其他 GIS 项目复用。
  - title: 可深入底层
    details: 高级需求可通过 raw.viewer 使用 Cesium 公共 API，不需要绕过 SDK 私自取内部字段。
---

当前发布线为 `0.1.0-alpha.0`，已经具备最小地图运行时和 Cesium 适配器。图层、数据管线、Worker、材质、分析与兼容层按 [PRD](./cesium-sdk-prd.md) 继续建设。
