# 有界数据管线

`DataPipeline<T>` 是框架无关的动态更新缓冲区。它把高频输入变成可控的 FIFO 批次；队列达到上限时，按配置合并或丢弃输入。它不会解析协议、访问 `Viewer`、DOM 或 WebGL。

## 典型使用

```ts
import { DataPipeline } from '@yanbobo/gis-sdk/core';

interface PositionUpdate {
  readonly id: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly timestamp: number;
}

const updates = new DataPipeline<PositionUpdate>({
  keyBy: (value) => value.id,
  maxQueueItems: 2_000,
  coalesce: 'latest',
  overflow: 'keep-latest',
});

socket.onmessage = ({ data }) => {
  updates.push(JSON.parse(data) as PositionUpdate);
};

function renderFrame() {
  for (const update of updates.take(200)) {
    // 业务图层或渲染器在这里更新自己拥有的 Cesium 对象。
  }
  requestAnimationFrame(renderFrame);
}
```

每帧最多读取 200 条，因此输入速率高于渲染速率时内存不会无限增长。相同 `id` 在同一队列窗口内只保留最新位置，旧中间位置计入 `coalesced`。

## 创建参数

```ts
const pipeline = new DataPipeline({
  keyBy: (value) => value.id,
  maxQueueItems: 1_000,
  coalesce: 'latest',
  overflow: 'keep-latest',
});
```

| 参数            | 类型                                              | 默认值                                                | 效果                                                   |
| --------------- | ------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `keyBy`         | `(value: T) => string`                            | -                                                     | 必填。返回非空键，用于同对象更新合并                   |
| `maxQueueItems` | `number`                                          | `1000`                                                | 正安全整数。限制仍在等待消费的更新条数                 |
| `coalesce`      | `'none' \| 'latest'`                              | `'latest'`                                            | `latest` 用同键的新值替换旧排队值；`none` 保留每条输入 |
| `overflow`      | `'drop-oldest' \| 'drop-newest' \| 'keep-latest'` | `latest` 时为 `'keep-latest'`，否则为 `'drop-oldest'` | 队列满时的处理策略                                     |

`keyBy` 返回空字符串、非字符串，或容量/读取上限不是正安全整数时，SDK 会抛出 `INVALID_DATA_PIPELINE_KEY`、`INVALID_DATA_PIPELINE_CONFIG` 或 `INVALID_DATA_PIPELINE_TAKE_LIMIT`。

## 方法与统计

| 成员              | 参数       | 返回值                        | 效果                                                           |
| ----------------- | ---------- | ----------------------------- | -------------------------------------------------------------- |
| `push(value)`     | 一条 `T`   | `boolean`                     | 接收/合并成功时为 `true`；`drop-newest` 丢弃新输入时为 `false` |
| `take(maxItems?)` | 正安全整数 | `readonly T[]`                | 按 FIFO 取出最多 N 条；省略时取出当前全部                      |
| `clear()`         | 无         | `void`                        | 丢弃未交付值，不计入 `dropped`                                 |
| `close()`         | 无         | `void`                        | 清空并永久关闭；重复调用无副作用                               |
| `stats`           | 无         | `Readonly<DataPipelineStats>` | 返回冻结的当前统计快照                                         |

`stats` 包含 `accepted`、`coalesced`、`dropped`、`queued`、`taken` 和 `closed`：分别表示接收输入、同键替换、容量丢弃、待消费数、已交付数和关闭状态。

## 溢出策略

| 策略          | 满队列时效果                                                   | 适合场景                         |
| ------------- | -------------------------------------------------------------- | -------------------------------- |
| `drop-oldest` | 删除最早排队值后写入新值                                       | 只关注最近变化，且不需要同键合并 |
| `drop-newest` | 保留现有队列，拒绝当前输入                                     | 先到数据优先，或上游可自行重试   |
| `keep-latest` | 仅与 `latest` 合并配合；同键先替换，其他新键满队列时淘汰最早值 | 动态位置、状态或传感器读数       |

`keep-latest` 与 `coalesce: 'none'` 组合无意义，创建时会抛出 `INVALID_DATA_PIPELINE_CONFIG`。

## 生命周期与下一步

`close()` 后的 `push()`、`take()` 和 `clear()` 都会抛出 `DATA_PIPELINE_CLOSED`。当地图或图层拥有管线时，应在销毁流程中调用 `close()`，避免遗留未交付的业务数据。

- Worker 或 `MessagePort` 输入：见[Worker / MessagePort 输入](./data-pipeline-message-input.md)。
- 需要限制每帧处理量：见[帧预算调度](./data-pipeline-frame-scheduler.md)。
