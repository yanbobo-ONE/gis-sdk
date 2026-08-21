# 数据管线

`DataPipeline<T>` 是框架无关的动态更新缓冲区。它把高频输入变成可控的 FIFO 批次，并在队列有上限时按规则合并或丢弃更新。业务代码负责把消息解析为自己的类型；后续渲染器负责把取出的更新应用到它拥有的 Cesium 对象。

需要把 Worker 或 `MessagePort` 消息接入管线时，使用同样框架无关的
`DataPipelineMessageAdapter<T>`。它负责监听、解码转发、输入统计和解绑；不创建或终止
Worker，也不解析任何固定业务协议。

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
  const value = JSON.parse(data) as PositionUpdate;
  updates.push(value);
};

function renderFrame() {
  for (const update of updates.take(200)) {
    // 后续图层或渲染器在这里更新自己拥有的 Cesium 对象。
    // 本管线不直接访问 Viewer、DOM 或 WebGL。
  }
  requestAnimationFrame(renderFrame);
}
```

每帧最多读取 200 条，因此输入速率高于渲染速率时内存不会无限增长。相同 `id` 在同一队列窗口内只保留最新位置，旧中间位置计入 `coalesced`。

## Worker 与 MessagePort 输入

下面示例由业务代码创建 Worker 并定义消息协议。SDK 只接收 `worker` 的标准 `message`
事件，把 `event.data` 解码为业务类型后送入已有的有界队列。

```ts
import { DataPipeline, DataPipelineMessageAdapter } from '@yanbobo/gis-sdk/core';

interface PositionUpdate {
  readonly id: string;
  readonly longitude: number;
  readonly latitude: number;
}

const pipeline = new DataPipeline<PositionUpdate>({
  keyBy: (value) => value.id,
  maxQueueItems: 2_000,
  coalesce: 'latest',
});

const worker = new Worker(new URL('./position-worker.ts', import.meta.url), { type: 'module' });
const input = new DataPipelineMessageAdapter({
  source: worker,
  pipeline,
  decode(data): PositionUpdate {
    if (
      typeof data !== 'object' ||
      data === null ||
      typeof (data as { id?: unknown }).id !== 'string'
    ) {
      throw new Error('Invalid position message.');
    }
    return data as PositionUpdate;
  },
});

input.events.on('message:rejected', ({ data, cause }) => {
  console.warn('Ignored worker message', data, cause);
});

input.start();

