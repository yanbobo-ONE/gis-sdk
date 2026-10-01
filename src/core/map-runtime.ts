import type {
  AnalysisController,
  AnalysisInputMap,
  AnalysisRunOptions,
  AnalysisToolId,
} from './analysis.js';
import type {
  DiagnosticsController,
  LayerDiagnostics,
  MapDiagnosticsSnapshot,
} from './diagnostics.js';
import { createAnalysisController } from './analysis-runner.js';
import type { DrawGeometry, DrawMode } from './drawing.js';
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
  DrawingSnapOptions,
  GeoPosition,
  MapClockController,
  MapClockSnapshot,
  MapClockBindOptions,
  MapDrawingController,
  MapLightningController,
  LightningStrikeOptions,
  LightningStyleOptions,
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
import type {
  EnvironmentController,
  EnvironmentEffectKind,
  EnvironmentOptionsMap,
} from './environment.js';
import { EventHub } from './event-hub.js';
import type { QualityController, QualityProfileId, RenderQuality } from './quality.js';
import type { SimulationClock } from './simulation-clock.js';
import type { LayerManager } from '../layers/contracts.js';

export class MapRuntime<TRaw> implements GisMap<TRaw> {
  readonly events = new EventHub<MapEventMap>();
  readonly camera: CameraController;
  readonly basemap: BasemapController;
  readonly terrain: TerrainController;
  readonly clock: MapClockController;
  readonly lightning: MapLightningController;
  readonly coordinates: CoordinateTransform;
  readonly quality: QualityController;
  readonly picking: PickingController;
  readonly scene: SceneController;
  readonly drawing: MapDrawingController;
  readonly environment: EnvironmentController;
  readonly analysis: AnalysisController;
  readonly diagnostics: DiagnosticsController;

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
      edit: (geometry: DrawGeometry) => {
        this.assertReady('drawing.edit');
        return adapter.drawing.edit(geometry);
      },
      get editing() {
        return adapter.drawing.editing;
      },
      setSnap: (snapOptions: DrawingSnapOptions) => {
        this.assertReady('drawing.setSnap');
        adapter.drawing.setSnap(snapOptions);
      },
      get snap() {
        return adapter.drawing.snap;
      },
      insertVertex: (position: GeoPosition, index?: number) => {
        this.assertReady('drawing.insertVertex');
        return adapter.drawing.insertVertex(position, index);
      },
      removeVertex: (index?: number) => {
        this.assertReady('drawing.removeVertex');
        return adapter.drawing.removeVertex(index);
      },
      commitEdit: () => {
        this.assertReady('drawing.commitEdit');
        return adapter.drawing.commitEdit();
      },
      cancelEdit: () => {
        this.assertReady('drawing.cancelEdit');
        adapter.drawing.cancelEdit();
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
      get view() {
        return adapter.camera.view;
      },
      get viewRectangle() {
        return adapter.camera.viewRectangle;
      },
      get metersPerPixel() {
        return adapter.camera.metersPerPixel;
      },
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
    const analysisRuntime = createAnalysisController({
      // 地形取数走适配器；分析算法本身与引擎无关。
      sample: (points, sampleOptions) => adapter.terrain.sample(points, sampleOptions),
    });
    this.analysis = Object.freeze({
      list: () => analysisRuntime.list(),
      run: <T extends AnalysisToolId>(
        tool: T,
        input: AnalysisInputMap[T],
        runOptions?: AnalysisRunOptions,
      ) => {
        this.assertReady('analysis.run');
        return analysisRuntime.run(tool, input, runOptions);
      },
    });
    this.diagnostics = Object.freeze({
      snapshot: (): MapDiagnosticsSnapshot => this.collectDiagnostics(),
    });
    this.environment = Object.freeze({
      get active() {
        return adapter.environment.active;
      },
      set: <K extends EnvironmentEffectKind>(kind: K, options?: EnvironmentOptionsMap[K]) => {
        this.assertReady('environment.set');
        return adapter.environment.set(kind, options);
      },
      setEnabled: (kind: EnvironmentEffectKind, enabled: boolean) => {
        this.assertReady('environment.setEnabled');
        return adapter.environment.setEnabled(kind, enabled);
      },
      clear: (kind: EnvironmentEffectKind) => {
        this.assertReady('environment.clear');
        adapter.environment.clear(kind);
      },
      clearAll: () => {
        this.assertReady('environment.clearAll');
        adapter.environment.clearAll();
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
      get pending() {
        return adapter.terrain.pending;
      },
      get ready() {
        return adapter.terrain.ready;
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
    this.clock = Object.freeze({
      get snapshot(): MapClockSnapshot {
        return adapter.clock.snapshot;
      },
      get time(): number {
        return adapter.clock.time;
      },
      setTime: (time: number | Date) => {
        this.assertReady('clock.setTime');
        adapter.clock.setTime(time);
      },
      setRange: (start: number | Date, end: number | Date) => {
        this.assertReady('clock.setRange');
        adapter.clock.setRange(start, end);
      },
      setMultiplier: (multiplier: number) => {
        this.assertReady('clock.setMultiplier');
        adapter.clock.setMultiplier(multiplier);
      },
      setAnimating: (animating: boolean) => {
        this.assertReady('clock.setAnimating');
        adapter.clock.setAnimating(animating);
      },
      bind: (source: SimulationClock, options?: MapClockBindOptions) => {
        this.assertReady('clock.bind');
        return adapter.clock.bind(source, options);
      },
    });
    this.lightning = Object.freeze({
      get activeCount(): number {
        return adapter.lightning.activeCount;
      },
      get flashLevel(): number {
        return adapter.lightning.flashLevel;
      },
      get maxActive(): number {
        return adapter.lightning.maxActive;
      },
      strike: (options: LightningStrikeOptions) => {
        this.assertReady('lightning.strike');
        return adapter.lightning.strike(options);
      },
      cancel: (id: string) => {
        this.assertReady('lightning.cancel');
        return adapter.lightning.cancel(id);
      },
      cancelAll: () => {
        this.assertReady('lightning.cancelAll');
        adapter.lightning.cancelAll();
      },
      setStyle: (options: LightningStyleOptions) => {
        this.assertReady('lightning.setStyle');
        adapter.lightning.setStyle(options);
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

  /** 汇总诊断读数；任何一个读数不可用都不影响其它字段，也不抛错。 */
  private collectDiagnostics(): MapDiagnosticsSnapshot {
    const engine = this.adapter.getEngineDiagnostics?.();
    let view: MapDiagnosticsSnapshot['camera']['view'];
    let viewRectangle: MapDiagnosticsSnapshot['camera']['viewRectangle'];
    try {
      view = this.adapter.camera.view;
      viewRectangle = this.adapter.camera.viewRectangle;
    } catch {
      // 位姿不可读是诊断场景本身要暴露的信息，不在快照里抛出来。
      view = undefined;
      viewRectangle = undefined;
    }
    const layers: LayerDiagnostics[] = this.adapter.layers.list().map((info) => ({
      ...info,
      errorCount: this.adapter.layers.get(info.id)?.errorCount ?? 0,
    }));
    return {
      id: this.id,
      state: this.currentState,
      camera: {
        view,
        viewRectangle,
        recoveryCount: engine?.cameraRecoveryCount ?? 0,
      },
      quality: this.adapter.quality.snapshot,
      layers,
      basemap: {
        type: this.adapter.basemap.type,
        visible: this.adapter.basemap.visible,
        opacity: this.adapter.basemap.opacity,
        errorCount: this.adapter.basemap.errorCount,
      },
      terrain: { type: this.adapter.terrain.type, pending: this.adapter.terrain.pending },
      scene: {
        mode: this.adapter.scene.mode,
        morphing: this.adapter.scene.morphing,
      },
      environment: this.adapter.environment.active,
      drawing: {
        mode: this.adapter.drawing.mode,
        vertexCount: this.adapter.drawing.vertexCount,
        editing: this.adapter.drawing.editing !== undefined,
      },
    };
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
