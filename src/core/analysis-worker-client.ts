import type {
  AnalysisController,
  AnalysisInputMap,
  AnalysisResultMap,
  AnalysisRunOptions,
  AnalysisToolDescriptor,
  AnalysisToolId,
} from './analysis.js';
import {
  createAnalysisWorkerCancel,
  createAnalysisWorkerRequest,
  fromAnalysisWorkerFailure,
  isAnalysisWorkerCancel,
  isAnalysisWorkerRequest,
  isAnalysisWorkerResponse,
  toAnalysisWorkerFailure,
  toAnalysisWorkerSuccess,
} from './analysis-worker-protocol.js';
import type { AnalysisWorkerPort, AnalysisWorkerRequest } from './analysis-worker-protocol.js';
import { GisError } from './errors.js';

/** Worker 客户端配置。 */
export interface AnalysisWorkerClientOptions {
  /** 单次请求的超时时间，单位为毫秒，默认 30000；超时以 `ANALYSIS_WORKER_TIMEOUT` 拒绝。 */
  readonly timeoutMs?: number;
  /**
   * `list()` 返回的工具描述。
   *
   * Worker 的工具集由 Worker 侧控制器决定，主线程无法同步查询；把同一份描述传进来（例如用
   * `/core` 导出的 `analysisTools`）即可让 `list()` 返回真实清单，省略时返回空数组。
   */
  readonly descriptors?: readonly AnalysisToolDescriptor[];
}

/** Worker 分析控制器：接口与 {@link AnalysisController} 相同，另加 `dispose()`。 */
export interface AnalysisWorkerController extends AnalysisController {
  /** 取消订阅并拒绝所有在途请求；之后调用 `run()` 会抛 `ANALYSIS_WORKER_DISPOSED`。 */
  dispose(): void;
  /** 在途请求数。 */
  readonly pending: number;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: GisError) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/**
 * 在主线程侧把分析请求转发给 Worker。
 *
 * 协议与 Worker 侧 {@link createAnalysisWorkerHost} 对称：请求按 id 匹配，取消会在两侧同时生效，
 * 超时与 Worker 侧失败都还原成 `GisError`（保留原始 `code` 与 `retryable`）。解析端口是可注入的
 * 消息通道，因此浏览器 Worker、Node `worker_threads` 包装、原生宿主都能用同一份实现。
 *
 * @param port - 消息端口；浏览器里通常是 `worker` 本身。
 * @param options - 超时配置。
 * @returns 与 `map.analysis` 同形的控制器。
 */
