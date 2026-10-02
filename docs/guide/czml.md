# CZML 生成与解析

[czml3]: https://github.com/AnalyticalGraphicsInc/czml-writer/wiki/CZML-Guide

[CZML](https://github.com/AnalyticalGraphicsInc/czml-writer/wiki/CZML-Guide) 是 Cesium 生态里描述动态场景的公开数据格式。SDK 提供**最小集**的生成与解析：位置采样（`position.cartographicDegrees`）与可用区间（`availability`），用于把 SDK 里的采样点交给原生 Cesium，或把外部 CZML 读回 SDK 图层。

```ts
import { czmlFromPositions, positionsFromCzml } from '@yanbobo/gis-sdk/core';

// 采样点 → CZML
const document = czmlFromPositions(
  'sat-1',
  orbitPositions, // 例如 sampleOrbitPositions(...) 的结果
  { epoch: '2026-09-30T00:00:00Z', intervalSeconds: 10, name: '卫星一号' },
);

// 交给 Cesium 原生数据源（数据源本身未封装，属业务侧）
const source = await Cesium.CzmlDataSource.load(document);
map.raw.viewer.dataSources.add(source);

// CZML → 采样点
const tracks = positionsFromCzml(document);
tracks[0]?.samples; // [{ timeSeconds, position }, ...]
```

## 生成

| 配置              | 默认值                 | 说明                                                      |
| ----------------- | ---------------------- | --------------------------------------------------------- |
| `epoch`           | `1970-01-01T00:00:00Z` | 时间基准；采样时间以相对它的秒数写入                      |
| `intervalSeconds` | `1`                    | 等间隔点位的时间步长（`czmlFromPositions` 专用）          |
| `startSeconds`    | `0`                    | 首个采样相对 epoch 的秒数                                 |
| `name`            | 无                     | 实体显示名                                                |
| `availability`    | `true`                 | 是否写入覆盖采样起止的可用区间                            |
| `model`           | 无                     | 写入 `model` 报文（`gltf` + `minimumPixelSize`，默认 24） |

需要显式时间时用 `czmlFromSamples(id, samples)`，其中每条采样自带 `timeSeconds`；写入前会按时间排序。

单个点位会生成**静态位置**（`cartographicDegrees: [lon, lat, height]`），不写时钟与可用区间。

### 让实体渲染成模型

```ts
const document = czmlFromPositions('platform-1', positions, {
  intervalSeconds: 5,
  model: { url: 'https://example.com/platform.glb' },
});
```

写入的 `model` 报文与参照实现一致：`gltf` 加 `minimumPixelSize`（默认 24，避免远距离下模型缩成不可见的点），可选 `scale`。这就是 CZML 里"平台"的常规写法：**原生 Cesium 用它渲染模型，SDK 只负责把报文拼对**。需要 SDK 自己的模型图层渲染时，用[静态模型图层](./model-layer.md)，不必经过 CZML。

## 解析

两个入口，按需要的字段选：

| 函数                  | 覆盖字段                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| `positionsFromCzml()` | `position.cartographicDegrees`、`availability`                            |
| `tracksFromCzml()`    | 上面两项 + `orientation.unitQuaternion`（姿态）+ `model.gltf`（模型地址） |

```ts
import { positionsFromCzml, tracksFromCzml } from '@yanbobo/gis-sdk/core';

positionsFromCzml(document); // CzmlPositionTrack[]：位置与可用区间
tracksFromCzml(document); // CzmlTrack[]：再加上 modelUrl 与每条的 attitude
```

`tracksFromCzml()` 返回的 `CzmlTrack` 含 `id`、`name`、`epoch`、`modelUrl`、按时间升序的 `samples`（`timeSeconds` 相对 epoch，每条带 `attitude`）与 `availability` 区间。姿态的口径：

- `unitQuaternion` 支持 4 个值（静态）或 5 的整数倍（`[时间, x, y, z, w]` 采样），顺序与 CZML 一致；模长会被归一化，模长过小（近零）抛 `INVALID_CZML`；
- 位置与姿态两组采样**按时间精确匹配**（1e-6 秒容差）；没有对应姿态时 `attitude` 为 `undefined`，不伪造单位四元数。需要姿态插值或递推时用 `AttitudeDynamics`；
- `velocityReference` 这类不在最小集内的姿态形式**忽略**（不拒收整份文档），`model` 只取 `gltf` 地址，`minimumPixelSize`、`scale` 等渲染参数由消费方决定。

其余解析口径：

- epoch 解析顺序：`options.epoch` → 文档 `clock.interval` 的起点 → 任意包的 `position.epoch` → Unix epoch；结果按 ISO 规范化（可能带毫秒）；
- 采样时间既支持相对 epoch 的**秒数**，也支持 **ISO 字符串**；包的 `position.epoch` 会覆盖文档 epoch（与 CZML 规范一致）；
- 没有 `position` 的包（只有 `billboard`、`label` 等）会被跳过，因此同一份文档可以既喂给 Cesium，也喂给 SDK 图层；
- 结构非法（采样数组长度既不是 3 也不是 4 的倍数、时间或坐标非有限值、`availability` 区间不合法）会抛 `INVALID_CZML`，不做静默跳过。

## 作为图层渲染：`type: 'czml'`

生成或拿到的文档可以直接交给图层管理器，实体生命周期由 SDK 负责：

```ts
const layer = await map.layers.add({
  id: 'satellites',
  type: 'czml',
  data: czmlFromPositions('sat-1', orbitPositions, { intervalSeconds: 5 }), // 或 '/data/satellites.czml'
});

layer.entityCount; // 文档解析出的实体数
await layer.setData(nextDocument); // 原子替换：旧实体一直有效，直到新文档加载成功
layer.setVisible(false);
await layer.remove();
```

| 能力        | 语义                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 加载        | 文档数组直接交给 Cesium；字符串按同源 / CORS 可访问的 URL 拉取 JSON                                                                   |
| `setData()` | 新文档加载成功后才替换旧实体；取消时旧文档继续生效，图层不进入错误态                                                                  |
| 生命周期    | `setVisible()`、`remove()`、`map.destroy()` 统一释放 `DataSource`                                                                     |
| 可观测      | `state`、`errorCount`、`layer.events.on('error')`、`entityCount` 与其它图层一致                                                       |
| 拾取        | 实体命中回落到本图层：`layerId` 是图层 id，`objectId` 是文档里的实体 id，见[拾取交互](./picking.md)                                   |
| 时钟        | 文档自带 `clock` 的读数在 `layer.clock`（毫秒时间戳）；**不自动应用**到地图时钟——同一张地图上可能有多个文档，谁是主时间轴只有业务知道 |

### 把文档时钟接到地图上

`layer.clock` 把文档里的 ISO 区间解析好交给业务，省掉自己解析 CZML 的步骤；要不要用、怎么用由业务决定：

```ts
const layer = await map.layers.add({ id: 'orbits', type: 'czml', data: document });

const clock = layer.clock;
if (clock) {
  map.clock.setRange(clock.startTime, clock.endTime);
  map.clock.setTime(clock.currentTime ?? clock.startTime);
  map.clock.setAnimating(true);
}
```

要让 `SimulationClock` 决定播放状态（倍率、暂停、seek），把上面的范围喂给它再 `map.clock.bind()` 即可——见[仿真 / 回放时钟](./simulation-clock.md#接到地图上)；要按时刻取数据再渲染，接[回放时间轴](./replay-timeline.md#把时间轴接成会话replaysession)。
文档没有 `clock`、区间格式非法或终点早于起点时 `layer.clock` 为 `undefined`（读数不抛错）；`setData()` 换文档后读数跟着换。

## 装进回放时间轴

```ts
import { createTrackTimeline, sampleTrackPose, SimulationClock } from '@yanbobo/gis-sdk/core';

const track = tracksFromCzml(document)[0];
const timeline = createTrackTimeline(track);

const clock = new SimulationClock({ mode: 'replay', startTime: 0, endTime: 60 });
const pose = sampleTrackPose(timeline, track.id, clock.snapshot.currentTime ?? 0);
// pose = { position, attitude } → 交给模型图层 setTransform() 或相机
```

`createTrackTimeline()` 把轨迹装成 `ReplayTimeline`，查询时：

- 位置按**最短弧**插值经度（跨 180° 不会绕地球一圈），纬度与高度线性；
- 姿态用四元数**球面线性插值**（`slerp()`）；只有一端有姿态时取更近那一端的姿态——保证采样时刻恰好返回该采样自身的姿态，不会在缺失姿态的点上凭空补一个；
- 默认不外推：超出采样范围返回 `undefined`，按 `maxExtrapolationSeconds` 可以放宽。

时间轴只管"什么时刻是什么姿态"，播放、倍率与暂停交给 `SimulationClock`，渲染交给模型图层。

## 边界

- **最小集之外的属性不解析**：`billboard`、`label`、`path`、`polyline` 等渲染属性原样忽略；业务字段不会由 SDK 生成，需要时在文档上追加；
- **CZML 图层只管实体生命周期**：文档里的 `clock` 不会被自动应用（实体动画由 Cesium 自己按地图时钟推进）；直接操作 `viewer.dataSources` 时资源由业务释放；
- **时间轴联动要显式声明**：用 `map.clock.bind(clock)` 把[仿真时钟](./simulation-clock.md)接到地图上，或把解析出的采样喂给[回放时间轴](./replay-timeline.md)。
