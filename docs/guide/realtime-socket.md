# 实时链路 RealtimeSocketClient

`RealtimeSocketClient` 管**一条长连接的链路**：连接、按上限退避的重连、心跳存活判断、按类型路由消息，以及连接状态与统计。它不知道业务协议：报文怎么解、心跳长什么样都由调用方注入。

```ts
import { RealtimeSocketClient, RealtimeWaterline } from '@yanbobo/gis-sdk/core';

const socket = new RealtimeSocketClient({
  url: () => `wss://example.com/realtime?ticket=${String(await ticket())}`,
  // 协议解析由业务提供；省略时按 JSON 解析并要求 type 字段
  decode: (raw) => {
    const frame = decodeBinaryFrame(raw);
    return { type: frame.channel, payload: frame.body };
  },
  heartbeat: { intervalMs: 15_000, timeoutMs: 5_000, message: { type: 'ping' }, isPong: (m) => m.type === 'pong' },
});

socket.subscribe('telemetry', (message) => waterline.push(message.payload));
socket.subscribe('*', (message) => counters.count(message.type));
socket.onState((state) => badge.dataset.state = state);
socket.onError((error) => console.warn(error.code, error.message));

socket.connect();
socket.stats; // { state, messages, decodeFailures, retries, totalRetries, lastMessageAt }
```

## 状态与重连

| 状态           | 含义                                                         |
| -------------- | ------------------------------------------------------------ |
| `idle`         | 尚未连接                                                     |
| `connecting`   | 正在建立连接                                                 |
| `open`         | 连接可用，可以 `send()`                                      |
| `reconnecting` | 链路断开，正在按退避等待下一次连接                           |
| `closed`       | 主动关闭、重试耗尽或实例销毁；`connect()` 可以重新开始       |

重连退避是参考实现验证过的口径：延迟从 `retryDelayMs`（默认 1000 毫秒）开始按 `2^n` 增长，封顶 `maxRetryDelayMs`（默认 30000 毫秒），每次再乘 `0.8–1.2` 的抖动——同一时刻断开的多条连接不会挤在同一毫秒重连。重试次数上限默认 8（`maxRetries`），连接成功即清零，`stats.totalRetries` 保留累计值。

心跳由配置驱动：按 `intervalMs` 发送 `message`，`timeoutMs` 内没等到 `isPong` 承认的消息就按链路丢失处理，走同一条重连路径。心跳协议不是 SDK 的假设——业务可以在 `isPong` 里判任意格式。

## 边界与容错

- **不缓存待发消息**：连接未建立时 `send()` 抛 `REALTIME_SOCKET_NOT_OPEN`（可重试），而不是把可能过期的业务指令排在队列里。
- **报文问题不等于链路问题**：解码失败（默认解码下的非法 JSON、缺 `type`）计入 `stats.decodeFailures` 并通过 `onError` 上报 `INVALID_REALTIME_INPUT`，**连接保持**。
- **订阅方异常被隔离**：某个订阅者抛错不会影响其它订阅者，也不会断开连接；异常以 `REALTIME_SOCKET_FAILED` 上报。
- **迟到事件被丢弃**：断开后旧连接可能还会抛出事件，客户端用实例比对把它们丢掉，不会把状态改回去。
- **`close()` 与 `dispose()` 不同**：`close()` 主动断开且不再自动重连，之后可以再次 `connect()`；`dispose()` 断开并清空订阅，之后的任何操作都抛 `REALTIME_SOCKET_DISPOSED`。
- **地址可以是函数**：每次重连都重新求值，便于换取一次性票据。

## 跨终端

核心只要求一个**结构化**的 socket 形状（`send` / `close` / `readyState` 与四个事件回调），不依赖 DOM 类型：

- 浏览器与 Node 22 自带全局 `WebSocket`，不传 `factory` 即可；
- 原生宿主、专有协议或测试替身通过 `factory: (url, protocols) => socket` 注入自己的实现；
- 宿主完全没有 WebSocket 时抛 `REALTIME_SOCKET_UNSUPPORTED`，并提示传 `factory`。

SSE、MQTT、自定义二进制协议都可以实现同一个形状后接入，SDK 不做协议绑定。

## 与相邻模块的分工

一条完整的实时链路按职责拆成四层，每层都可以单独使用：

| 模块                            | 负责                                                     |
| ------------------------------- | -------------------------------------------------------- |
| `RealtimeSocketClient`          | 链路：连接、重连、心跳、按类型路由、链路统计             |
| `DataPipeline`                  | 缓冲：有界队列、最新值合并、溢出策略、按帧消费           |
| `RealtimeWaterline`             | 时间：乱序样本按时间释放、精确对象共同覆盖、双阈值追赶   |
| `RealtimeSessionGate` / `Resync` | 会话：旧会话迟到包丢弃、序列断档后请求快照并等待恢复     |

典型接法：`socket.subscribe(type, (m) => pipeline.push(m.payload))` 进入缓冲，按帧取出后喂给水位线，跨会话切换时用门禁挡掉旧会话的包。

## 当前边界

- **不做协议解码**：WebSocket 之外的协议、二进制帧格式、字段校验都在业务侧；SDK 只提供 `decode` 钩子与错误隔离。
- **不做重连后的状态补偿**：断线期间丢了哪些数据、要不要补历史由业务决定；序列断档可以交给 `RealtimeResyncController` 请求快照。
- **不做 Worker 里的连接**：Worker 池与专用动态输入 Adapter 仍未发布；在 Worker 中可以直接使用本客户端（Node/Worker 都有全局 `WebSocket`）。
