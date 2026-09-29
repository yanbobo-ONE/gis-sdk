# 实时数据导航

实时数据能力按职责拆成三个可独立使用的对象。它们不依赖 Vue、React 或 Cesium，业务可以把最终批次应用到任意渲染对象。

| 你要解决的问题                          | 使用对象                                             | 页面                                                          | 负责什么                                             |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- |
| 高频更新不能无限堆积                    | `DataPipeline<T>`                                    | [有界数据管线](./data-pipeline-core.md)                       | 同键合并、容量限制、FIFO 批量读取与统计              |
| 将 Worker 或 `MessagePort` 消息接入队列 | `DataPipelineMessageAdapter<T>`                      | [Worker / MessagePort 输入](./data-pipeline-message-input.md) | 监听、业务解码、转发、输入统计与解绑                 |
| 限制单帧处理量                          | `DataPipelineFrameScheduler<T>`                      | [帧预算调度](./data-pipeline-frame-scheduler.md)              | 请求合并、每帧有界消费、取消与帧统计                 |
| 乱序样本导致实体倒退                    | `RealtimeWaterline<T>`                               | [实时水位线与时间戳守卫](./realtime-waterline.md)             | 按仿真时间发布、精确对象共同覆盖、追赶倍率与断流状态 |
| 旧会话迟到包夺回状态、序列断档          | `RealtimeSessionGate<T>`、`RealtimeResyncController` | [会话门禁与重同步](./realtime-session.md)                     | 会话切换判定、重复快照请求合并与有界重试             |
| 高频位置去重与无效坐标过滤              | `normalizePositions()`                               | [位置批量归一化](./position-batch.md)                         | 校验坐标、按 id 合并最新、输出可转移的 Float64Array  |

## 推荐组合

```ts
import {
  DataPipeline,
  DataPipelineFrameScheduler,
  DataPipelineMessageAdapter,
} from '@yanbobo/gis-sdk/core';

const pipeline = new DataPipeline<PositionUpdate>({
  keyBy: (value) => value.id,
  maxQueueItems: 2_000,
  coalesce: 'latest',
});
const scheduler = new DataPipelineFrameScheduler({
  pipeline,
  maxItemsPerFrame: 200,
  onBatch(values) {
    values.forEach(applyPositionUpdate); // 业务更新自己拥有的 Cesium 对象
    map.raw.viewer.scene.requestRender();
  },
});
const input = new DataPipelineMessageAdapter({ source: worker, pipeline, decode });
input.events.on('message:accepted', () => scheduler.request());
input.start();
```

页面、图层或组件销毁时，按资源拥有关系执行：`scheduler.dispose()`、`input.dispose()`、`worker.terminate()`、`pipeline.close()`。SDK 只管理自己的队列、监听器和帧回调。

## 选择顺序

1. 先阅读[有界数据管线](./data-pipeline-core.md)，确定合并键、容量和溢出策略。
2. 输入来自 Worker 或 `MessagePort` 时，再接入[消息输入适配器](./data-pipeline-message-input.md)。普通 WebSocket、SSE 或 HTTP 回调可直接调用 `pipeline.push()`。
3. 需要避免每条消息直接渲染时，再添加[帧预算调度器](./data-pipeline-frame-scheduler.md)。

## 当前边界

当前 alpha 提供通用输入与消费基础设施，不包含固定业务协议或 Cesium 动态渲染器。Worker 池、WebSocket/SSE/CZML/二进制专用 Adapter、schema 校验、坐标/时间标准化、动态 Entity/Primitive/Model 渲染、自动 LOD 和公开压测结果均尚未发布。完整状态见[功能状态与路线图](./capability-status.md)。
