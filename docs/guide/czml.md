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

| 配置              | 默认值                 | 说明                                             |
| ----------------- | ---------------------- | ------------------------------------------------ |
| `epoch`           | `1970-01-01T00:00:00Z` | 时间基准；采样时间以相对它的秒数写入             |
| `intervalSeconds` | `1`                    | 等间隔点位的时间步长（`czmlFromPositions` 专用） |
| `startSeconds`    | `0`                    | 首个采样相对 epoch 的秒数                        |
| `name`            | 无                     | 实体显示名                                       |
| `availability`    | `true`                 | 是否写入覆盖采样起止的可用区间                   |

需要显式时间时用 `czmlFromSamples(id, samples)`，其中每条采样自带 `timeSeconds`；写入前会按时间排序。

单个点位会生成**静态位置**（`cartographicDegrees: [lon, lat, height]`），不写时钟与可用区间。

## 解析

`positionsFromCzml(document, options?)` 返回 `CzmlPositionTrack[]`：`id`、`name`、`epoch`、按时间升序的 `samples`（`timeSeconds` 相对 epoch）与 `availability` 区间。

- epoch 解析顺序：`options.epoch` → 文档 `clock.interval` 的起点 → 任意包的 `position.epoch` → Unix epoch；结果按 ISO 规范化（可能带毫秒）；
- 采样时间既支持相对 epoch 的**秒数**，也支持 **ISO 字符串**；包的 `position.epoch` 会覆盖文档 epoch（与 CZML 规范一致）；
- 没有 `position` 的包（只有 `billboard`、`label` 等）会被跳过，因此同一份文档可以既喂给 Cesium，也喂给 SDK 图层；
- 结构非法（采样数组长度既不是 3 也不是 4 的倍数、时间或坐标非有限值、`availability` 区间不合法）会抛 `INVALID_CZML`，不做静默跳过。

## 边界

- **只覆盖位置**：`billboard`、`label`、`model`、`path` 等属性原样忽略；业务字段不会由 SDK 生成，需要时在文档上追加；
- **不做数据源**：SDK 没有 `map.dataSources`；加载、时钟同步与实体生命周期由业务使用 `map.raw.viewer` 管理；
- **不做时间轴联动**：CZML 的 `clock` 与 `map.scene`/回放时钟的联动属于业务编排（回放时间轴见后续能力）。
