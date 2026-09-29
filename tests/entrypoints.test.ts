import { describe, expect, it } from 'vitest';

import { createMap } from '../src/entries/cesium.js';
import {
  DataPipeline,
  DataPipelineFrameScheduler,
  DataPipelineMessageAdapter,
  EventHub,
  GisError,
  isPointInPolygon,
  measureDistance,
  qualityProfiles,
  registerChinaCrs,
  RenderQualityMonitor,
  transformGeoPoint,
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
    expect(workerSource).toBe(worker);
    expect(messagePortSource).toBe(messagePort);
  });
});
