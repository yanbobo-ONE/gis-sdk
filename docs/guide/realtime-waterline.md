# 实时水位线

实时链路上样本乱序到达是常态：Socket 抖动、多路复用、服务端补发都会让同一个对象的旧位置晚于新位置到达。直接按到达顺序渲染，实体就会**来回倒退**。

`RealtimeWaterline` 用"最新仿真时间减去缓冲量"形成一个可发布的水位线：只有时间戳不晚于水位线的样本才会被发布，乱序样本按时间排序后逐个释放。它与 `DataPipeline` 的分工是——管线负责**队列与批量**，水位线负责**时间安全**。

```ts
import { DataPipeline, RealtimeWaterline } from '@yanbobo/gis-sdk/core';

interface Position {
  readonly id: string;
  readonly timestamp?: number;
  readonly longitude: number;
  readonly latitude: number;
}

const waterline = new RealtimeWaterline<Position>({
  keyBy: (value) => value.id,
  timeBy: (value) => value.timestamp,
  bufferMs: 1_500, // 与 Plugin-web 的生产初值一致
});

const ready = waterline.push(incomingBatch);
for (const position of ready) {
  // 交给渲染层；此处已经保证不会倒退
}
```

## 水位线怎么算

- 默认：`水位线 = 全局最新仿真时间 − bufferMs`；
- 存在**精确采样对象**时（`exactBy` 返回 `true`，例如按时间采样的轨道点）：`水位线 = 这些对象最新时间的最小值 − bufferMs`。原因很直接——只要有一个精确对象还没走到那个时间，整体就不能播到那里；
- 精确对象超过 `inactiveSampleMs`（默认 10 秒）没有新样本即视为失活，水位线回退到全局最新时间。

队列里的样本同样是有界的：单对象最多 `maxSamplesPerKey`（默认 600）条，且只保留 `sampleWindowMs`（默认 60 秒）窗口内的样本；发布时跳过中间样本，只发"不晚于水位线的最新一条"——中间位置已经过时，补发只会让画面抖动。

## 释放、过期与断档

| 配置               | 默认值 | 作用                                   |
| ------------------ | ------ | -------------------------------------- |
| `bufferMs`         | 1500   | 水位线回退量；抖动越大越需要缓冲       |
| `staleMs`          | 10000  | 超过该时长仍未越线的样本过期丢弃       |
| `maxSamplesPerKey` | 600    | 单对象队列上限                         |
| `sampleWindowMs`   | 60000  | 单对象样本时间窗口                     |
| `inactiveSampleMs` | 10000  | 精确对象失活窗口                       |
| `gapMs`            | 3000   | 断档判定：多久没收到带时间戳样本算断流 |
| `maxFutureLeadMs`  | 30000  | 允许领先的安全上限，交给时间戳守卫     |

`markDisconnected()` 用于链路断开：保持已发布位置不变，直到新的带时间戳样本重新建立安全窗口。

## 追赶

积压过多时不能瞬间跳过去，也不能一直慢慢追。水位线用**双阈值**控制追赶倍率，避免在阈值附近抖动：

- 滞后 ≥ `catchUpEnterLagMs`（默认 `bufferMs × 2`）进入追赶；
- 滞后 ≤ `catchUpExitLagMs`（默认 `bufferMs`）退出追赶；
- 追赶倍率 = `min(maxCatchUpRate, 滞后 / bufferMs)`，上限默认 2.4。

`smoothDurationMs(base)` 把基线插值时长按当前倍率换算（不会低于 80ms），供渲染层缩短插值：

```ts
const duration = waterline.smoothDurationMs(500); // 未追赶时 500，追赶时最多缩短到 208
```

## 时间戳守卫

`RealtimeTimestampGuard` 单独负责一类异常：**远远超前的样本**（单位写错、回放数据混入）。领先超过 `maxFutureLeadMs` 的样本不会立刻接受，而是要求它**连续递增出现 3 次**（每次间隔在 `gapMs` 内）才认定为新时间窗口，否则计入 `isolatedFutureSamples`。

非有限时间戳一律隔离。水位线内部已经使用该守卫，也可以单独使用。

## 状态与统计

`waterline.snapshot` 给出可直接上诊断面板的字段：

| 字段                                                                      | 说明                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `state`                                                                   | `buffering` / `playing` / `stalled` / `disconnected`                                                  |
| `reason`                                                                  | `waiting-samples` / `safe-window-ready` / `sample-timeout` / `transport-disconnected` / `release-lag` |
| `watermark`                                                               | 当前安全播放上限（仿真时间）                                                                          |
| `queuedSamples`                                                           | 仍在队列中的样本数                                                                                    |
| `droppedStaleSamples` / `droppedOverflowSamples` / `droppedWindowSamples` | 过期、超上限、超窗口丢弃的数量                                                                        |
| `isolatedFutureSamples`                                                   | 被时间戳守卫隔离的异常样本数                                                                          |
| `catchUpRate`                                                             | 当前追赶倍率                                                                                          |
| `staleExactKeys`                                                          | 已失活的精确对象数量                                                                                  |
| `gapDurationMs`                                                           | 距上次收到带时间戳样本的时长                                                                          |

## 边界

- **不渲染、不插值**：水位线只决定"哪些样本可以发布"，Cesium 的插值与运动策略仍由渲染层负责。
- **不解析协议、不做重连**：Worker / WebSocket / 二进制协议的接入见[实时数据导航](./data-pipeline.md)，重连与重同步由业务编排。
- **不缓存对象引用**：只保存调用方给的值与时间戳，不持有 Cesium 对象。
