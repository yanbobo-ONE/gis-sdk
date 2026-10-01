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
map.quality.snapshot; // 见下表
```

| 读数字段         | 含义                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| `fps`            | 滑动窗口内的平均帧率                                                 |
| `frameTimeMs`    | 滑动窗口内的平均帧耗时（毫秒）                                       |
| `sampleCount`    | 窗口内的有效帧数；未满 60 说明读数还没稳定                           |
| `frameTimeP50Ms` | 中位帧耗时（毫秒）                                                   |
| `frameTimeP95Ms` | 95 分位帧耗时（毫秒）                                                |
| `frameTimeMaxMs` | 窗口内最长的一帧（毫秒）                                             |
| `longFrames`     | 达到长帧阈值的帧数                                                   |
| `longFrameRatio` | 长帧占比，0 到 1                                                     |
| `degraded`       | 是否已有一项参数低于本次会话的初始值，可直接用于诊断面板显示"已降档" |
| `adaptive`       | 自动画质是否开启                                                     |

平均值会把卡顿摊平：60 帧里两帧卡到 200 毫秒，平均帧耗时也只涨到 25 毫秒（仍有 40 fps）。所以除平均值外还给出分位数、最长帧与长帧计数：

- **分位数用最近秩（nearest-rank）口径**：升序取第 `ceil(p × n)` 个样本，报出的值一定是真出现过的某一帧，而不是插值出来的数。
- **单次顿挫只出现在最长帧上**：窗口 5% 以内的异常帧抬不动 P95（20 帧里的 1 帧就落在 5% 之外）。判断"有没有偶发卡顿"先看 `frameTimeMaxMs` 与 `longFrames`。
- **长帧阈值默认 50 毫秒**，与浏览器 Long Tasks 的阈值取同一个数，便于把"长帧"和主线程长任务对照着看：长帧多而长任务少，瓶颈在 GPU 或合成；两者都多，主线程被 JS 占住了。要按 60 Hz 的节奏看齐不齐，把阈值降到 16.7 毫秒更合适：

```ts
const map = createMap({ container: 'map', quality: { longFrameMs: 16.7 } });
```

长帧阈值只影响读数，不参与升降档判断——升降档仍然只看平均帧率。

## 自动降档的判定方式

自动画质用 60 帧滑动窗口的平均帧率判断，目标帧率默认 30：

- 平均帧率持续低于目标 80%（低于 24fps）累计 10 次采样后降一档；
- 平均帧率持续高于目标 110%（高于 33fps）累计 30 次采样后升一档；
- 两次变更之间至少间隔 2 秒，避免抖动；
- 分辨率每次降 0.1（下限 0.5），地形误差每次加 1（上限 12），模型并发每次减 1（下限 2）。

窗口未满 10 帧、场景没有连续渲染（例如标签页刚恢复），或单帧耗时超过 250ms 时，只更新瞬时帧率并重置窗口，不据此降档。这样页面切换、首帧编译着色器等一次性卡顿不会被误判成持续性能问题。

## 当前边界

SDK 只调整自己拥有的参数：`viewer.resolutionScale`、`scene.globe.maximumScreenSpaceError` 和模型并发上限。MSAA 采样数、雾效与后处理、纹理质量、以及业务自己创建的图元不在调整范围内。自动降档只会在给定档位的参数基础上继续降低或回升，不会超过该档位的分辨率与并发。
