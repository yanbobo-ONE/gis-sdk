import type { GisMap, MapEngineAdapter, MapEventMap, MapState } from './contracts.js';
import type {
  BasemapController,
  CameraController,
  CameraFlight,
  CameraView,
  TerrainController,
  TerrainSpec,
  XyzBasemapSpec,
} from './controls.js';
import { GisError } from './errors.js';
import { EventHub } from './event-hub.js';
import type { LayerManager } from '../layers/contracts.js';

export class MapRuntime<TRaw> implements GisMap<TRaw> {
  readonly events = new EventHub<MapEventMap>();
  readonly camera: CameraController;
  readonly basemap: BasemapController;
  readonly terrain: TerrainController;

  private currentState: MapState = 'ready';
  private destroyPromise: Promise<void> | undefined;

  constructor(
    readonly id: string,
    private readonly adapter: MapEngineAdapter<TRaw>,
  ) {
    this.camera = Object.freeze({
      setView: (view: CameraView) => {
        this.assertReady('camera.setView');
        this.adapter.camera.setView(view);
      },
      flyTo: (view: CameraFlight) => {
        this.assertReady('camera.flyTo');
        return this.adapter.camera.flyTo(view);
      },
      cancelFlight: () => {
        this.assertReady('camera.cancelFlight');
        this.adapter.camera.cancelFlight();
      },
    });
    this.basemap = Object.freeze({
      get type() {
        return adapter.basemap.type;
      },
      get visible() {
        return adapter.basemap.visible;
      },
      get opacity() {
        return adapter.basemap.opacity;
      },
      set: (spec: XyzBasemapSpec) => {
        this.assertReady('basemap.set');
        this.adapter.basemap.set(spec);
      },
      clear: () => {
        this.assertReady('basemap.clear');
        this.adapter.basemap.clear();
      },
      setVisible: (visible: boolean) => {
        this.assertReady('basemap.setVisible');
        this.adapter.basemap.setVisible(visible);
      },
      setOpacity: (opacity: number) => {
        this.assertReady('basemap.setOpacity');
        this.adapter.basemap.setOpacity(opacity);
      },
    });
    this.terrain = Object.freeze({
      get type() {
        return adapter.terrain.type;
      },
      set: (spec: TerrainSpec) => {
        this.assertReady('terrain.set');
        return this.adapter.terrain.set(spec);
      },
    });
  }

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
    this.assertReady('resize');
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

  private assertReady(operation: string): void {
    if (this.currentState !== 'ready') {
      throw new GisError(`Map "${this.id}" has been disposed.`, {
        code: 'MAP_DISPOSED',
        module: 'map',
        operation,
      });
    }
  }
}
