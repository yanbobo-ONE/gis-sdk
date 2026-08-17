export type EventMap = object;
export type Unsubscribe = () => void;

type EventListener<TEvent> = (event: TEvent) => void;
type StoredListener = EventListener<never>;

export class EventHub<TEvents extends EventMap> {
  private readonly listeners = new Map<keyof TEvents, Set<StoredListener>>();

  on<TKey extends keyof TEvents>(type: TKey, listener: EventListener<TEvents[TKey]>): Unsubscribe {
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

      if (listeners.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  once<TKey extends keyof TEvents>(
    type: TKey,
    listener: EventListener<TEvents[TKey]>,
  ): Unsubscribe {
    let off: Unsubscribe = () => undefined;
    off = this.on(type, (event) => {
      off();
      listener(event);
    });

    return off;
  }

  emit<TKey extends keyof TEvents>(type: TKey, event: TEvents[TKey]): void {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      (listener as EventListener<TEvents[TKey]>)(event);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
