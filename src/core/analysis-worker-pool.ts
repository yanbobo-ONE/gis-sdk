import type {
  AnalysisController,
  AnalysisInputMap,
  AnalysisResultMap,
  AnalysisRunOptions,
  AnalysisToolDescriptor,
  AnalysisToolId,
} from './analysis.js';
import { createAnalysisWorkerClient } from './analysis-worker-client.js';
import type { AnalysisWorkerPort } from './analysis-worker-protocol.js';
import { GisError } from './errors.js';

/** Worker 池配置。 */
export interface AnalysisWorkerPoolOptions {
  /** 每个 Worker 允许同时在途的请求数，默认 1（串行执行，避免互相争抢）。 */
  readonly maxPendingPerWorker?: number;
  /** 排队上限，默认 32；队列满时新请求以 `ANALYSIS_WORKER_QUEUE_FULL` 拒绝。 */
  readonly maxQueued?: number;
  /** 单次请求超时，单位为毫秒，默认 30000。 */
  readonly timeoutMs?: number;
  /** `list()` 返回的工具描述；省略时返回空数组（池无法同步查询 Worker 的工具集）。 */
  readonly descriptors?: readonly AnalysisToolDescriptor[];
}

/** Worker 池运行统计。 */
export interface AnalysisWorkerPoolStats {
  /** Worker 数量。 */
  readonly workers: number;
  /** 当前在途请求数。 */
  readonly pending: number;
  /** 当前排队请求数。 */
  readonly queued: number;
  /** 已成功完成的请求数。 */
  readonly completed: number;
  /** 已失败的请求数（含超时、取消与工具报错）。 */
  readonly failed: number;
}

/** 带统计与销毁的 Worker 池控制器；接口与 {@link AnalysisController} 相同。 */
export interface AnalysisWorkerPool extends AnalysisController {
  /** 运行统计快照。 */
  readonly stats: AnalysisWorkerPoolStats;
  /** 销毁全部 Worker 客户端并拒绝排队中的请求。 */
  dispose(): void;
}

/** 单个 Worker 客户端；由 `createAnalysisWorkerClient` 创建。 */
type WorkerClient = ReturnType<typeof createAnalysisWorkerClient>;

interface QueuedRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: GisError) => void;
  readonly tool: AnalysisToolId;
  readonly input: unknown;
  readonly options: AnalysisRunOptions | undefined;
}

function poolError(
  message: string,
  code:
    | 'ANALYSIS_WORKER_QUEUE_FULL'
    | 'ANALYSIS_WORKER_DISPOSED'
    | 'ANALYSIS_WORKER_FAILED'
    | 'INVALID_ANALYSIS_INPUT',
  operation: string,
  retryable = false,
): GisError {
  return new GisError(message, { code, module: 'analysis', operation, retryable });
}

/**
 * 用多个 Worker 并行执行分析请求。
 *
 * 调度策略是**最小在途优先**：每次派发都挑当前在途请求最少的 Worker，因此慢任务不会把某个
 * Worker 堵死；所有 Worker 都达到 `maxPendingPerWorker` 时请求进入 FIFO 队列，队列满则拒绝。
 * 这是"够用的默认调度"，需要按工具或数据分片的业务可以自己起多个池。
 *
 * 每个 Worker 复用 {@link createAnalysisWorkerClient}：取消、超时、错误码还原的语义与单 Worker
 * 完全一致，池只负责选目标与排队。
 *
 * @param ports - 每个 Worker 一个消息端口。
 * @param options - 并发、队列、超时与工具描述。
 * @returns Worker 池控制器。
 * @throws `INVALID_ANALYSIS_INPUT` 没有端口或配置越界。
 */
