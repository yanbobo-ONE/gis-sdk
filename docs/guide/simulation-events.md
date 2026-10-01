# 仿真事件调度 SimulationEventScheduler

回放到某个时刻，业务往往要做的不只是"把点位画出来"，还有"该触发什么"：告警到点、链路开始建立、阶段切换。`SimulationEventScheduler` 只管这张事件表——什么时候触发什么——触发后的动作由业务决定，因此它不依赖 Cesium、不持有计时器。

```ts
import { SimulationEventScheduler } from '@yanbobo/gis-sdk/core';

const events = new SimulationEventScheduler<{ readonly message: string }>();
events.add({ id: 'alarm-1', timeSeconds: 12, type: 'alarm', payload: { message: '进入警戒区' } });
events.add({ id: 'alarm-1', timeSeconds: 30, type: 'alarm', payload: { message: '离开警戒区' } });

// 回放循环里按帧取走这一段该触发的事件
for (const event of events.between(previousSeconds, currentSeconds)) {
  handle(event.type, event.payload);
}
```

## 时间单位与相邻模块的分工

| 模块                       | 回答的问题                 | 时间单位           |
| -------------------------- | -------------------------- | ------------------ |
| `SimulationClock`          | 现在是什么时刻、要不要推进 | 毫秒（时间戳）     |
| `ReplayTimeline`           | 某个时刻的样本长什么样     | 秒                 |
| `SimulationEventScheduler` | 这一段区间里有哪些事件     | 秒（与时间轴一致） |

事件时间用**秒**，与回放时间轴保持一致；与地图时钟（`map.clock`，毫秒时间戳）对齐时自行乘 1000，例如 `events.between((previousMs - startMs) / 1000, (currentMs - startMs) / 1000)`。

## 成员

| 成员                            | 参数                                 | 行为                                                       |
| ------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| `add(event)`                    | `{ id, timeSeconds, type, payload }` | 新增或**改期**：同 `id` 替换原事件，不并列两条；返回该事件 |
| `remove(id)`                    | `string`                             | 取消事件；不存在时返回 `false`（不抛错）                   |
| `clear()`                       | 无                                   | 清空全部事件                                               |
| `between(from, to, direction?)` | 秒、`'forward'`（默认）/ `'reverse'` | 取出区间内该触发的事件；正向升序、反向**降序**返回         |
| `all()`                         | 无                                   | 全部事件的时间升序副本                                     |
| `count`                         | 无                                   | 当前事件数量                                               |

同一 `id` 可以改期，是因为"告警延期"比"取消再新增"更贴近业务语义：改期只影响触发时刻，不改变事件的身份。

## 区间语义：半开半闭，配连续取帧

两个方向都是**起点不触发、终点触发一次**，这样回放循环用"上一帧 → 这一帧"连续取值不会重复触发：

- `'forward'`：`from < timeSeconds <= to`，按时间升序；
- `'reverse'`：`to <= timeSeconds < from`，按时间降序（倒放时的触发顺序）。

```ts
events.add({ id: 'a', timeSeconds: 1, type: 'phase', payload: null });
events.add({ id: 'b', timeSeconds: 2, type: 'phase', payload: null });

events.between(0, 1).map((e) => e.id); // ['a']：第一帧就该触发
events.between(1, 2).map((e) => e.id); // ['b']：a 不会重复触发
events.between(3, 1, 'reverse').map((e) => e.id); // ['b', 'a']：倒放顺序
```

倒放时起点同样不重复触发：从 3 秒开始倒放，第一次取帧用 `between(3, 2, 'reverse')` 只会拿到 2 秒的事件；起点之前的事件需要另外用 `all()` 或把起点设为稍晚于它。

## 与时钟、时间轴一起用

```ts
import { SimulationClock, SimulationEventScheduler } from '@yanbobo/gis-sdk/core';

const clock = new SimulationClock({ mode: 'demo', startTime: 0, endTime: 120_000, initialTime: 0 });
const events = new SimulationEventScheduler();
events.add({ id: 'takeoff', timeSeconds: 15, type: 'phase', payload: { phase: '起飞' } });

map.clock.bind(clock);
clock.play();

// 每帧：从时钟读当前时刻，取这一帧该触发的事件
let previousMs = 0;
function onFrame(): void {
  const currentMs = clock.currentTime ?? 0;
  for (const event of events.between(previousMs / 1000, currentMs / 1000)) {
    handle(event.type, event.payload);
  }
  previousMs = currentMs;
  requestAnimationFrame(onFrame);
}
```

`between()` 每次返回新数组，`all()` 返回副本，改动返回值不会影响调度器。

## 异常边界

- 事件缺少 `id` / `type`、`timeSeconds` 不是有限数 → `INVALID_SIMULATION_INPUT`；
- 区间端点不是有限数、方向不是 `'forward'` / `'reverse'` → `INVALID_SIMULATION_INPUT`；
- `remove()` 未知 id 返回 `false`，不抛错——回放里"事件已被改期或取消"是常态。

调度器不设容量上限：它面向业务级事件表（百量级），不做采样数据的滑窗淘汰；海量点位请用[回放时间轴](./replay-timeline.md)的窗口切片。

## 相关页面

- [仿真 / 回放时钟](./simulation-clock.md)：播放状态机、倍率、seek / step 与水位线限速
- [回放时间轴](./replay-timeline.md)：样本查询、插值与窗口切片
- [地图时钟](./map-controls.md)：把 `SimulationClock` 绑到地图时间轴，驱动 CZML 动态实体
