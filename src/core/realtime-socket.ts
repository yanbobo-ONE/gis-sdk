import { GisError } from './errors.js';
import type { Unsubscribe } from './event-hub.js';

/** 连接状态。 */
export type RealtimeSocketState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * 解码后的消息。
 *
 * SDK 只要求一个 `type` 字段用于路由，其余结构由业务决定（`payload` 可以是任意值）。
 */
export interface RealtimeSocketMessage {
  /** 消息类型，用于按类型订阅。 */
  readonly type: string;
  /** 业务载荷。 */
  readonly payload: unknown;
}

/**
 * 连接的最小子集。
 *
 * 只声明 SDK 用到的成员，因此浏览器 `WebSocket`、Node 的全局 `WebSocket`、原生宿主的
 * socket 实现都能直接当作端口使用，无需 SDK 依赖任何 DOM 类型。
 */
export interface RealtimeSocketLike {
  /** 0=CONNECTING、1=OPEN、2=CLOSING、3=CLOSED，与 `WebSocket.readyState` 一致。 */
  readonly readyState: number;
  /** 发送一条已序列化的报文。 */
  send(data: string): void;
  /** 关闭连接。 */
  close(): void;
  /** 连接建立回调；由客户端赋值，实现方只需在建立后调用它。 */
  onopen: ((event?: unknown) => void) | null;
  /** 连接关闭回调。 */
  onclose: ((event?: unknown) => void) | null;
  /** 连接错误回调。 */
  onerror: ((event?: unknown) => void) | null;
  /** 收到报文回调；`event.data` 是原始载荷（字符串、二进制或已解析对象）。 */
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

/** 心跳协议；SDK 不假设具体格式，只按注入的判定函数识别回应。 */
export interface RealtimeSocketHeartbeat {
  /** 发送心跳的间隔，单位为毫秒。 */
  readonly intervalMs: number;
  /** 发出心跳后等待回应的超时，单位为毫秒；超时按链路丢失处理。 */
  readonly timeoutMs: number;
  /** 心跳报文内容。 */
  readonly message: unknown;
  /** 判断一条消息是否为心跳回应。 */
  readonly isPong: (message: RealtimeSocketMessage) => boolean;
}

/** 实时连接配置。 */
export interface RealtimeSocketOptions {
  /** 连接地址；传函数时每次重连都会重新求值（便于换取一次性票据）。 */
  readonly url: string | (() => string);
  /** 子协议。 */
  readonly protocols?: string | readonly string[];
  /** 最大重连次数，默认 8；用尽后进入 `closed`。 */
  readonly maxRetries?: number;
  /** 首次重连延迟，单位为毫秒，默认 1000。 */
  readonly retryDelayMs?: number;
  /** 重连延迟上限，单位为毫秒，默认 30000。 */
  readonly maxRetryDelayMs?: number;
  /**
   * 把原始报文解成 {@link RealtimeSocketMessage}。
   *
   * 省略时按 JSON 解析并要求 `type` 字段。解码抛错只上报，不中断连接。
   */
  readonly decode?: (data: unknown) => RealtimeSocketMessage;
  /** 心跳配置；省略时不发心跳，也不做过期判断。 */
  readonly heartbeat?: RealtimeSocketHeartbeat;
  /**
   * 建立连接的工厂；省略时使用全局 `WebSocket`。
   *
   * 其它终端（原生宿主、测试替身）通过它注入自己的实现。
   */
  readonly factory?: (url: string, protocols?: readonly string[]) => RealtimeSocketLike;
  /** 抖动随机源，默认 `Math.random`；注入后重连延迟可确定性测试。 */
  readonly random?: () => number;
}

/** 连接运行统计。 */
export interface RealtimeSocketStats {
  /** 当前状态。 */
  readonly state: RealtimeSocketState;
  /** 成功解码并路由的消息数。 */
  readonly messages: number;
  /** 解码失败次数（消息本身非法，连接保持）。 */
  readonly decodeFailures: number;
  /** 累计重连次数；连接成功后清零，`totalRetries` 记录总数。 */
  readonly retries: number;
  /** 累计重连总次数。 */
  readonly totalRetries: number;
  /** 收到最后一条消息的时刻（`Date.now()` 毫秒），没有则为 `undefined`。 */
  readonly lastMessageAt: number | undefined;
}

/** 每条消息都订阅的通配类型。 */
export const REALTIME_SOCKET_WILDCARD = '*';

const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

/** 默认解码：JSON 文本，且必须带字符串 `type`。 */
function defaultDecode(data: unknown): RealtimeSocketMessage {
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch (cause: unknown) {
      // 解析失败是报文问题而不是链路问题：统一报成输入错误，便于调用方区分。
      throw new GisError('Realtime message is not valid JSON.', {
        code: 'INVALID_REALTIME_INPUT',
        module: 'realtime',
        operation: 'decode',
        cause,
      });
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new GisError('Realtime message must decode to an object.', {
      code: 'INVALID_REALTIME_INPUT',
      module: 'realtime',
      operation: 'decode',
    });
  }
  const { type, payload } = parsed as { type?: unknown; payload?: unknown };
  if (typeof type !== 'string' || type.length === 0) {
    throw new GisError('Realtime message must have a non-empty string type.', {
      code: 'INVALID_REALTIME_INPUT',
      module: 'realtime',
      operation: 'decode',
    });
  }
  return { type, payload };
}

function socketError(
  message: string,
  code: 'INVALID_REALTIME_SOCKET_CONFIG' | 'REALTIME_SOCKET_NOT_OPEN' | 'REALTIME_SOCKET_DISPOSED' | 'REALTIME_SOCKET_UNSUPPORTED',
  operation: string,
  retryable = false,
): GisError {
  return new GisError(message, { code, module: 'realtime', operation, retryable });
}

/**
 * 带自动重连与心跳的实时连接客户端。
 *
 * 一个实例管理一条连接：订阅与连接生命周期分离，`close()` 主动断开且不重连，
 * `dispose()` 之后不再接受任何操作。连接状态、消息统计与错误都通过订阅暴露，
 * 因此同一条链路既能接 `DataPipeline`，也能接业务自己的缓冲。
 *
 * 与相邻模块的分工：本客户端只管**链路**（连接、重连、心跳、按类型路由）；乱序与追赶交给
 * `RealtimeWaterline`，会话切换交给 `RealtimeSessionGate`，缓冲与按帧消费交给 `DataPipeline`。
 */
export class RealtimeSocketClient {
  private socket: RealtimeSocketLike | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | undefined;
  private currentState: RealtimeSocketState = 'idle';
  private retries = 0;
  private totalRetries = 0;
  private messages = 0;
  private decodeFailures = 0;
  private lastMessageAt: number | undefined;
  private manualClose = false;
  private disposed = false;

