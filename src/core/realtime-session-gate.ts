import { GisError } from './errors.js';

/** 会话判定结果。 */
export interface RealtimeSessionDecision {
  /** 是否接受该消息进入后续管线。 */
  readonly accept: boolean;
  /** 本次是否发生了会话切换（含首次建立）。 */
  readonly switched: boolean;
  /** 判定后生效的会话 id；尚未建立会话时为 `undefined`。 */
  readonly sessionId: string | undefined;
}

/** 会话门禁的配置。 */
export interface RealtimeSessionGateOptions<T> {
  /**
   * 取出业务消息携带的会话 id；返回 `undefined` 表示该消息不带会话信息，一律放行。
   */
  readonly sessionOf: (message: T) => string | undefined;
  /**
   * 判断一条消息是否是"开始 / 切换会话"的控制消息。
   *
   * 控制消息自身不进业务管线（只切换会话），因此这类消息的 `accept` 恒为 `false`；
   * 控制消息缺少会话 id 时视为无效，同样不接受且不改变当前会话。
   */
  readonly isBegin?: (message: T) => boolean;
}

/**
 * 实时会话门禁。
 *
 * 断线重连、切页重建、多路数据源并存时，旧连接的迟到包会把运行状态"夺回"到已经结束的
 * 会话。门禁只允许两种方式改变当前会话：首条携带会话 id 的业务消息，或显式的开始 / 切换
 * 控制消息；其余与会话不匹配的消息一律拒绝。
 *
 * @typeParam T - 消息类型；会话信息通过提取函数获取，不耦合具体协议字段。
 */
export class RealtimeSessionGate<T> {
  private current: string | undefined;

  private readonly options: RealtimeSessionGateOptions<T>;

  constructor(options: RealtimeSessionGateOptions<T> | undefined) {
    const sessionOf = options?.sessionOf;
    if (typeof sessionOf !== 'function') {
      throw new GisError('Realtime session gate requires a sessionOf function.', {
        code: 'INVALID_REALTIME_CONFIG',
        module: 'realtime',
        operation: 'create',
      });
    }
    this.options = { ...options, sessionOf };
  }

  /** 当前生效的会话 id。 */
  get sessionId(): string | undefined {
    return this.current;
  }

  /**
   * 判定一条消息是否可以进入管线。
   *
   * @param message - 原始消息。
   * @returns 判定结果；`accept` 为 `false` 时调用方应丢弃该消息。
   */
  evaluate(message: T): RealtimeSessionDecision {
    if (this.options.isBegin?.(message) === true) {
      const session = this.options.sessionOf(message);
      if (!session) {
        return { accept: false, switched: false, sessionId: this.current };
      }
      const switched = session !== this.current;
      this.current = session;
      // 控制消息只负责切换会话，本身不进入业务管线。
      return { accept: false, switched, sessionId: session };
    }

    const session = this.options.sessionOf(message);
    if (session === undefined) {
      return { accept: true, switched: false, sessionId: this.current };
    }
    if (this.current === undefined) {
      this.current = session;
      return { accept: true, switched: true, sessionId: session };
    }
    return {
      accept: session === this.current,
      switched: false,
      sessionId: this.current,
    };
  }

  /** 清空当前会话；重连或整页重建时调用。 */
  reset(): void {
    this.current = undefined;
  }
}
