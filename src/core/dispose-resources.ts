/**
 * 逐项执行清理并汇总失败。
 *
 * 生命周期幂等由各资源自身保证，这里只负责"每项都尝试一次"：一项失败不能阻止其余资源
 * 释放，失败项会汇总成 `AggregateError` 抛出。
 *
 * @internal
 */
export function disposeResources(
  resources: Readonly<Record<string, (() => void) | undefined>>,
): void {
  const errors: Error[] = [];
  for (const [name, cleanup] of Object.entries(resources)) {
    if (!cleanup) {
      continue;
    }
    try {
      cleanup();
    } catch (cause: unknown) {
      errors.push(new Error(`Failed to dispose "${name}".`, { cause }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Some resources could not be disposed.');
  }
}

/**
 * 初始化失败时回收已取得的资源，并始终把原始错误作为对外错误抛出。
 *
 * 清理失败不会覆盖调用方真正需要处理的初始化错误，而是与它一起放进 `AggregateError`。
 *
 * @internal
 */
export function rethrowAfterCleanup(
  error: unknown,
  resources: Readonly<Record<string, (() => void) | undefined>>,
): never {
  try {
    disposeResources(resources);
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [error, cleanupError],
      'Initialization failed and some resources could not be disposed.',
      { cause: error },
    );
  }
  throw error;
}
