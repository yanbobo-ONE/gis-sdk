interface QueuedTask {
  start(): void;
  cancel(reason: unknown): void;
  removeAbortListener: (() => void) | undefined;
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Operation aborted.', { cause: reason });
}

function failureReason(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Load task failed.', { cause });
}

/**
 * 限制同类异步加载的并发数量。
 *
 * 一次发起大量请求（星座模型、批量地形采样）时，不做限制会让浏览器同时发出与任务数相同的
 * 网络请求和解析工作；该限制器把超出并发配额的任务按先入先出排队，并让排队中的任务在
 * 取消时立即失败，不再占用后续配额。
 *
 * @internal
 */
export class LoadLimiter {
  private readonly queue: QueuedTask[] = [];
  private active = 0;
  private concurrency: number;

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, Math.floor(concurrency));
  }

  /** 当前正在执行的任务数。 */
  get activeCount(): number {
    return this.active;
  }

  /** 当前排队等待执行的任务数。 */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** 当前并发上限。 */
  get concurrencyLimit(): number {
    return this.concurrency;
  }

  /** 调整并发上限；调高后立即补偿排队中的任务。 */
  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.drain();
  }

  /**
   * 在并发配额内运行一次加载。
   *
   * `signal` 已取消时立即拒绝；排队期间取消的任务不会进入执行阶段。
   */
  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal.reason));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueuedTask = {
        removeAbortListener: undefined,
        start: () => {
          entry.removeAbortListener?.();
          entry.removeAbortListener = undefined;
          this.active += 1;
          let loading: Promise<T>;
          try {
            loading = task();
          } catch (cause: unknown) {
            this.release();
            reject(failureReason(cause));
            return;
          }
          void loading.then(
            (value: T) => {
              this.release();
              resolve(value);
            },
            (cause: unknown) => {
              this.release();
              reject(failureReason(cause));
            },
          );
        },
        cancel: (reason: unknown) => {
          reject(abortReason(reason));
        },
      };

      const onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) {
          return;
        }
        entry.removeAbortListener?.();
        entry.removeAbortListener = undefined;
        this.queue.splice(index, 1);
        entry.cancel(signal.reason);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      entry.removeAbortListener = () => {
        signal.removeEventListener('abort', onAbort);
      };
      this.queue.push(entry);
      this.drain();
    });
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const next = this.queue.shift();
      if (!next) {
        return;
      }
      next.start();
    }
  }
}
