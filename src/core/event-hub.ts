/** 取消事件订阅的幂等函数。 */
export type Unsubscribe = () => void;

type StoredListener = (event: never) => void;

/**
 * 使用事件映射约束事件名称和载荷的轻量事件中心。
 *
 * @typeParam TEvents - 事件名称到事件载荷的映射。
 */
export class EventHub<TEvents extends object> {
  private readonly listeners = new Map<keyof TEvents, Set<StoredListener>>();

  /** 订阅事件并返回幂等取消函数。 */
  on<TKey extends keyof TEvents>(
    type: TKey,
    listener: (event: TEvents[TKey]) => void,
  ): Unsubscribe {
    const storedListener = listener as StoredListener;
    const listeners = this.listeners.get(type) ?? new Set<StoredListener>();
    listeners.add(storedListener);
    this.listeners.set(type, listeners);

    let subscribed = true;

    return () => {
      if (!subscribed) {
        return;
      }

      subscribed = false;
      listeners.delete(storedListener);

      if (listeners.size === 0 && this.listeners.get(type) === listeners) {
        this.listeners.delete(type);
      }
    };
  }

  /** 订阅只执行一次的事件监听器。 */
  once<TKey extends keyof TEvents>(
    type: TKey,
    listener: (event: TEvents[TKey]) => void,
  ): Unsubscribe {
    let off: Unsubscribe = () => undefined;
    off = this.on(type, (event) => {
      off();
      listener(event);
    });

    return off;
  }

  /**
   * 向当前监听器快照发送事件。
   *
   * 所有监听器都会获得执行机会；一个监听器失败时抛出原错误，多个监听器失败时抛出
   * `AggregateError`。
   */
  emit<TKey extends keyof TEvents>(type: TKey, event: TEvents[TKey]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }

    const errors: unknown[] = [];
    for (const listener of [...listeners]) {
      try {
        (listener as (event: TEvents[TKey]) => void)(event);
      } catch (error: unknown) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      const error = errors[0];
      throw error instanceof Error ? error : new Error('Event listener failed.', { cause: error });
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, 'Multiple event listeners failed.');
    }
  }

  /** 移除全部事件的全部监听器。 */
  clear(): void {
    this.listeners.clear();
  }
}
