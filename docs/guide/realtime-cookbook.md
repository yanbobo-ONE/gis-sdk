# 实时链路组装（从数据到画面）

这篇把实时链路的四个模块接成一个完整流程：**长连接 → 会话门禁 → 水位线 → 缓冲 → 每帧有界消费 → 图层**。每个模块自己的语义在各自文档里；这里只讲怎么拼、以及拼的时候容易踩什么。

页面里的装配代码与仓库里的 `tests/realtime-cookbook.test.ts` 是同一份逻辑，**测试就是它的可执行版本**——文档与行为不会漂移。

## 完整装配

```ts
import {
  DataPipeline,
  DataPipelineFrameScheduler,
  RealtimeResyncController,
  RealtimeSessionGate,
  RealtimeSocketClient,
  RealtimeWaterline,
} from '@yanbobo/gis-sdk/core';

interface Frame {
  readonly sessionId: string;
  readonly kind: 'frame' | 'session-begin';
  readonly sequence: number;
  readonly objectId: string;
  readonly timeMs: number;
  readonly longitude: number;
  readonly latitude: number;
}

// 1) 链路：连接、重连、心跳、按类型分发
const socket = new RealtimeSocketClient({
  url: 'wss://example.com/realtime',
  heartbeat: {
    intervalMs: 15_000,
    timeoutMs: 5_000,
    message: { type: 'ping' },
    isPong: (m) => m.type === 'pong',
  },
});

// 2) 会话门禁：旧会话的迟到包直接丢
const gate = new RealtimeSessionGate<Frame>({
  sessionOf: (frame) => frame.sessionId,
  isBegin: (frame) => frame.kind === 'session-begin',
});

// 3) 水位线：乱序样本按时间释放
const waterline = new RealtimeWaterline<Frame>({
  keyBy: (frame) => frame.objectId,
  timeBy: (frame) => frame.timeMs,
  bufferMs: 1_500,
});

// 4) 缓冲：按对象键合并，只保留最新
const pipeline = new DataPipeline<{ id: string; longitude: number; latitude: number }>({
  keyBy: (point) => point.id,
  maxQueueItems: 4_096,
});

// 5) 每帧有界消费：一帧最多交付 N 条给图层
const scheduler = new DataPipelineFrameScheduler({
  pipeline,
  maxItemsPerFrame: 512,
  onBatch: (batch) => points.setData(batch),
});

// 6) 重同步：序列断档时请求快照
const resync = new RealtimeResyncController({ maxRequests: 3 });

socket.subscribe('*', (message) => {
  const frame = message.payload as Frame;

  // ① 会话门禁：控制消息切换会话并清空积压；旧会话的迟到包在这里被丢掉。
  const decision = gate.evaluate(frame);
  if (!decision.accept) {
    if (decision.switched) {
      waterline.reset();
      resync.reset();
    }
    return;
  }

  // ② 序列连续性：断档就请求快照，等快照期间不把不连续的数据喂进水位线。
  const before = resync.snapshot;
  const after = resync.acceptDelta(frame.sequence);
  if (after.state === 'waiting-snapshot') {
    if (after.requests > before.requests) {
      socket.send({ type: 'snapshot', cursor: `seq:${String(before.acceptedSequence ?? 0)}` });
    }
    return;
  }

  // ③ 水位线：push 返回"此刻可以安全播放"的样本（回调只用于拒绝，不用于接收）。
  const released = waterline.push([frame]);
  for (const sample of released) {
    pipeline.push({ id: sample.objectId, longitude: sample.longitude, latitude: sample.latitude });
  }

  // ④ 有数据才请求帧消费；重复请求会被调度器合并成一次。
  if (released.length > 0) {
    scheduler.request();
  }
});

socket.connect();
```

## 每一层在挡什么

| 层                           | 挡掉的问题                               | 读什么诊断                                   |
| ---------------------------- | ---------------------------------------- | -------------------------------------------- |
| `RealtimeSocketClient`       | 断线、心跳超时、解码失败；按类型路由     | `socket.stats`：消息数 / 解码失败 / 重连次数 |
| `RealtimeSessionGate`        | 旧会话的迟到包、控制消息误入业务管线     | `gate.sessionId`                             |
| `RealtimeResyncController`   | 序列断档（丢包）导致的错位，请求快照补齐 | `resync.snapshot`：state / expected / 抑制数 |
| `RealtimeWaterline`          | 乱序样本、超前样本、长时间不更新的对象   | `waterline.snapshot`：水位线 / 队列 / 丢弃数 |
| `DataPipeline`               | 突发流量、同一对象的重复帧               | `pipeline.stats`：合并数 / 丢弃数 / 队列长度 |
| `DataPipelineFrameScheduler` | 一帧内处理太多数据导致掉帧               | `scheduler.stats`：请求 / 合并 / 每帧消费数  |

## 容易踩的四处

1. **`waterline.push()` 的返回值就是"可以立刻发布的样本"**，回调 `onAccepted` 只用来**拒绝**（返回 `false` 表示这个样本不要进队列），不是用来接收数据的。搞反了会变成"每条都直接进图层"，水位线形同虚设——这正是写这篇的集成测试最初抓到的错。
2. **`DataPipeline` 按 `keyBy` 合并**：同一个对象连来两帧，队列里只留最新的那条（`stats.coalesced` 会计数）。所以图层拿到的是"每个对象的最新状态"，而不是每一帧的原始样本——这对点位图层是正确的（它本来就是状态渲染，`setData()` 是整层替换）。
3. **水位线缓冲不是延迟**：`bufferMs` 补偿的是网络抖动。设大了画面更平滑但更滞后，设小了会频繁"等数据"。1500ms 是参照实现验证过的默认值，弱网可按实测调高。
4. **诊断快照不要每帧采**：`map.diagnostics.snapshot()` 会遍历图层与效果，按秒级或事件触发采集即可；实时链路的每帧统计请读上面表格里的 `stats`。

## 装配顺序上的两个判断

- **门禁在水位线之前**：会话切换必须先于时间判断，否则新会话的第一帧会被拿去跟旧会话的时间戳比较，出现莫名其妙的"样本过期"。
- **重同步在缓冲之前**：断档期间不要往缓冲里灌数据（等快照补齐后从断点继续），否则业务会看到"位置先跳一段再回拉"。`RealtimeResyncController` 的 `waiting-snapshot` 状态就是给这个判断用的。

## 收尾：销毁顺序

按**数据流反向**释放，避免销毁后仍有回调往里推数据：

```ts
scheduler.dispose(); // 先停帧消费
pipeline.close(); // 再关缓冲
waterline.reset();
resync.reset();
socket.dispose(); // 最后断链路
```

`map.destroy()` 会释放地图侧的资源；链路与管线属于业务侧，需要自己按上面的顺序收尾。

## 相关文档

- [实时链路（WebSocket）](./realtime-socket.md)：连接、重连退避、心跳与消息路由
- [实时水位线与时间戳守卫](./realtime-waterline.md)：乱序释放、双阈值追赶、超前样本隔离
- [会话门禁与重同步](./realtime-session.md)：旧会话丢弃、序列断档与快照请求
- [数据管线](./data-pipeline.md) / [帧预算调度](./data-pipeline-frame-scheduler.md)：缓冲与每帧有界消费
- [点位图层与标签](./points-layer.md)：`setData()` 的原子替换语义与标签上限
- [诊断快照](./diagnostics.md)：一次读取运行状态用于排查
