# 回放时间轴

`ReplayTimeline` 解决一个具体问题：**把"某个对象在某一时刻的状态"取出来**。它按对象分组保存样本，负责时间排序、同刻去重、容量上限、按时刻查询与按窗口切片，样本内容对 SDK 不透明——位置、姿态、标量都可以。

```ts
import { ReplayTimeline } from '@yanbobo/gis-sdk/core';

interface Track {
  readonly time: number; // 秒
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const timeline = new ReplayTimeline<Track>({
  // 插值由调用方给出：SDK 不知道你的样本是什么
  interpolate: (previous, next, ratio) => ({
    time: previous.time + (next.time - previous.time) * ratio,
    x: previous.x + (next.x - previous.x) * ratio,
    y: previous.y + (next.y - previous.y) * ratio,
    z: previous.z + (next.z - previous.z) * ratio,
  }),
  maxSamplesPerKey: 600, // 每个对象保留的样本上限
  maxExtrapolationSeconds: 5, // 断流后最多外推 5 秒，默认不外推
});

timeline.addSamples('sat-1', samples);
timeline.sampleAt('sat-1', clock.currentTime / 1000); // 插值结果
timeline.latest('sat-1', time); // 不晚于该时刻的最近样本
timeline.trackAt('sat-1', time); // 最近 900 秒的轨迹样本
timeline.window('sat-1', startTime, endTime); // 指定窗口，两端都包含
timeline.range; // 当前保留样本的时间跨度
```

## 语义与边界

| 行为             | 规则                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| 同一时刻重复写入 | **替换**原样本，不产生两条同刻样本                                          |
| 容量上限         | 每个对象保留最新 N 条（默认 600），丢弃最旧的；`range` 跟着收缩             |
| 窗口外查询       | 默认返回 `undefined`；配置 `maxExtrapolationSeconds` 且至少两个样本时才外推 |
| 没有插值函数     | `sampleAt()` 退化为"不晚于该时刻的最近样本"，不猜数据                       |
| 非法输入         | 时间非有限数、配置越界抛 `INVALID_REPLAY_INPUT`，不静默丢弃                 |

时间轴**不读数据源、不做缓存策略、不做 Worker 解析**：窗口加载、帧解析、协议适配都在业务侧或数据管线里完成，时间轴只回答"现在该显示什么"。

## 与相邻模块的分工

- `SimulationClock`：负责**时刻**——播放、暂停、倍率、方向、水位线限速。它不知道数据长什么样。
- `ReplayTimeline`：负责**该时刻的数据**——样本排序、去重、插值与窗口切片。
- `DataPipeline` / `RealtimeWaterline`：负责**数据怎么进来**——有界队列、按帧消费、乱序样本释放。
- `SimulationEventScheduler`：负责**该触发什么**——业务事件表的改期、取消，以及按播放方向取区间（时间单位同为秒）。

典型用法是把三者接起来：数据管线把样本喂给时间轴，时钟的每一帧向时间轴查询当前状态，再交给图层渲染。`sampleAt()` 与 `window()` 都是二分查找，可以在每帧调用。

## 插值与外推的口径

- 插值只在**两个真实样本之间**发生，位置、姿态、标量都由你决定怎么算；SDK 不做坐标系假设。
- 外推（`maxExtrapolationSeconds`）默认关闭：断流时宁可让画面停在最后一个样本，也不伪造运动。开启后只沿用最后两个样本的线性趋势，且超出配置秒数立即返回 `undefined`。
- 需要"冻结在最后位置"而不是消失时，业务可以自己用 `latest()` 兜底，例如 `timeline.sampleAt(key, time) ?? timeline.latest(key, time)`。
