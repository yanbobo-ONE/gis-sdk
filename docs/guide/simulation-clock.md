# 仿真 / 回放时钟

`SimulationClock` 是回放与实时共用的时间基准：**时间推进只由 `advance(真实经过的毫秒)` 驱动**，不依赖 `requestAnimationFrame` 或任何引擎，因此可以用假时间做确定性测试。

```ts
import { SimulationClock } from '@yanbobo/gis-sdk/core';

const clock = new SimulationClock({
  mode: 'replay',
  startTime: Date.parse('2026-09-30T00:00:00Z'),
  endTime: Date.parse('2026-09-30T01:00:00Z'),
  rate: 4, // 4 倍速
});

clock.subscribe((snapshot) => {
  // snapshot.currentTime / state / rate / direction
});

clock.play();
// 渲染循环里：
function frame(realDeltaMs: number) {
  const snapshot = clock.advance(realDeltaMs);
  renderAt(snapshot.currentTime);
}
```

## 状态与能力

| 成员                                | 说明                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `snapshot`                          | `state`、`currentTime`、`startTime`、`endTime`、`rate`、`direction`、`mode`、`watermark`、`reason` |
| `play()`                            | 开始播放；已停在末尾时按当前方向回到起点（实时模式不回绕）                                         |
| `pause()` / `seek(ms)` / `step(ms)` | 暂停 / 跳转（进入暂停或结束）/ 单步，`step` 不改变播放状态                                         |
| `setRate(rate)`                     | 播放倍率，必须为正有限数                                                                           |
| `setDirection(±1)`                  | 正向或倒放；从结束状态切方向会回到暂停                                                             |
| `setMode(mode)`                     | `'realtime'` / `'replay'` / `'demo'`                                                               |
| `setWatermark(ms?)`                 | 实时模式的安全播放上限；传 `undefined` 清除                                                        |
| `stall(reason)`                     | 标记停滞并记录原因（例如实时断流）                                                                 |
| `advance(realMs)`                   | 按真实经过时间推进；只有 `playing` 才前进                                                          |
| `reset(options)`                    | 原地换时间基准与范围，**已有订阅继续跟随同一个时钟**                                               |

## 与实时水位线的配合

`realtime` 模式下，`watermark` 会限制播放游标：即使 `advance()` 传入更大的真实增量，时间也不会越过水位线。这正是[实时水位线](./realtime-waterline.md) 与渲染之间的接线方式：

```ts
const ready = waterline.push(incoming); // 取出可安全发布的样本
clock.setWatermark(waterline.watermark); // 用水位线限制播放游标
clock.advance(realDeltaMs); // 游标最多推进到水位线
```

迟到的水位线（早于当前上限）会被忽略，避免游标倒退；当前游标超前于新上限时会被拉回，并可通过 `stall('transport-disconnected')` 标记断流。

## 时间单位

时钟统一使用**毫秒**（与 `RealtimeWaterline`、`normalizePositions` 一致）。CZML 规范使用秒，需要转换时按 `秒 × 1000` 处理，见[CZML 生成与解析](./czml.md)。

## 当前边界

- **不做时间窗口切片**：按窗口加载数据属于数据读取层；SDK 未提供 `ReplayTimeline`（参照实现里它与帧解析、缓存策略耦合）；
- **不做数据读取与解析**：时钟只回答"现在是几点、该不该走"，帧从哪里来由业务决定；
- **不驱动 Cesium 时钟**：没有与 `viewer.clock` 自动联动；需要时用 `map.raw.viewer.clock` 自行设置。
