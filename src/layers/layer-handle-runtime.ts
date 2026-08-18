import { GisError } from '../core/errors.js';
import { EventHub } from '../core/event-hub.js';
import type { LayerEventMap, LayerHandle, LayerState, LayerType } from './contracts.js';

/** @internal */
export interface LayerHandleRuntimeOptions {
  readonly id: string;
  readonly type: LayerType;
  readonly visible: boolean;
  readonly onSetVisible: (visible: boolean) => void;
  readonly onDispose: () => void | Promise<void>;
  readonly onDisposed: () => void;
}

/** @internal */
export class LayerHandleRuntime implements LayerHandle {
  readonly events = new EventHub<LayerEventMap>();

  private currentState: LayerState;
  private currentVisible: boolean;
  private disposePromise: Promise<void> | undefined;

  readonly id: string;
  readonly type: LayerType;

  constructor(private readonly options: LayerHandleRuntimeOptions) {
    this.id = options.id;
    this.type = options.type;
    this.currentVisible = options.visible;
    this.currentState = options.visible ? 'ready' : 'hidden';
  }

  get state(): LayerState {
    return this.currentState;
  }

  get visible(): boolean {
    return this.currentVisible;
  }

  setVisible(visible: boolean): void {
    this.assertUsable('setVisible');
    if (visible === this.currentVisible) {
      return;
    }

    this.options.onSetVisible(visible);
    this.currentVisible = visible;
    this.transition(visible ? 'ready' : 'hidden');
  }

  dispose(): Promise<void> {
    if (this.currentState === 'disposed') {
      return Promise.resolve();
    }
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.transition('disposing');
    this.disposePromise = Promise.resolve()
      .then(() => this.options.onDispose())
      .then(
        () => {
          this.transition('disposed');
          this.options.onDisposed();
        },
        (cause: unknown) => {
          this.transition('error');
          this.disposePromise = undefined;
          throw new GisError(`Failed to dispose layer "${this.id}".`, {
            code: 'LAYER_DISPOSE_FAILED',
            module: 'layer',
            operation: 'dispose',
            retryable: true,
            cause,
          });
        },
      );

    return this.disposePromise;
  }

  /** Marks a capability-specific asynchronous update as loading. */
  beginLoading(operation: string): void {
    this.assertUsable(operation);
    this.transition('loading');
  }

  /** Restores the visible or hidden stable state after a successful update. */
  completeLoading(): void {
    if (this.currentState !== 'disposing' && this.currentState !== 'disposed') {
      this.transition(this.currentVisible ? 'ready' : 'hidden');
    }
  }

  /** Marks a failed update while keeping the handle retryable. */
  failLoading(): void {
    if (this.currentState !== 'disposing' && this.currentState !== 'disposed') {
      this.transition('error');
    }
  }

  /** Rejects operations after disposal has started. */
  assertUsable(operation: string): void {
    if (this.currentState === 'disposing' || this.currentState === 'disposed') {
      throw new GisError(`Layer "${this.id}" has been disposed.`, {
        code: 'LAYER_DISPOSED',
        module: 'layer',
        operation,
      });
    }
  }

  private transition(state: LayerState): void {
    if (state === this.currentState) {
      return;
    }

    const previous = this.currentState;
    this.currentState = state;
    try {
      this.events.emit('state:changed', { id: this.id, previous, state });
    } catch {
      // Consumer listeners must not change lifecycle outcomes.
    }
  }
}
