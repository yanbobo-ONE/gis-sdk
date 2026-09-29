import type { DrawMode } from './drawing.js';
import type { GisMap, MapEngineAdapter, MapEventMap, MapState } from './contracts.js';
import type {
  BasemapController,
  CameraController,
  CameraFlight,
  CameraView,
  CaptureOptions,
  CoordinateTransform,
  FrameCapture,
  DrawingEventMap,
  GeoPosition,
  MapDrawingController,
  MapSceneMode,
  PickingController,
  PickingEvent,
  SceneController,
  PickingEventKind,
  PickingHit,
  TerrainController,
  TerrainSample,
  TerrainSampleOptions,
  TerrainSamplePoint,
  TerrainSpec,
  WindowCoordinates,
  WorldCoordinates,
  XyzBasemapSpec,
} from './controls.js';
import { GisError } from './errors.js';
import { EventHub } from './event-hub.js';
import type { QualityController, QualityProfileId, RenderQuality } from './quality.js';
import type { LayerManager } from '../layers/contracts.js';

export class MapRuntime<TRaw> implements GisMap<TRaw> {
  readonly events = new EventHub<MapEventMap>();
  readonly camera: CameraController;
  readonly basemap: BasemapController;
  readonly terrain: TerrainController;
  readonly coordinates: CoordinateTransform;
  readonly quality: QualityController;
  readonly picking: PickingController;
  readonly scene: SceneController;
  readonly drawing: MapDrawingController;

  private currentState: MapState = 'ready';
  private destroyPromise: Promise<void> | undefined;

  constructor(
    readonly id: string,
    private readonly adapter: MapEngineAdapter<TRaw>,
  ) {
    adapter.setErrorReporter?.((error) => {
      this.emitError(error);
    });
    this.coordinates = Object.freeze({
      toWorld: (position: GeoPosition): WorldCoordinates => {
        this.assertReady('coordinates.toWorld');
        return adapter.coordinates.toWorld(position);
      },
      toGeoPosition: (world: WorldCoordinates): GeoPosition => {
        this.assertReady('coordinates.toGeoPosition');
        return adapter.coordinates.toGeoPosition(world);
      },
      toWindow: (position: GeoPosition): WindowCoordinates | undefined => {
        this.assertReady('coordinates.toWindow');
        return adapter.coordinates.toWindow(position);
      },
      pickGeoPosition: (point: WindowCoordinates): GeoPosition | undefined => {
        this.assertReady('coordinates.pickGeoPosition');
        return adapter.coordinates.pickGeoPosition(point);
      },
    });
    this.picking = Object.freeze({
      get enabled() {
        return adapter.picking.enabled;
      },
      get lastHit(): PickingHit | undefined {
        return adapter.picking.lastHit;
      },
      on: (kind: PickingEventKind, listener: (event: PickingEvent) => void) =>
        adapter.picking.on(kind, (event) => {
          if (this.currentState === 'ready') {
            listener(event);
          }
        }),
      setEnabled: (enabled: boolean) => {
        this.assertReady('picking.setEnabled');
        adapter.picking.setEnabled(enabled);
      },
    });
    this.scene = Object.freeze({
      get mode(): MapSceneMode {
        return adapter.scene.mode;
      },
      get morphing() {
        return adapter.scene.morphing;
      },
      setMode: (mode: MapSceneMode, duration?: number) => {
        this.assertReady('scene.setMode');
        return adapter.scene.setMode(mode, duration);
      },
    });
    this.drawing = Object.freeze({
      get mode() {
        return adapter.drawing.mode;
      },
      get vertexCount() {
        return adapter.drawing.vertexCount;
      },
      start: (mode: DrawMode) => {
        this.assertReady('drawing.start');
        return adapter.drawing.start(mode);
      },
      finish: () => {
        this.assertReady('drawing.finish');
        return adapter.drawing.finish();
      },
      cancel: () => {
        this.assertReady('drawing.cancel');
        adapter.drawing.cancel();
      },
      removeLatestCompleted: () => {
        this.assertReady('drawing.removeLatestCompleted');
        adapter.drawing.removeLatestCompleted();
      },
      clearCompleted: () => {
        this.assertReady('drawing.clearCompleted');
        adapter.drawing.clearCompleted();
      },
      on: <TKey extends keyof DrawingEventMap>(
        kind: TKey,
        listener: (event: DrawingEventMap[TKey]) => void,
      ) =>
        adapter.drawing.on<TKey>(kind, (event) => {
          if (this.currentState === 'ready') {
            listener(event);
          }
        }),
    });
    this.quality = Object.freeze({
      get current() {
        return adapter.quality.current;
      },
      get snapshot() {
        return adapter.quality.snapshot;
      },
      get adaptive() {
        return adapter.quality.adaptive;
      },
      setProfile: (profile: QualityProfileId) => {
        this.assertReady('quality.setProfile');
        adapter.quality.setProfile(profile);
      },
      set: (quality: Partial<RenderQuality>) => {
        this.assertReady('quality.set');
        adapter.quality.set(quality);
      },
      setAdaptive: (enabled: boolean) => {
        this.assertReady('quality.setAdaptive');
        adapter.quality.setAdaptive(enabled);
      },
    });
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
      get errorCount() {
        return adapter.basemap.errorCount;
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
      sample: (
        points: readonly TerrainSamplePoint[],
        options?: TerrainSampleOptions,
      ): Promise<readonly TerrainSample[]> => {
        this.assertReady('terrain.sample');
        return this.adapter.terrain.sample(points, options);
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

  capture(options: CaptureOptions = {}): Promise<FrameCapture | undefined> {
    this.assertReady('capture');
    return this.adapter.capture(options);
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
