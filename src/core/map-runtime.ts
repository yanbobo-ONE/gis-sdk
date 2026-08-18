import type { GisMap, MapEngineAdapter, MapEventMap, MapState } from './contracts.js';
import { GisError } from './errors.js';
import { EventHub } from './event-hub.js';
import type { LayerManager } from '../layers/contracts.js';

export class MapRuntime<TRaw> implements GisMap<TRaw> {
  readonly events = new EventHub<MapEventMap>();

  private currentState: MapState = 'ready';
  private destroyPromise: Promise<void> | undefined;

  constructor(
    readonly id: string,
    private readonly adapter: MapEngineAdapter<TRaw>,
  ) {}

  get state(): MapState {
    return this.currentState;
  }

  get raw(): Readonly<TRaw> {
    return this.adapter.raw;
  }

  get layers(): LayerManager {
    return this.adapter.layers;
  }

  resize(): void {
    if (this.currentState !== 'ready') {
      throw new GisError(`Map "${this.id}" has been disposed.`, {
        code: 'MAP_DISPOSED',
        module: 'map',
        operation: 'resize',
      });
    }

    this.adapter.resize();
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise;
    }

    this.currentState = 'destroying';
    const adapterDestroyPromise = Promise.resolve().then(() => this.adapter.destroy());
    this.destroyPromise = adapterDestroyPromise.then(
      () => {
        this.currentState = 'destroyed';
        this.emitDestroy();
      },
      (cause: unknown) => {
        const error = new GisError(`Failed to destroy map "${this.id}".`, {
          code: 'MAP_DESTROY_FAILED',
          module: 'map',
          operation: 'destroy',
          retryable: true,
          cause,
        });

        this.currentState = 'ready';
        this.destroyPromise = undefined;
        this.emitError(error);
        throw error;
      },
    );

    return this.destroyPromise;
  }

  private emitDestroy(): void {
    try {
      this.events.emit('map:destroy', { id: this.id });
    } catch (cause: unknown) {
      this.emitError(
        new GisError('A map:destroy listener failed.', {
          code: 'EVENT_LISTENER_FAILED',
          module: 'event',
          operation: 'map:destroy',
          cause,
        }),
      );
    }
  }

  private emitError(error: GisError): void {
    try {
      this.events.emit('map:error', { id: this.id, error });
    } catch {
      // Listener failures must not replace the operation error being reported.
    }
  }
}