export function createAnalysisWorkerPool(
  ports: readonly AnalysisWorkerPort[],
  options: AnalysisWorkerPoolOptions = {},
): AnalysisWorkerPool {
  if (!Array.isArray(ports) || ports.length === 0) {
    throw poolError('Analysis worker pool requires at least one port.', 'INVALID_ANALYSIS_INPUT', 'create');
  }
  const maxPendingPerWorker = options.maxPendingPerWorker ?? 1;
  if (!Number.isInteger(maxPendingPerWorker) || maxPendingPerWorker < 1 || maxPendingPerWorker > 64) {
    throw poolError(
      'Analysis worker pool maxPendingPerWorker must be an integer between 1 and 64.',
      'INVALID_ANALYSIS_INPUT',
      'create',
    );
  }
  const maxQueued = options.maxQueued ?? 32;
  if (!Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 4096) {
    throw poolError(
      'Analysis worker pool maxQueued must be an integer between 0 and 4096.',
      'INVALID_ANALYSIS_INPUT',
      'create',
    );
  }

  const clients: WorkerClient[] = ports.map((port: AnalysisWorkerPort) =>
    createAnalysisWorkerClient(port, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.descriptors === undefined ? {} : { descriptors: options.descriptors }),
    }),
  );
  const queue: QueuedRequest[] = [];
  let completed = 0;
  let failed = 0;
  let disposed = false;

  /** 选在途请求最少的空闲 Worker；全部饱和时返回 `undefined`。 */
  const pickClient = (): WorkerClient | undefined => {
    let best: WorkerClient | undefined;
    let bestPending = Number.POSITIVE_INFINITY;
    for (const client of clients) {
      const pending = client.pending;
      if (pending >= maxPendingPerWorker) {
        continue;
      }
      if (pending < bestPending) {
        bestPending = pending;
        best = client;
      }
    }
    return best;
  };

  const drain = (): void => {
    while (queue.length > 0) {
      const client = pickClient();
      if (!client) {
        return;
      }
      const request = queue.shift();
      if (!request) {
        return;
      }
      dispatch(client, request);
    }
  };

  const dispatch = (client: WorkerClient, request: QueuedRequest): void => {
    void client
      .run(
        request.tool,
        request.input as AnalysisInputMap[typeof request.tool],
        request.options ?? {},
      )
      .then(
        (result) => {
          completed += 1;
          request.resolve(result);
        },
        (error: unknown) => {
          failed += 1;
          request.reject(
            error instanceof GisError
              ? error
              : poolError(
                  error instanceof Error ? error.message : String(error),
                  'ANALYSIS_WORKER_FAILED',
                  'run',
                  true,
                ),
          );
        },
      )
      .finally(() => {
        drain();
      });
  };

  return {
    get stats(): AnalysisWorkerPoolStats {
      return {
        workers: clients.length,
        pending: clients.reduce((total, client) => total + client.pending, 0),
        queued: queue.length,
        completed,
        failed,
      };
    },
    list() {
      return options.descriptors ?? [];
    },
    run<T extends AnalysisToolId>(
      tool: T,
      input: AnalysisInputMap[T],
      runOptions: AnalysisRunOptions = {},
    ): Promise<AnalysisResultMap[T]> {
      if (disposed) {
        throw poolError('Analysis worker pool has been disposed.', 'ANALYSIS_WORKER_DISPOSED', 'run');
      }
      return new Promise<AnalysisResultMap[T]>((resolve, reject) => {
        const request: QueuedRequest = {
          resolve: (result) => {
            resolve(result as AnalysisResultMap[T]);
          },
          reject,
          tool,
          input,
          options: runOptions,
        };
        const client = pickClient();
        if (client) {
          dispatch(client, request);
          return;
        }
        if (queue.length >= maxQueued) {
          failed += 1;
          reject(
            poolError(
              'Analysis worker pool queue is full.',
              'ANALYSIS_WORKER_QUEUE_FULL',
              'run',
              true,
            ),
          );
          return;
        }
        queue.push(request);
      });
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const client of clients) {
        client.dispose();
      }
      const error = poolError(
        'Analysis worker pool has been disposed.',
        'ANALYSIS_WORKER_DISPOSED',
        'dispose',
      );
      for (const request of queue.splice(0, queue.length)) {
        failed += 1;
        request.reject(error);
      }
    },
  };
}