// 组件卸载或图层销毁时：仅移除 SDK 监听器，Worker 和管线仍由业务决定如何释放。
input.dispose();
worker.terminate();
pipeline.close();
```

`MessagePort` 也可直接作为 `source` 传入。适配器会在 `start()` 时调用其可选的
`source.start()`，因此对已启动的 Port 和 Worker 都可安全使用。

| 配置/成员      | 类型                                        | 效果                                                                                                |
| -------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `source`       | `DataPipelineMessageSource`                 | 必填；具有 `addEventListener/removeEventListener('message', ...)` 的 Worker、MessagePort 或同类对象 |
| `pipeline`     | `DataPipeline<T>`                           | 必填；解码后的值进入其合并、容量和溢出策略                                                          |
| `decode(data)` | `(unknown) => T`                            | 必填；由业务协议实现，抛出异常时当前消息记为拒绝，后续消息继续处理                                  |
| `start()`      | `void`                                      | 注册监听器；重复调用无副作用，已释放时抛出 `DATA_PIPELINE_MESSAGE_ADAPTER_DISPOSED`                 |
| `stop()`       | `void`                                      | 解绑监听器，允许随后再次 `start()`；不终止消息源                                                    |
| `dispose()`    | `void`                                      | 幂等地解绑监听器并永久关闭适配器；不关闭 `source` 或 `pipeline`                                     |
| `stats`        | `Readonly<DataPipelineMessageAdapterStats>` | 冻结快照，包含 `received`、`accepted`、`dropped`、`rejected` 与 `state`                             |

解码失败或数据管线 `push()` 抛出时，适配器触发 `message:rejected` 并继续处理后续消息。
`drop-newest` 等策略拒绝新输入时，适配器触发 `message:dropped` 并增加 `dropped`。
配置不合法时构造函数抛出 `INVALID_DATA_PIPELINE_MESSAGE_ADAPTER_CONFIG`。

## 创建参数

```ts
const pipeline = new DataPipeline({
  keyBy: (value) => value.id,
  maxQueueItems: 1_000,
  coalesce: 'latest',
  overflow: 'keep-latest',
});
```

| 参数            | 类型                                              | 默认值                                                | 效果                                                     |
| --------------- | ------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `keyBy`         | `(value: T) => string`                            | -                                                     | 必填。返回非空键，用于同对象更新合并                     |
| `maxQueueItems` | `number`                                          | `1000`                                                | 正安全整数。限制仍在等待消费的更新条数                   |
| `coalesce`      | `'none' \| 'latest'`                              | `'latest'`                                            | `latest` 用相同键的新值替换旧排队值；`none` 保留每条输入 |
| `overflow`      | `'drop-oldest' \| 'drop-newest' \| 'keep-latest'` | `latest` 时为 `'keep-latest'`，否则为 `'drop-oldest'` | 队列满时的处理策略                                       |

`keyBy` 返回空字符串、非字符串，或容量/读取上限不是正安全整数时，SDK 会抛出 `INVALID_DATA_PIPELINE_KEY`、`INVALID_DATA_PIPELINE_CONFIG` 或 `INVALID_DATA_PIPELINE_TAKE_LIMIT`。

## 方法与统计

| 成员              | 参数       | 返回值                        | 效果                                                           |
| ----------------- | ---------- | ----------------------------- | -------------------------------------------------------------- |
| `push(value)`     | 一条 `T`   | `boolean`                     | 接收/合并成功时为 `true`；`drop-newest` 丢弃新输入时为 `false` |
| `take(maxItems?)` | 正安全整数 | `readonly T[]`                | 按 FIFO 取出最多 N 条；省略时取出当前全部                      |
| `clear()`         | 无         | `void`                        | 丢弃未交付值，不计入 `dropped`                                 |
| `close()`         | 无         | `void`                        | 清空并永久关闭；重复调用无副作用                               |
| `stats`           | 无         | `Readonly<DataPipelineStats>` | 返回冻结的当前统计快照                                         |

`stats` 包含：

- `accepted`：进入处理流程的输入次数，包含合并的新值；
- `coalesced`：替换同键旧排队值的次数；
- `dropped`：容量策略丢弃的次数；
- `queued`：当前等待消费的条数；
- `taken`：已交付给消费者的条数；
- `closed`：是否已关闭。

## 溢出策略

| 策略          | 满队列时效果                                                   | 适合场景                         |
| ------------- | -------------------------------------------------------------- | -------------------------------- |
| `drop-oldest` | 删除最早排队值后写入新值                                       | 只关注最近变化，且不需要同键合并 |
| `drop-newest` | 保留现有队列，拒绝当前输入                                     | 先到数据优先，或上游可自行重试   |
| `keep-latest` | 仅与 `latest` 合并配合；同键先替换，其他新键满队列时淘汰最早值 | 动态位置、状态或传感器读数       |

`keep-latest` 与 `coalesce: 'none'` 组合无意义，创建时会抛出 `INVALID_DATA_PIPELINE_CONFIG`。

## 生命周期与当前边界

`close()` 后的 `push()`、`take()` 和 `clear()` 都会抛出 `DATA_PIPELINE_CLOSED`。在地图或图层拥有此对象时，应在其销毁流程中调用 `close()`，避免遗留未交付的业务数据。

本 alpha 版本提供有界输入、合并、批量读取、统计快照，以及 Worker/MessagePort 的通用消息监听与转发。以下能力尚未发布：

- Worker 池、主线程降级、CSP / bundler Worker URL 适配；
- WebSocket、SSE、CZML、二进制协议、GeoJSON 等专用协议 Adapter；
- schema 校验、坐标/单位/时间标准化、时间排序和轨迹窗口；
- Cesium Entity、Collection、Primitive、Model 或 3D Tiles 动态渲染器；
- LOD、帧预算调度、诊断面板、性能阈值和公开压测结果。

因此它不承诺任何数据规模或帧率。生产接入前应根据实际消息协议、设备数量、更新频率和目标浏览器建立压力测试。
