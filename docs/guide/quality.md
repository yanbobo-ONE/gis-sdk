# 渲染质量与自动降档

`map.quality` 把渲染分辨率、地形精度和模型并发收敛成一组可调参数，并按实际帧率自动升降档。这三项在 Plugin-web 的生产压测中被证明必须一起调整：只降分辨率不降地形误差，GPU 仍然被地形瓦片拖住；只降地形不收紧模型并发，模型解析又会挤占主线程。

## 内置质量档

| 档位       | `resolutionScale` | `terrainSse` | `modelLoadConcurrency` | 适用场景                   |
| ---------- | ----------------- | ------------ | ---------------------- | -------------------------- |
| `default`  | 1                 | 2            | 4                      | 默认；保持 Cesium 原生参数 |
| `quality`  | 1.5               | 2            | 8                      | 高分辨率大屏、展示场景     |
| `balanced` | 1                 | 8            | 4                      | 兼顾清晰度与帧率           |
| `low`      | 0.75              | 12           | 2                      | 低配设备、多图层叠加       |

`resolutionScale` 越大越清晰也越耗 GPU；`terrainSse` 是地形最大屏幕空间误差，越大越省；`modelLoadConcurrency` 是[静态模型图层](./model-layer.md)的并发加载上限。

```ts
const map = createMap({
  container: 'map',
  quality: { profile: 'balanced', adaptive: true },
});
```

也可以在档位基础上只覆盖某一项：

```ts
const map = createMap({
  container: 'map',
  quality: { profile: 'balanced', modelLoadConcurrency: 8 },
});
```

非法档位或超范围取值会让 `createMap()` 抛出 `INVALID_QUALITY_CONFIG`，不会静默回退。

## 运行时调整

```ts
map.quality.setProfile('low'); // 切换档位，同时退出自动画质
map.quality.set({ resolutionScale: 0.8 }); // 只改一项，同样退出自动画质
map.quality.setAdaptive(true); // 重新开启按帧率自动升降档

map.quality.current; // 当前生效的参数
map.quality.snapshot; // { ...current, fps, frameTimeMs, sampleCount, degraded, adaptive }
```

`snapshot.degraded` 表示至少有一项参数低于本次会话的初始值，可直接用于诊断面板显示"已降档"。

## 自动降档的判定方式

自动画质用 60 帧滑动窗口的平均帧率判断，目标帧率默认 30：

- 平均帧率持续低于目标 80%（低于 24fps）累计 10 次采样后降一档；
- 平均帧率持续高于目标 110%（高于 33fps）累计 30 次采样后升一档；
- 两次变更之间至少间隔 2 秒，避免抖动；
- 分辨率每次降 0.1（下限 0.5），地形误差每次加 1（上限 12），模型并发每次减 1（下限 2）。

窗口未满 10 帧、场景没有连续渲染（例如标签页刚恢复），或单帧耗时超过 250ms 时，只更新瞬时帧率并重置窗口，不据此降档。这样页面切换、首帧编译着色器等一次性卡顿不会被误判成持续性能问题。

## 当前边界

SDK 只调整自己拥有的参数：`viewer.resolutionScale`、`scene.globe.maximumScreenSpaceError` 和模型并发上限。MSAA 采样数、雾效与后处理、纹理质量、以及业务自己创建的图元不在调整范围内。自动降档只会在给定档位的参数基础上继续降低或回升，不会超过该档位的分辨率与并发。