  private readonly messageHandlers = new Map<string, Set<(message: RealtimeSocketMessage) => void>>();
  private readonly stateHandlers = new Set<(state: RealtimeSocketState) => void>();
  private readonly errorHandlers = new Set<(error: GisError) => void>();
  private readonly socketFactory: (url: string, protocols?: readonly string[]) => RealtimeSocketLike;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;

  /**
   * @param options - 地址、重连退避、心跳、解码与连接工厂。
   * @throws `INVALID_REALTIME_SOCKET_CONFIG` 配置非法（地址不是 ws/wss、重试上限超过 32 等）。
   */
  constructor(private readonly options: RealtimeSocketOptions) {
    const factory = options.factory ?? defaultSocketFactory();
    this.socketFactory = factory;
    this.random = options.random ?? Math.random;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 32) {
      throw socketError(
        'Realtime socket maxRetries must be an integer between 0 and 32.',
        'INVALID_REALTIME_SOCKET_CONFIG',
        'configure',
      );
    }
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (!Number.isFinite(retryDelayMs) || retryDelayMs <= 0) {
      throw socketError(
        'Realtime socket retryDelayMs must be a positive finite number.',
        'INVALID_REALTIME_SOCKET_CONFIG',
        'configure',
      );
    }
    if (!Number.isFinite(maxRetryDelayMs) || maxRetryDelayMs < retryDelayMs) {
      throw socketError(
        'Realtime socket maxRetryDelayMs must be a finite number not smaller than retryDelayMs.',
        'INVALID_REALTIME_SOCKET_CONFIG',
        'configure',
      );
    }
    const heartbeat = options.heartbeat;
    if (heartbeat) {
      if (!Number.isFinite(heartbeat.intervalMs) || heartbeat.intervalMs <= 0) {
        throw socketError(
          'Realtime heartbeat intervalMs must be a positive finite number.',
          'INVALID_REALTIME_SOCKET_CONFIG',
          'configure',
        );
      }
      if (!Number.isFinite(heartbeat.timeoutMs) || heartbeat.timeoutMs <= 0) {
        throw socketError(
          'Realtime heartbeat timeoutMs must be a positive finite number.',
          'INVALID_REALTIME_SOCKET_CONFIG',
          'configure',
        );
      }
    }
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
  }

