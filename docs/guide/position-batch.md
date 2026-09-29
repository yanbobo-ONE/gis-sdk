# 位置批量归一化

高频位置数据在进入渲染层之前需要做两件事：**把无效坐标挡在外面**，以及**不要为同一对象堆积历史位置**。`normalizePositions` 用一个纯函数完成这两件事，输出可以直接渲染或跨线程转移的批量。

```ts
import { normalizePositions } from '@yanbobo/gis-sdk/core';

const batch = normalizePositions(samples, { mode: 'latest' });

batch.ids; // ['sat-1', 'sat-2', ...]
batch.positions; // Float64Array，每 3 个值为一组的经纬高
batch.timestamps; // Float64Array，与 ids 下标一致
batch.received; // 收到的样本数
batch.invalid; // 被丢弃的样本数
```

## 两种模式

| `mode`      | 行为                                                               |
| ----------- | ------------------------------------------------------------------ |
| `'latest'`  | 同一 id 只保留时间戳最新的一条（默认）；被覆盖的样本计入 `invalid` |
| `'history'` | 保留全部有效样本，用于轨迹与回放                                   |

同一个 id 时间戳相同时，后到的样本生效。

## 为什么输出 Float64Array

`positions` 与 `timestamps` 是**转移友好**的类型化数组：在 Worker 里可以零拷贝地把结果传回主线程。

```ts
// positions.worker.ts
import { normalizePositions } from '@yanbobo/gis-sdk/core';

self.onmessage = (event) => {
  const batch = normalizePositions(event.data.samples, { mode: 'latest' });
  postMessage(batch, { transfer: [batch.positions.buffer, batch.timestamps.buffer] });
};
```

这样传输的是原始字节而不是对象图，既避免把业务对象、响应式代理或渲染对象跨线程结构化克隆，也避免大数组被复制两份。

## 被丢弃的样本

以下情况计入 `invalid`，不会让整批失败：

- `id` 不是非空字符串；
- 经纬高或时间戳不是有限数；
- 经度超出 ±180、纬度超出 ±90；
- `'latest'` 模式下被更新的同 id 样本覆盖。

整批失败（抛 `INVALID_REALTIME_INPUT`）只发生在：输入不是数组、样本数超过上限（默认 50000）、策略取值不受支持。

## 与其它实时模块的配合

```text
传输 → 会话门禁 → 位置归一化 → 水位线 → 渲染
```

- **归一化负责"数据本身是否可用"**：坐标范围、去重、类型化（本页）；
- **水位线负责"时间是否安全"**：乱序、追赶、断流（见[实时水位线](./realtime-waterline.md)）；
- **会话门禁负责"这条消息该不该收"**（见[会话门禁与重同步](./realtime-session.md)）。

三者都是纯数据层，可以单独使用，也可以按上面的顺序串起来。
