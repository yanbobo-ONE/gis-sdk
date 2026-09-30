# Worker 内执行分析 Worker 执行接口

重计算可以搬到 Worker 里跑：SDK 提供**协议 + 客户端 + 宿主**三件套，主线程通过 `postMessage` 转发分析请求，Worker 侧用同一份 `createAnalysisController()` 执行。协议是 SDK 定义的，但端口是可注入的，因此浏览器 Worker、Node `worker_threads` 包装、原生宿主都能用。

```ts
// main.ts —— 主线程
import { analysisTools, createAnalysisWorkerClient } from '@yanbobo/gis-sdk/core';

const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
const analysis = createAnalysisWorkerClient(
  {
    postMessage: (message) => worker.postMessage(message),
    subscribe: (listener) => {
      const handler = (event: MessageEvent) => listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
  },
  { descriptors: analysisTools, timeoutMs: 15_000 },
);

const hull = await analysis.run('convex-hull', { points: points }); // 与 map.analysis 同形
analysis.dispose();
```

```ts
// analysis.worker.ts —— Worker 侧
import { createAnalysisController, createAnalysisWorkerHost } from '@yanbobo/gis-sdk/core';

createAnalysisWorkerHost(
  {
    postMessage: (message) => self.postMessage(message),
    subscribe: (listener) => {
      const handler = (event: MessageEvent) => listener(event.data);
      self.addEventListener('message', handler);
      return () => self.removeEventListener('message', handler);
    },
  },
  {
    controller: createAnalysisController({
      // 只有需要地形高度的工具才会用到它
      sample: (points) => Promise.resolve(heightField.lookup(points)),
    }),
  },
);
```

## 协议

| 消息  | 形状                                                                     |
| ----- | ------------------------------------------------------------------------ |
| 请求  | `{ kind: 'gis-sdk-analysis:request', id, tool, input }`                  |
| 取消  | `{ kind: 'gis-sdk-analysis:cancel', id }`                                |
| 成功  | `{ kind: 'gis-sdk-analysis:response', id, ok: true, result }`            |
| 失败  | `{ kind: 'gis-sdk-analysis:response', id, ok: false, code, message, retryable }` |

`createAnalysisWorkerRequest()` / `createAnalysisWorkerCancel()` / `toAnalysisWorkerSuccess()` / `toAnalysisWorkerFailure()` / `fromAnalysisWorkerFailure()` 是构造与还原这四类消息的纯函数，`isAnalysisWorkerRequest()` 等守卫同样导出——业务要在自己的 Worker 里手写协议时可以直接用。

失败响应会把 `GisError` 的 `code`、`message`、`retryable` 一起带过去，主线程还原成同样的 `GisError`，因此**按代码分支的业务逻辑在跨线程后仍然成立**。未知代码统一降级为 `ANALYSIS_WORKER_FAILED`。

## 语义

- **请求按 id 匹配**：同一通道上可以同时有多条在途请求；响应乱序返回也不会串台。
- **取消双向生效**：`run(..., { signal })` 中止时主线程会发出取消消息并立即以 `ANALYSIS_ABORTED` 拒绝；Worker 侧收到取消后不再回传结果（已在执行的任务会跑完，只是结果丢弃）。
- **超时兜底**：默认 30 秒（`timeoutMs`），超时以可重试的 `ANALYSIS_WORKER_TIMEOUT` 拒绝并发出一条取消消息——避免 Worker 卡住时主线程无限等待。
- **串行执行**：Worker 侧按到达顺序执行请求。分析工具是纯计算，串行既避免争抢 Worker 单线程，也让取消语义更容易推理。
- **销毁**：客户端 `dispose()` 取消订阅并以 `ANALYSIS_WORKER_DISPOSED` 拒绝全部在途请求（`run()` 是异步方法，销毁后的拒绝是 Promise 拒绝而不是同步抛出）；宿主 `dispose()` 停止处理后续请求。

## 哪些工具适合放进 Worker

| 工具                                                                                     | 说明                                                       |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `distance` / `area` / `bearing` / `bbox` / `center-of-mass` / `point-in-polygon` / `points-in-polygon` / `transform` | 纯计算，直接搬进 Worker 即可                               |
| `convex-hull` / `simplify`                                                               | 批量点与长轨迹的重计算，正是搬进 Worker 的主要收益来源     |
| `terrain-sample` / `line-of-sight` / `viewshed` / `slope-aspect` / `surface-distance`    | 需要地形采样端口；Worker 里没有 Cesium，要自带高程数据     |

Worker 里**没有** `map.terrain.sample()`：需要地形高度的工具要么让 Worker 自带高程数据实现 `AnalysisTerrainPort`，要么就留在主线程跑。不带端口时这些工具会以可重试的 `ANALYSIS_TERRAIN_UNAVAILABLE` 失败——这是"Worker 里没有地形采样器"这一事实的诚实上报，而不是缺陷。

大数组建议先用 `normalizePositions()` 转成可转移的 `Float64Array` 再做结构化克隆，或直接在 `postMessage` 的转移列表里传入。

## 当前边界

- **不做 Worker 池**：这里是一个端口的客户端 / 宿主对。要跑多条并行任务，业务自己起多个 Worker、各自持有一个客户端即可；调度策略（按工具路由、排队上限）由业务决定。
- **不跨帧续跑**：一次请求就是一个 Promise；长任务没有进度上报。
- **不做共享内存**：`SharedArrayBuffer` 需要页面开启跨源隔离，SDK 不假设这个前提。