export function createAnalysisWorkerClient(
  port: AnalysisWorkerPort,
  options: AnalysisWorkerClientOptions = {},
): AnalysisWorkerController {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GisError('Analysis worker timeoutMs must be a positive finite number.', {
      code: 'INVALID_ANALYSIS_INPUT',
      module: 'analysis',
      operation: 'worker',
    });
  }
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, PendingRequest>();

  const unsubscribe = port.subscribe((message: unknown) => {
    if (!isAnalysisWorkerResponse(message)) {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    cleanup(entry);
    if (message.ok) {
      entry.resolve(message.result);
      return;
    }
    entry.reject(fromAnalysisWorkerFailure(message));
  });

  const cleanup = (entry: PendingRequest): void => {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  };

  const rejectAll = (error: GisError): void => {
    for (const [id, entry] of [...pending.entries()]) {
      pending.delete(id);
      cleanup(entry);
      entry.reject(error);
    }
  };

  return {
    get pending(): number {
      return pending.size;
    },
    list() {
      return options.descriptors ?? [];
    },
    async run<T extends AnalysisToolId>(
      tool: T,
      input: AnalysisInputMap[T],
      runOptions: AnalysisRunOptions = {},
    ): Promise<AnalysisResultMap[T]> {
      if (disposed) {
        throw new GisError('Analysis worker client has been disposed.', {
          code: 'ANALYSIS_WORKER_DISPOSED',
          module: 'analysis',
          operation: 'run',
        });
      }
      const signal = runOptions.signal;
      if (signal?.aborted === true) {
        throw new GisError('Analysis run was aborted.', {
          code: 'ANALYSIS_ABORTED',
          module: 'analysis',
          operation: tool,
          retryable: true,
        });
      }
      const id = nextId++;
      return new Promise<AnalysisResultMap[T]>((resolve, reject) => {
        const abort = (): void => {
          if (!pending.delete(id)) {
            return;
          }
          port.postMessage(createAnalysisWorkerCancel(id));
          reject(
            new GisError('Analysis run was aborted.', {
              code: 'ANALYSIS_ABORTED',
              module: 'analysis',
              operation: tool,
              retryable: true,
            }),
          );
        };
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                if (!pending.delete(id)) {
                  return;
                }
                port.postMessage(createAnalysisWorkerCancel(id));
                reject(
                  new GisError(`Analysis tool "${tool}" timed out after ${String(timeoutMs)} ms.`, {
                    code: 'ANALYSIS_WORKER_TIMEOUT',
                    module: 'analysis',
                    operation: tool,
                    retryable: true,
                  }),
                );
              }, timeoutMs)
            : undefined;
        pending.set(id, {
          resolve: (result) => {
            resolve(result as AnalysisResultMap[T]);
          },
          reject,
          timer,
          signal,
          onAbort: signal ? abort : undefined,
        });
        signal?.addEventListener('abort', abort, { once: true });
        port.postMessage(createAnalysisWorkerRequest(id, tool, input));
      });
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      rejectAll(
        new GisError('Analysis worker client has been disposed.', {
          code: 'ANALYSIS_WORKER_DISPOSED',
          module: 'analysis',
          operation: 'dispose',
        }),
      );
    },
  };
}

/** Worker 侧的共享地形端口：数据由业务预置，或明确不提供。 */
export interface AnalysisWorkerHostOptions {
  /**
   * 分析控制器；省略时用注入的 `createController` 创建。
   *
   * Worker 里通常没有 Cesium，需要地形高度的工具（`terrain-sample` / `line-of-sight` / 视域 /
   * 坡度坡向 / 地表距离）会以 `ANALYSIS_TERRAIN_UNAVAILABLE` 失败——这不是缺陷，而是"Worker
   * 里没有地形采样器"这一事实的诚实上报。纯计算工具不受影响。
   */
  readonly controller: AnalysisController;
}

/** Worker 侧宿主的句柄。 */
export interface AnalysisWorkerHost {
  /** 取消订阅并停止处理后续请求；已在执行的请求会跑完，结果不再回传。 */
  dispose(): void;
}

/**
 * 在 Worker 侧处理分析请求。
 *
 * 收到的请求顺序执行（工具本身是纯计算，串行足以避免争抢 Worker 的单线程），取消只影响尚未开始
 * 或正在等待地形的请求：已发出的地形请求不撤回，但结果不再回传。
 *
 * @param port - 消息端口；Worker 里通常是 `self` 包装出的 `{ postMessage, subscribe }`。
 * @param options - 分析控制器。
 * @returns 宿主句柄。
 */
export function createAnalysisWorkerHost(
  port: AnalysisWorkerPort,
  options: AnalysisWorkerHostOptions,
): AnalysisWorkerHost {
  const aborted = new Set<number>();
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;

  const unsubscribe = port.subscribe((message: unknown) => {
    if (disposed) {
      return;
    }
    if (isAnalysisWorkerCancel(message)) {
      aborted.add(message.id);
      return;
    }
    if (!isAnalysisWorkerRequest(message)) {
      return;
    }
    const request: AnalysisWorkerRequest = message;
    queue = queue.then(async () => {
      if (aborted.delete(request.id)) {
        return;
      }
      try {
        const result = await options.controller.run(
          request.tool,
          request.input as AnalysisInputMap[typeof request.tool],
        );
        port.postMessage(toAnalysisWorkerSuccess(request.id, result));
      } catch (cause: unknown) {
        port.postMessage(toAnalysisWorkerFailure(request.id, cause));
      }
    });
  });

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      aborted.clear();
    },
  };
}
