# 帧预算调度

`DataPipelineFrameScheduler<T>` 把 `DataPipeline<T>` 的消费限制在每帧固定预算内。它不主动轮询；业务在有新值成功入队时调用 `request()`。重复请求会合并成同一个动画帧，避免每条消息触发一次渲染。

## 最小示例

```ts
import {
  DataPipeline,
  DataPipelineFrameScheduler,
  DataPipelineMessageAdapter,
} from '@yanbobo/gis-sdk/core';

const updates = new DataPipeline<PositionUpdate>({
  keyBy: (value) => value.id,
  maxQueueItems: 2_000,
  coalesce: 'latest',
});
const scheduler = new DataPipelineFrameScheduler({
  pipeline: updates,
  maxItemsPerFrame: 200,
  onBatch(values) {
    values.forEach(applyPositionUpdate);
    map.raw.viewer.scene.requestRender();
  },
});
const input = new DataPipelineMessageAdapter({ source: worker, pipeline: updates, decode });
input.events.on('message:accepted', () => scheduler.request());
input.start();

// 调度器只取消它自己的帧回调，不关闭 Worker、管线或 Cesium 对象。
scheduler.dispose();
input.dispose();
worker.terminate();
updates.close();
```

## 配置与方法

| 配置/成员          | 类型                                        | 默认值/效果                                                          |
| ------------------ | ------------------------------------------- | -------------------------------------------------------------------- |
| `pipeline`         | `DataPipeline<T>`                           | 必填；每帧从调用方拥有的管线读取一批数据                             |
| `onBatch(values)`  | `(readonly T[]) => void`                    | 必填；在主线程处理已取出的批次，通常在这里调用 Cesium 公共 API       |
| `maxItemsPerFrame` | `number`                                    | `200`；正安全整数，限制单帧交给业务回调的最大条数                    |
| `clock`            | `DataPipelineFrameClock`                    | 浏览器动画帧；可为测试、SSR 或宿主环境提供 `request/cancel` 时钟     |
| `request()`        | `boolean`                                   | 注册一帧返回 `true`；已有挂起帧时返回 `false` 且不会重复注册         |
| `cancel()`         | `boolean`                                   | 取消尚未执行的帧，不读取管线数据；不存在挂起帧时返回 `false`         |
| `dispose()`        | `void`                                      | 幂等取消挂起帧并永久关闭调度器；不关闭 `pipeline`、Worker 或渲染对象 |
| `stats`            | `Readonly<DataPipelineFrameSchedulerStats>` | 冻结快照，含请求合并、实际帧数、已消费条数和失败次数                 |

## 事件与处理规则

| 事件              | 何时触发                                 | 载荷                 |
| ----------------- | ---------------------------------------- | -------------------- |
| `state:changed`   | `idle`、`scheduled`、`disposed` 之间变化 | `previous`、`state`  |
| `frame:completed` | 一帧成功交付非空批次                     | `count`、`timestamp` |
| `frame:failed`    | 管线读取或 `onBatch()` 失败              | `cause`、`timestamp` |

一帧成功处理后，若管线仍有值，调度器会自动请求下一帧；队列清空后不会空转。`onBatch()` 发生异常时触发 `frame:failed`，**不会**自动继续下一帧。批次在调用 `onBatch()` 前已从管线取出，不是可回滚事务；如需重试，业务应在失败处理内重新入队，修复渲染状态后再调用 `request()`。

已释放的调度器调用 `request()` 会抛出 `DATA_PIPELINE_FRAME_SCHEDULER_DISPOSED`。没有浏览器动画帧且未提供 `clock` 时会抛出可重试的 `DATA_PIPELINE_FRAME_SCHEDULER_UNAVAILABLE`；无效配置会抛出 `INVALID_DATA_PIPELINE_FRAME_SCHEDULER_CONFIG`。

## 为什么需要它

它解决的是“输入消息速率”和“主线程渲染速率”不一致的问题：每帧最多交付 `maxItemsPerFrame` 条，其余留在有界管线中等待下一帧。容量和合并策略由[有界数据管线](./data-pipeline-core.md)决定；输入监听与业务协议由[Worker / MessagePort 输入](./data-pipeline-message-input.md)处理。
