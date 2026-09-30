import type {
  AnalysisController,
  AnalysisInputMap,
  AnalysisToolId,
} from './analysis.js';
import { GisError } from './errors.js';

/** 批量分析里的一项。 */
export interface AnalysisBatchItem<T extends AnalysisToolId = AnalysisToolId> {
  /** 工具 id。 */
  readonly tool: T;
  /** 工具输入；类型随 `tool` 收窄。 */
  readonly input: AnalysisInputMap[T];
  /** 业务标识，结果里原样带回；省略时用下标。 */
  readonly id?: string;
}

/** 单条结果。 */
export interface AnalysisBatchEntry {
  /** 业务标识；构造时省略则为 `undefined`。 */
  readonly id: string | undefined;
  /** 在输入数组里的下标。 */
  readonly index: number;
  /** 工具 id。 */
  readonly tool: AnalysisToolId;
  /** 该条是否成功。 */
  readonly ok: boolean;
  /** 成功时的结果。 */
  readonly value: unknown;
  /** 失败时的错误代码（`GisError.code` 或 `ANALYSIS_BATCH_FAILED`）。 */
  readonly errorCode: string | undefined;
  /** 失败时的错误消息。 */
  readonly errorMessage: string | undefined;
}

/** 进度快照。 */
export interface AnalysisBatchProgress {
  /** 已成功数。 */
  readonly completed: number;
  /** 已失败数。 */
  readonly failed: number;
  /** 总数。 */
  readonly total: number;
  /** 正在执行的数量。 */
  readonly running: number;
  /** 尚未开始的数量。 */
  readonly pending: number;
}

/** 批量执行结果。 */
export interface AnalysisBatchOutcome {
  /** 与输入同序的逐条结果；被取消时包含已完成的条目与被中止的条目，未派发的条目不会出现。 */
  readonly entries: readonly AnalysisBatchEntry[];
  /** 是否因 `signal` 中止而提前结束（已完成的部分仍然返回）。 */
  readonly cancelled: boolean;
}

/** 批量执行选项。 */
export interface AnalysisBatchOptions {
  /** 并发上限，默认 4，范围 1 到 32。 */
  readonly concurrency?: number;
  /** 中止信号：停止派发新任务，并让在途任务拿到同一个信号。 */
  readonly signal?: AbortSignal;
  /** 每完成一条（成功或失败）回调一次；按完成顺序触发，不保证与输入同序。 */
  readonly onProgress?: (progress: AnalysisBatchProgress) => void;
}

function batchError(
  message: string,
  code: 'INVALID_ANALYSIS_INPUT' | 'ANALYSIS_BATCH_FAILED',
  operation: string,
): GisError {
  return new GisError(message, { code, module: 'analysis', operation });
}

/**
 * 批量执行分析工具，带并发上限、逐条失败隔离与进度回调。
 *
 * 与 `createAnalysisWorkerPool()` 的分工：池解决"任务跑在哪个 Worker 上"，本函数解决
 * "一批任务怎么编排"——两者可以叠加（把池当成 `controller` 传进来，并发上限由池自己再管一层）。
 *
 * 语义：
 *
 * - **并发有界**：同时在跑的任务不超过 `concurrency`，因此不会一次压垮地形采样或 Worker；
 * - **失败隔离**：某一条抛错只记在它自己的结果里，其余条目继续执行（批量分析里一条坏数据不该
 *   毁掉整批）；
 * - **顺序稳定**：结果与输入**同序**（按下标排列），便于直接与业务行对齐；
 * - **取消返回部分结果**：`signal` 中止后不再派发新任务、在途任务拿到同一个信号（通常会以
 *   `ANALYSIS_ABORTED` 记在这一条的结果里），函数**正常返回**并把 `cancelled` 置为 `true`——
 *   进度面板可以展示"完成了多少"，业务自己决定保留还是丢弃。
 *
 * @param controller - 分析控制器（`map.analysis` 或 Worker 池）。
 * @param items - 待执行条目。
 * @param options - 并发、取消与进度回调。
 * @returns 逐条结果与是否被取消。
 * @throws `INVALID_ANALYSIS_INPUT` 并发上限非法。
 */
export async function runAnalysisBatch(
  controller: AnalysisController,
  items: readonly AnalysisBatchItem[],
  options: AnalysisBatchOptions = {},
): Promise<AnalysisBatchOutcome> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw batchError(
      'Analysis batch concurrency must be an integer between 1 and 32.',
      'INVALID_ANALYSIS_INPUT',
      'runAnalysisBatch',
    );
  }
  const total = items.length;
  const signal = options.signal;
  const entries: AnalysisBatchEntry[] = [];
  let completed = 0;
  let failed = 0;
  let nextIndex = 0;
  let running = 0;
  let cancelled = false;

  const progress = (running: number): AnalysisBatchProgress => ({
    completed,
    failed,
    total,
    running,
    pending: Math.max(0, total - nextIndex),
  });

  const settle = (entry: AnalysisBatchEntry): void => {
    entries.push(entry);
    if (entry.ok) {
      completed += 1;
    } else {
      failed += 1;
    }
    options.onProgress?.(progress(running));
  };

  const runOne = async (index: number): Promise<AnalysisBatchEntry> => {
    const item = items[index];
    if (!item) {
      return {
        id: undefined,
        index,
        tool: 'distance',
        ok: false,
        value: undefined,
        errorCode: 'ANALYSIS_BATCH_FAILED',
        errorMessage: 'Missing batch item.',
      };
    }
    const base = { id: item.id, index, tool: item.tool };
    try {
      const value = await controller.run(
        item.tool,
        item.input,
        signal === undefined ? {} : { signal },
      );
      return { ...base, ok: true, value, errorCode: undefined, errorMessage: undefined };
    } catch (cause: unknown) {
      const error =
        cause instanceof GisError
          ? cause
          : batchError(
              cause instanceof Error ? cause.message : String(cause),
              'ANALYSIS_BATCH_FAILED',
              item.tool,
            );
      return { ...base, ok: false, value: undefined, errorCode: error.code, errorMessage: error.message };
    }
  };

  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (!cancelled) {
      if (signal?.aborted === true) {
        cancelled = true;
        return;
      }
      const index = nextIndex;
      if (index >= total) {
        return;
      }
      nextIndex += 1;
      running += 1;
      const entry = await runOne(index);
      running -= 1;
      settle(entry);
    }
  };

  for (let slot = 0; slot < Math.min(concurrency, Math.max(total, 1)); slot += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  if (signal?.aborted === true) {
    cancelled = true;
  }

  // 结果与输入同序：进度回调按完成顺序触发，但返回值按下标稳定排列。
  entries.sort((left, right) => left.index - right.index);
  return { entries, cancelled };
}