  /** 当前连接状态。 */
  get state(): RealtimeSocketState {
    return this.currentState;
  }

  /** 运行统计快照；读取不改变状态。 */
  get stats(): RealtimeSocketStats {
    return {
      state: this.currentState,
      messages: this.messages,
      decodeFailures: this.decodeFailures,
      retries: this.retries,
      totalRetries: this.totalRetries,
      lastMessageAt: this.lastMessageAt,
    };
  }

  /**
   * 建立连接。
   *
   * 重复调用不会新建连接；`close()` 之后可以再次连接，并重新计重连次数。
   *
   * @throws `REALTIME_SOCKET_DISPOSED` 实例已销毁。
   */
  connect(): void {
    this.assertUsable('connect');
    if (this.socket || this.retryTimer) {
      return;
    }
    this.manualClose = false;
    this.retries = 0;
    this.open();
  }

  /**
   * 发送一条消息。
   *
   * 只在连接已建立时发送：不缓存可能过期的业务指令。
   *
   * @param data - 字符串原样发送，其它值按 JSON 序列化。
   * @throws `REALTIME_SOCKET_NOT_OPEN` 连接尚未建立。
   */
  send(data: unknown): void {
    this.assertUsable('send');
    if (this.socket?.readyState !== 1) {
      throw socketError('Realtime socket is not open.', 'REALTIME_SOCKET_NOT_OPEN', 'send', true);
    }
    this.socket.send(typeof data === 'string' ? data : JSON.stringify(data));
  }

