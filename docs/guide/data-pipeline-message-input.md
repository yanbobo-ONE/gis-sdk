# Worker / MessagePort 输入

`DataPipelineMessageAdapter<T>` 将 Worker、`MessagePort` 或同类标准消息源接入已有 `DataPipeline<T>`。它只拥有自身注册的 `message` 监听器；消息源、协议和渲染资源仍由调用方拥有。

## Worker 最小示例

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

// 仅移除 SDK 监听器；Worker 与管线是否释放由业务决定。
input.dispose();
worker.terminate();
pipeline.close();
```

`MessagePort` 也可直接作为 `source`。适配器会在 `start()` 时调用可选的 `source.start()`，所以已启动的 Port 和 Worker 都可安全使用。

## 配置与方法

| 配置/成员      | 类型                                        | 效果                                                                                                |
| -------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `source`       | `DataPipelineMessageSource`                 | 必填；具有 `addEventListener/removeEventListener('message', ...)` 的 Worker、MessagePort 或同类对象 |
| `pipeline`     | `DataPipeline<T>`                           | 必填；解码后的值进入其合并、容量和溢出策略                                                          |
| `decode(data)` | `(unknown) => T`                            | 必填；由业务协议实现，抛出异常时当前消息记为拒绝，后续消息继续处理                                  |
| `start()`      | `void`                                      | 注册监听器；重复调用无副作用，已释放时抛出 `DATA_PIPELINE_MESSAGE_ADAPTER_DISPOSED`                 |
| `stop()`       | `void`                                      | 解绑监听器，允许随后再次 `start()`；不终止消息源                                                    |
| `dispose()`    | `void`                                      | 幂等解绑并永久关闭适配器；不关闭 `source` 或 `pipeline`                                             |
| `stats`        | `Readonly<DataPipelineMessageAdapterStats>` | 冻结快照，含 `received`、`accepted`、`dropped`、`rejected` 与 `state`                               |

## 事件与运行效果

| 事件               | 何时触发                               | 常见用途                   |
| ------------------ | -------------------------------------- | -------------------------- |
| `state:changed`    | `idle`、`running`、`disposed` 之间变化 | 更新宿主状态或排查生命周期 |
| `message:accepted` | 解码成功且值已进入管线                 | 调用帧调度器的 `request()` |
| `message:dropped`  | 解码成功但被满队列策略拒绝             | 记录上游过载或选择降采样   |
| `message:rejected` | `decode()` 或 `pipeline.push()` 抛出   | 记录原始数据和失败原因     |

解码失败或写入失败不会停止适配器；后续消息仍继续处理。构造配置不合法时会抛出 `INVALID_DATA_PIPELINE_MESSAGE_ADAPTER_CONFIG`。若 `source.start()` 本身失败，`start()` 会清理已注册监听器并抛出同一错误码（可重试）。

## 与帧预算调度配合

不要在每条 `message` 中直接渲染。订阅成功接入事件并请求一帧，由[帧预算调度](./data-pipeline-frame-scheduler.md)合并多次请求：

```ts
input.events.on('message:accepted', () => scheduler.request());
input.start();
```
