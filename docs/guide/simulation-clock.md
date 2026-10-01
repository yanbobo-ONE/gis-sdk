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

## 接到地图上

`map.clock.bind(clock)` 把时钟接成地图的时间来源：每个渲染帧按真实帧间隔推进它，并镜像到地图时钟，业务不用自己写帧循环。

```ts
const unbind = map.clock.bind(clock); // 默认由渲染帧推进源时钟
clock.play();
```

演示与回放通常用默认的 `drive: true`；推进由业务负责时（例如实时样本驱动）传 `{ drive: false }`，控制器只做镜像。细节见[地图控制](./map-controls.md#地图时钟)。

## 时间单位

时钟统一使用**毫秒**（与 `RealtimeWaterline`、`normalizePositions` 一致）。CZML 规范使用秒，需要转换时按 `秒 × 1000` 处理，见[CZML 生成与解析](./czml.md)。

## 当前边界

- **不做时间窗口切片**：按窗口加载数据属于数据读取层；窗口内的样本查询由[回放时间轴](./replay-timeline.md)负责；
- **不做数据读取与解析**：时钟只回答"现在是几点、该不该走"，帧从哪里来由业务决定；
- **不调度业务事件**：这一帧该触发什么由[仿真事件调度](./simulation-events.md)负责，时钟只给时刻；
- **不读 CZML 文档自带的 `clock`**：文档时钟不会被自动应用，时间轴联动由业务用 `map.clock.bind()` 显式声明。
