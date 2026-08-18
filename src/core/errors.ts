/** SDK 可稳定判断的错误代码。 */
export type GisErrorCode =
  | 'CESIUM_BASE_URL_CONFLICT'
  | 'EVENT_LISTENER_FAILED'
  | 'INVALID_CONTAINER'
  | 'MAP_DISPOSED'
  | 'MAP_DESTROY_FAILED';

/** 创建 {@link GisError} 所需的结构化上下文。 */
export interface GisErrorOptions {
  /** 稳定错误代码。 */
  readonly code: GisErrorCode;
  /** 发生错误的 SDK 模块。 */
  readonly module: string;
  /** 发生错误的具体操作。 */
  readonly operation: string;
  /** 调用方是否可以重试，默认 `false`。 */
  readonly retryable?: boolean;
  /** 原始异常或失败值。 */
  readonly cause?: unknown;
}

/** SDK 操作失败时抛出的结构化错误。 */
export class GisError extends Error {
  /** 供业务分支判断的稳定错误代码。 */
  readonly code: GisErrorCode;
  /** 发生错误的 SDK 模块。 */
  readonly module: string;
  /** 发生错误的具体操作。 */
  readonly operation: string;
  /** 当前操作是否允许由调用方重试。 */
  readonly retryable: boolean;

  /** 创建结构化 SDK 错误。 */
  constructor(message: string, options: GisErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'GisError';
    this.code = options.code;
    this.module = options.module;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
  }
}
