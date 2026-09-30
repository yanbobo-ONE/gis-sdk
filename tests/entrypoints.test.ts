import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createMap } from '../src/entries/cesium.js';
import {
  convexHull,
  createAnalysisController,
  createAnalysisWorkerPool,
  createTrackTimeline,
  curvatureDropMeters,
  czmlFromPositions,
  DataPipeline,
  DataPipelineFrameScheduler,
  DataPipelineMessageAdapter,
  DEPTH_FOG_DEFAULTS,
  DrawingEditMachine,
  DrawingStateMachine,
  EnvironmentTimeline,
  evaluateHorizon,
  evaluateLineOfSight,
  EventHub,
  FieldGuard,
  GisError,
  isEditableGeometry,
  isPointInPolygon,
  isValidDrawPosition,
  measureDistance,
  normalizeBearing,
  normalizePositions,
  parseCsv,
  positionsFromCzml,
  PRECIPITATION_DEFAULTS,
  qualityProfiles,
  REALTIME_SOCKET_WILDCARD,
  registerChinaCrs,
  RealtimeSocketClient,
  RenderQualityMonitor,
  ReplayTimeline,
  resolveEnvironmentOptions,
  SimulationClock,
  simplifyPath,
  simplifyRing,
  slopeAspectFromPlane,
  surfacePathLength,
  tracksFromCzml,
  transformGeoPoint,
  validatePolygon,
} from '../src/entries/core.js';
import type {
  AnalysisController,
  AnalysisToolId,
  CoordinateTransform,
  CrsDescriptor,
  DistanceMeasurement,
  GeoPoint,
  GeoPolygon,
  DataPipelineMessageAdapterOptions,
  DataPipelineMessageSource,
  DataPipelineFrameSchedulerOptions,
  DataPipelineOptions,
  DataPipelineStats,
  QualityController,
  RenderQuality,
  TerrainSample,
} from '../src/entries/core.js';
import { wmsFilter } from '../src/entries/layers.js';
import type { CreateMapOptions, QualityOptions } from '../src/entries/cesium.js';
import type { GisMap, TerrainSetOptions } from '../src/entries/core.js';
import type {
  AnalysisInputMap,
  AnalysisResultMap,
  CameraViewSnapshot,
  CzmlTrack,
  DiagnosticsController,
  EnvironmentController,
  EnvironmentEffectState,
  FieldGuardRecord,
  MapDiagnosticsSnapshot,
  PolygonIssue,
  RealtimeSocketMessage,
  RealtimeSocketStats,
  ReplayTimeRange,
  SimplifyResult,
  TerrainProfilePoint,
} from '../src/entries/core.js';
import type {
  CzmlLayerSpec,
  ImageryLayerHandle,
  LayerManager,
  ModelAppearanceOptions,
  ModelLayerHandle,
  ModelLayerSpec,
  ModelTransform,
  SingleImageLayerSpec,
  Tiles3dLayerSpec,
  TmsLayerSpec,
  WmsLayerSpec,
  WmtsLayerSpec,
} from '../src/entries/layers.js';

