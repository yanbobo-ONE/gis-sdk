import { GisError, isGisErrorCode } from './errors.js';
import type { AnalysisToolId } from './analysis.js';

/**
 * Worker 间消息协议。
 *
 * 协议只描述"请求 / 响应 / 取消"三件事，不绑定具体传输：`postMessage` 通道、`MessagePort`、
 * 原生宿主的跨线程消息都能承载。载荷必须是可结构化克隆的值——业务若传大数组，推荐先用
 * `normalizePositions()` 转成可转移的 `Float64Array`。
 *
 * @internal
 */
export interface AnalysisWorkerRequest {
  /** 协议标记，用于区分同一通道上的其它消息。 */
  readonly kind: 'gis-sdk-analysis:request';
  /** 请求 id；同一个通道内自增，响应与取消都按它匹配。 */
  readonly id: number;
  /** 工具 id。 */
  readonly tool: AnalysisToolId;
  /** 工具输入。 */
  readonly input: unknown;
}

/** @internal */
export interface AnalysisWorkerCancel {
  /** 协议标记。 */
  readonly kind: 'gis-sdk-analysis:cancel';
  /** 要取消的请求 id。 */
  readonly id: number;
}

/** 响应共有的成功 / 失败形状。 */
export interface AnalysisWorkerSuccess {
  /** 协议标记。 */
  readonly kind: 'gis-sdk-analysis:response';
  /** 对应请求 id。 */
  readonly id: number;
  /** 是否成功。 */
  readonly ok: true;
  /** 工具结果。 */
  readonly result: unknown;
}

/** 失败响应：错误按代码 / 消息 / 可重试标记还原成 `GisError`。 */
export interface AnalysisWorkerFailure {
  /** 协议标记。 */
  readonly kind: 'gis-sdk-analysis:response';
  /** 对应请求 id。 */
  readonly id: number;
  /** 是否成功。 */
  readonly ok: false;
  /** 错误代码。 */
  readonly code: string;
  /** 错误消息。 */
  readonly message: string;
  /** 是否适合重试。 */
  readonly retryable: boolean;
}

/** @internal */
export type AnalysisWorkerResponse = AnalysisWorkerSuccess | AnalysisWorkerFailure;

/** @internal */
export type AnalysisWorkerMessage =
  AnalysisWorkerRequest | AnalysisWorkerCancel | AnalysisWorkerResponse;

/** 主线程 / Worker 两侧共用的消息端口形状。 */
export interface AnalysisWorkerPort {
  /** 发送消息；实现方保证结构化克隆语义。 */
  postMessage(message: unknown): void;
  /** 订阅消息；返回取消订阅函数。 */
  subscribe(listener: (message: unknown) => void): () => void;
}

const REQUEST_KIND = 'gis-sdk-analysis:request';
const CANCEL_KIND = 'gis-sdk-analysis:cancel';
const RESPONSE_KIND = 'gis-sdk-analysis:response';

/** 判断一条消息是否为分析请求。 */
export function isAnalysisWorkerRequest(value: unknown): value is AnalysisWorkerRequest {
  return isRecord(value) && value.kind === REQUEST_KIND && Number.isInteger(value.id);
}

/** 判断一条消息是否为取消指令。 */
export function isAnalysisWorkerCancel(value: unknown): value is AnalysisWorkerCancel {
  return isRecord(value) && value.kind === CANCEL_KIND && Number.isInteger(value.id);
}

/** 判断一条消息是否为响应。 */
export function isAnalysisWorkerResponse(value: unknown): value is AnalysisWorkerResponse {
  return isRecord(value) && value.kind === RESPONSE_KIND && Number.isInteger(value.id);
}

/** 构造请求消息；主线程侧的客户端内部使用，也便于业务手写协议测试。 */
export function createAnalysisWorkerRequest(
  id: number,
  tool: AnalysisToolId,
  input: unknown,
): AnalysisWorkerRequest {
  return { kind: REQUEST_KIND, id, tool, input };
}

/** 构造取消消息。 */
export function createAnalysisWorkerCancel(id: number): AnalysisWorkerCancel {
  return { kind: CANCEL_KIND, id };
}

/**
 * 把抛出的错误压成可结构化克隆的失败响应。
 *
 * @param id - 请求 id。
 * @param cause - 捕获到的异常。
 * @returns 失败响应。
 */
export function toAnalysisWorkerFailure(id: number, cause: unknown): AnalysisWorkerFailure {
  if (cause instanceof GisError) {
    return {
      kind: RESPONSE_KIND,
      id,
      ok: false,
      code: cause.code,
      message: cause.message,
      retryable: cause.retryable,
    };
  }
  return {
    kind: RESPONSE_KIND,
    id,
    ok: false,
    code: 'ANALYSIS_WORKER_FAILED',
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
  };
}

/**
 * 还原失败响应里的错误。
 *
 * @param failure - 失败响应。
 * @returns 带原始代码与重试标记的 `GisError`。
 */
export function fromAnalysisWorkerFailure(failure: AnalysisWorkerFailure): GisError {
  return new GisError(failure.message, {
    code: isGisErrorCode(failure.code) ? failure.code : 'ANALYSIS_WORKER_FAILED',
    module: 'analysis',
    operation: 'worker',
    retryable: failure.retryable,
  });
}

/** 构造成功响应。 */
export function toAnalysisWorkerSuccess(id: number, result: unknown): AnalysisWorkerSuccess {
  return { kind: RESPONSE_KIND, id, ok: true, result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
