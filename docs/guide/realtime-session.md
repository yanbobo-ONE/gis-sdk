# 实时会话与重同步

实时链路有两类"看起来像正常数据、实际必须丢掉"的消息：**旧会话的迟到包**与**序列断档后的增量**。这两件事交给 `RealtimeSessionGate` 与 `RealtimeResyncController` 两个纯状态机处理，都不依赖具体传输协议。

## 会话门禁

断线重连、切页重建、多路数据源并存时，旧连接的迟到包会把运行状态"夺回"到已经结束的会话。门禁只允许两种方式改变当前会话：

1. **首条携带会话 id 的业务消息**（建立会话）；
2. **显式的开始 / 切换控制消息**（只切换会话，本身不进管线）。

其余与会话不匹配的消息一律拒绝。

```ts
import { RealtimeSessionGate } from '@yanbobo/gis-sdk/core';

interface Envelope {
  readonly type?: string;
  readonly sessionId?: string;
}

const gate = new RealtimeSessionGate<Envelope>({
  sessionOf: (message) => message.sessionId,
  isBegin: (message) => message.type === 'gis.session.begin',
});

const decision = gate.evaluate(message);
if (!decision.accept) {
  // 旧会话的迟到包、控制消息、或缺少会话信息的控制消息都会走到这里
  return;
}
if (decision.switched) {
  // 首次建立或切换会话：清空上一会话的残留状态（水位线、选中集合等）
  waterline.reset();
}
```

规则细节：

| 消息                               | `accept` | `switched` | 说明                         |
| ---------------------------------- | -------- | ---------- | ---------------------------- |
| 不带会话信息                       | `true`   | `false`    | 兼容无会话概念的数据源       |
| 首条带会话 id                      | `true`   | `true`     | 建立会话                     |
| 会话 id 与当前一致                 | `true`   | `false`    | 正常数据                     |
| 会话 id 与当前不同                 | `false`  | `false`    | 旧连接迟到包，丢弃           |
| 开始 / 切换控制消息（带会话 id）   | `false`  | 视情况     | 切换会话，消息自身不进管线   |
| 开始 / 切换控制消息（缺少会话 id） | `false`  | `false`    | 非法控制消息，不改变当前会话 |

`reset()` 清空当前会话，用于整页重建。

## 重同步

增量序列断档（丢包、服务端重启、订阅切换）需要拉一次全量快照，但网络抖动会让**同一次断档被反复上报**：控制器把同一等待窗口内的重复请求合并掉，并用请求上限防止无限重试。

状态机只有三态：`synchronized`（增量连续）、`waiting-snapshot`（已请求、等待快照）、`catching-up`（快照已到、正在补齐增量）。

```ts
import { RealtimeResyncController } from '@yanbobo/gis-sdk/core';

const resync = new RealtimeResyncController({ maxRequests: 3 });

const state = resync.acceptDelta(message.sequence);
if (state.state === 'waiting-snapshot') {
  const { cursor, requests, suppressedRequests } = resync.requestSnapshot(lastCursor);
  // 只在 requests 增长时真的发请求；suppressedRequests 表示这次被合并了
}

// 收到快照后
resync.acceptSnapshot(snapshot.sequence);
```

| 方法                       | 作用                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `onGap(sequence)`          | 记录断档并决定是否请求快照；同一断档重复上报只计抑制                     |
| `requestSnapshot(cursor?)` | 显式请求快照；等待窗口内只计抑制                                         |
| `acceptSnapshot(sequence)` | 接受快照末尾序列号，进入增量追赶                                         |
| `acceptDelta(sequence)`    | 接受增量：连续则推进基线；**小于期望值直接丢弃**；大于期望值转入等待快照 |
| `reset()`                  | 清空状态与计数                                                           |

`resync.snapshot` 给出 `state`、`expectedSequence`、`acceptedSequence`、`requests` 与 `suppressedRequests`，可直接上诊断面板。

## 与水位线的配合

三者职责不同，组合使用的顺序通常是：

```text
传输 → 会话门禁（丢旧会话） → 协议解析 → 水位线（丢不可播） → 渲染
                                    ↑
                              重同步控制器（序列级）
```

## 边界

- **不解析协议、不管理连接**：门禁与重同步只回答"这条消息该不该收"与"现在处于什么同步状态"；重连、退避与请求发送由业务编排。
- **不做版本墓碑**：Plugin-web 的墓碑逻辑属于其业务数据合并（`mergeGisBatch`），依赖业务主键与删除语义，未进入 SDK。
- **不持有业务对象**：两者都只保留 id、序列号与计数。