describe('package subpath entrypoints', () => {
  it('exposes independent core, Cesium, and layer entrypoints', () => {
    interface SubpathTypes {
      readonly options: CreateMapOptions;
      readonly qualityOptions: QualityOptions;
      readonly terrainSetOptions: TerrainSetOptions;
      readonly map: GisMap;
      readonly layers: LayerManager;
      readonly tileset: Tiles3dLayerSpec;
      readonly czml: CzmlLayerSpec;
      readonly wms: WmsLayerSpec;
      readonly tms: TmsLayerSpec;
      readonly wmts: WmtsLayerSpec;
      readonly singleImage: SingleImageLayerSpec;
      readonly model: ModelLayerSpec;
      readonly modelHandle: ModelLayerHandle;
      readonly modelAppearance: ModelAppearanceOptions;
      readonly modelTransform: ModelTransform;
      readonly coordinates: CoordinateTransform;
      readonly terrainSample: TerrainSample;
      readonly quality: QualityController;
      readonly qualityProfile: RenderQuality;
      readonly analysis: AnalysisController;
      readonly analysisTool: AnalysisToolId;
      readonly crs: CrsDescriptor;
      readonly distance: DistanceMeasurement;
      readonly geoPoint: GeoPoint;
      readonly geoPolygon: GeoPolygon;
      readonly imagery: ImageryLayerHandle;
      readonly pipeline: DataPipeline<{ readonly id: string }>;
      readonly messageAdapter: DataPipelineMessageAdapter<{ readonly id: string }>;
      readonly messageAdapterOptions: DataPipelineMessageAdapterOptions<{ readonly id: string }>;
      readonly frameScheduler: DataPipelineFrameScheduler<{ readonly id: string }>;
      readonly frameSchedulerOptions: DataPipelineFrameSchedulerOptions<{ readonly id: string }>;
      readonly pipelineOptions: DataPipelineOptions<{ readonly id: string }>;
      readonly pipelineStats: DataPipelineStats;
    }

    const compileOnly: SubpathTypes | undefined = undefined;
    const worker = undefined as unknown as Worker;
    const messagePort = undefined as unknown as MessagePort;
    const workerSource: DataPipelineMessageSource = worker;
    const messagePortSource: DataPipelineMessageSource = messagePort;

    expect(createMap).toBeTypeOf('function');
    expect(EventHub).toBeTypeOf('function');
    expect(GisError).toBeTypeOf('function');
    expect(DataPipeline).toBeTypeOf('function');
    expect(DataPipelineFrameScheduler).toBeTypeOf('function');
    expect(DataPipelineMessageAdapter).toBeTypeOf('function');
    expect(RenderQualityMonitor).toBeTypeOf('function');
    expect(Object.isFrozen(qualityProfiles.default)).toBe(true);
    expect(measureDistance).toBeTypeOf('function');
    expect(isPointInPolygon).toBeTypeOf('function');
    expect(registerChinaCrs).toBeTypeOf('function');
    expect(transformGeoPoint).toBeTypeOf('function');
    expect(wmsFilter.eq('status', 'OPEN')).toEqual({
      op: 'eq',
      property: 'status',
      value: 'OPEN',
    });
    expect(compileOnly).toBeUndefined();
    expect(parseCsv('a\n1\n').columns).toEqual(['a']);
    expect(workerSource).toBe(worker);
    expect(messagePortSource).toBe(messagePort);
  });

  it('exposes the ported capability surface from /core', () => {
    // 类型surface：只做编译期引用，运行期无副作用。
    interface PortedTypes {
      readonly diagnostics: MapDiagnosticsSnapshot;
      readonly diagnosticsController: DiagnosticsController;
      readonly environment: EnvironmentController;
      readonly environmentState: EnvironmentEffectState;
      readonly analysisInput: AnalysisInputMap['convex-hull'];
      readonly analysisResult: AnalysisResultMap['simplify'];
      readonly polygonIssue: PolygonIssue;
      readonly simplify: SimplifyResult;
      readonly czmlTrack: CzmlTrack;
      readonly cameraView: CameraViewSnapshot;
      readonly guardRecord: FieldGuardRecord;
      readonly replayRange: ReplayTimeRange;
      readonly profile: TerrainProfilePoint;
      readonly socketStats: RealtimeSocketStats;
      readonly socketMessage: RealtimeSocketMessage;
    }
    const compileOnly: PortedTypes | undefined = undefined;
    expect(compileOnly).toBeUndefined();

    // 类与函数
    for (const value of [
      RealtimeSocketClient,
      ReplayTimeline,
      SimulationClock,
      EnvironmentTimeline,
      FieldGuard,
      DrawingEditMachine,
      DrawingStateMachine,
      createAnalysisController,
  createAnalysisWorkerPool,
  createTrackTimeline,
      convexHull,
      simplifyPath,
      simplifyRing,
      validatePolygon,
      evaluateLineOfSight,
      evaluateHorizon,
      slopeAspectFromPlane,
      surfacePathLength,
      curvatureDropMeters,
      normalizeBearing,
      normalizePositions,
      czmlFromPositions,
      tracksFromCzml,
      positionsFromCzml,
      isEditableGeometry,
      isValidDrawPosition,
      resolveEnvironmentOptions,
    ]) {
      expect(value).toBeTypeOf('function');
    }

    // 冻结的常量
    expect(Object.isFrozen(DEPTH_FOG_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(PRECIPITATION_DEFAULTS)).toBe(true);
    expect(REALTIME_SOCKET_WILDCARD).toBe('*');

    // 端到端小样：凸包 → 抽稀 → 校验，验证导出之间能配合。
    const hull = convexHull([
      { longitude: 0, latitude: 0 },
      { longitude: 1, latitude: 0 },
      { longitude: 1, latitude: 1 },
      { longitude: 0.4, latitude: 0.4 },
    ]);
    expect(hull.length).toBeGreaterThanOrEqual(3);
    expect(simplifyPath(hull, 1_000).points.length).toBeLessThanOrEqual(hull.length);
    expect(validatePolygon({ outer: hull })).toEqual([]);
  });

  it('keeps the new surface exported from the built package entries', async () => {
    // 直接读 dist 的 .d.ts，确认构建产物里也有这些导出（源码有、产物没有是打包配置问题）。
    const coreTypes = await readFile(new URL('../dist/core.d.ts', import.meta.url), 'utf8');
    for (const name of [
      'RealtimeSocketClient',
      'ReplayTimeline',
      'EnvironmentTimeline',
      'FieldGuard',
      'convexHull',
      'simplifyPath',
      'validatePolygon',
      'createAnalysisController',
      'createAnalysisWorkerPool',
      'createTrackTimeline',
      'tracksFromCzml',
      'DrawingEditMachine',
      'MapDiagnosticsSnapshot',
      'RealtimeSocketStats',
    ]) {
      expect(coreTypes).toContain(name);
    }
    // 跨入口共享的类型落在 contracts-*.d.ts 分块里，因此按整个 dist 的声明文件核对。
    const distFiles = await readdir(new URL('../dist/', import.meta.url));
    const declarations = (
      await Promise.all(
        distFiles
          .filter((name) => name.endsWith('.d.ts'))
          .map((name) => readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8')),
      )
    ).join('\n');
    expect(declarations).toContain('EnvironmentController');
    expect(declarations).toContain('DiagnosticsController');
  });
});