  /**
   * 按消息类型订阅；类型 {@link REALTIME_SOCKET_WILDCARD} 表示接收全部消息。
   *
   * @param type - 消息类型。
   * @param handler - 处理函数；抛错会被隔离并作为错误上报，不影响其它订阅者。
   * @returns 取消订阅函数。
   */
  subscribe(type: string, handler: (message: RealtimeSocketMessage) => void): Unsubscribe {
    const handlers = this.messageHandlers.get(type) ?? new Set<(message: RealtimeSocketMessage) => void>();
    handlers.add(handler);
    this.messageHandlers.set(type, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.messageHandlers.delete(type);
      }
    };
  }

  /**
   * 订阅连接状态，订阅时会立即收到当前状态。
   *
   * @param handler - 状态处理函数。
   * @returns 取消订阅函数。
   */
  onState(handler: (state: RealtimeSocketState) => void): Unsubscribe {
    this.stateHandlers.add(handler);
    handler(this.currentState);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  /**
   * 订阅链路错误（连接失败、解码失败、订阅者异常）。
   *
   * @param handler - 错误处理函数。
   * @returns 取消订阅函数。
   */
  onError(handler: (error: GisError) => void): Unsubscribe {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /** 主动断开且不重连；之后可以再次 `connect()`。 */
  close(): void {
    this.manualClose = true;
    this.clearRetryTimer();
    this.clearHeartbeat();
    this.detach();
    this.changeState('closed');
  }

  /** 断开并移除全部订阅；之后任何操作都会抛 `REALTIME_SOCKET_DISPOSED`。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.close();
    this.messageHandlers.clear();
    this.stateHandlers.clear();
    this.errorHandlers.clear();
  }

  private open(): void {
    if (this.manualClose || this.disposed) {
      return;
    }
    this.changeState('connecting');
    try {
      const url = typeof this.options.url === 'function' ? this.options.url() : this.options.url;
      if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) {
        throw socketError(
          'Realtime socket url must be a ws:// or wss:// address.',
          'INVALID_REALTIME_SOCKET_CONFIG',
          'connect',
        );
      }
      const protocols =
        this.options.protocols === undefined
          ? undefined
          : typeof this.options.protocols === 'string'
            ? [this.options.protocols]
            : [...this.options.protocols];
      const socket = this.socketFactory(url, protocols);
      this.socket = socket;
      socket.onopen = () => {
        // 迟到的旧连接事件直接丢弃，避免半开连接把状态改回去。
        if (this.socket !== socket) {
          return;
        }
        this.retries = 0;
        this.changeState('open');
        this.scheduleHeartbeat();
      };
      socket.onclose = () => {
        if (this.socket === socket) {
          this.lost();
        }
      };
      socket.onerror = () => {
        if (this.socket === socket) {
          this.lost(new Error('Realtime socket connection failed.'));
        }
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) {
          return;
        }
        this.handleMessage(event.data);
      };
    } catch (cause: unknown) {
      if (cause instanceof GisError && cause.code === 'INVALID_REALTIME_SOCKET_CONFIG') {
        this.detach();
        this.changeState('closed');
        this.report(cause);
        return;
      }
      this.lost(cause);
    }
  }

  private handleMessage(data: unknown): void {
    const decode = this.options.decode ?? defaultDecode;
    let message: RealtimeSocketMessage;
    try {
      message = decode(data);
    } catch (cause: unknown) {
      this.decodeFailures += 1;
      this.report(cause);
      return;
    }
    this.messages += 1;
    this.lastMessageAt = Date.now();
    if (this.options.heartbeat?.isPong(message) === true) {
      this.clearHeartbeatDeadline();
      this.scheduleHeartbeat();
      return;
    }
    const handlers = new Set([
      ...(this.messageHandlers.get(message.type) ?? []),
      ...(this.messageHandlers.get(REALTIME_SOCKET_WILDCARD) ?? []),
    ]);
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (cause: unknown) {
        this.report(cause);
      }
    }
  }

  private scheduleHeartbeat(): void {
    const heartbeat = this.options.heartbeat;
    if (!heartbeat || this.currentState !== 'open') {
      return;
    }
    this.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      try {
        this.send(heartbeat.message);
      } catch (cause: unknown) {
        this.lost(cause);
        return;
      }
      this.clearHeartbeatDeadline();
      this.heartbeatDeadline = setTimeout(() => {
        this.heartbeatDeadline = undefined;
        this.lost(new Error('Realtime heartbeat timed out.'));
      }, heartbeat.timeoutMs);
    }, heartbeat.intervalMs);
  }

  /** 异常断开：解绑旧连接、按有上限的退避重连；主动关闭与销毁不重连。 */
  private lost(cause?: unknown): void {
    this.clearHeartbeat();
    this.detach();
    if (this.manualClose || this.disposed) {
      return;
    }
    if (cause !== undefined) {
      this.report(cause);
    }
    if (this.retries >= this.maxRetries) {
      this.changeState('closed');
      return;
    }
    const delay = Math.min(this.retryDelayMs * 2 ** this.retries, this.maxRetryDelayMs);
    this.retries += 1;
    this.totalRetries += 1;
    this.changeState('reconnecting');
    this.clearRetryTimer();
    // 抖动 0.8 到 1.2 倍：同一时刻断开的多条连接不会挤在同一毫秒重连。
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.open();
    }, delay * (0.8 + this.random() * 0.4));
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      if (socket.readyState < 2) {
        socket.close();
      }
    }
  }

  private changeState(state: RealtimeSocketState): void {
    this.currentState = state;
    for (const handler of [...this.stateHandlers]) {
      try {
        handler(state);
      } catch (cause: unknown) {
        this.report(cause);
      }
    }
  }

  private report(cause: unknown): void {
    const error =
      cause instanceof GisError
        ? cause
        : new GisError(cause instanceof Error ? cause.message : String(cause), {
            code: 'REALTIME_SOCKET_FAILED',
            module: 'realtime',
            operation: 'socket',
            retryable: true,
            cause,
          });
    for (const handler of [...this.errorHandlers]) {
      try {
        handler(error);
      } catch {
        // 订阅方异常不再向外扩散，避免一个坏订阅吃掉整条链路。
      }
    }
  }

  private clearRetryTimer(): void {
    this.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearHeartbeatDeadline(): void {
    this.clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = undefined;
  }

  private clearHeartbeat(): void {
    this.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.clearHeartbeatDeadline();
  }

  private clearTimeout(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  private assertUsable(operation: string): void {
    if (this.disposed) {
      throw socketError(
        'Realtime socket client has been disposed.',
        'REALTIME_SOCKET_DISPOSED',
        operation,
      );
    }
  }
}

/** 默认连接工厂：使用宿主提供的全局 `WebSocket`。 */
function defaultSocketFactory(): (url: string, protocols?: readonly string[]) => RealtimeSocketLike {
  return (url, protocols) => {
    const WebSocketConstructor = (
      globalThis as {
        WebSocket?: new (address: string, protocols?: readonly string[]) => RealtimeSocketLike;
      }
    ).WebSocket;
    if (!WebSocketConstructor) {
      throw socketError(
        'No global WebSocket is available in this terminal; pass a factory.',
        'REALTIME_SOCKET_UNSUPPORTED',
        'connect',
      );
    }
    return new WebSocketConstructor(url, protocols);
  };
}
