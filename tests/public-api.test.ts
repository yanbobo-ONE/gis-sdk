import { describe, expect, it } from 'vitest';

import {
  DataPipeline,
  DataPipelineFrameScheduler,
  DataPipelineMessageAdapter,
  wmsFilter,
} from '../src/index.js';
import type {
  DataPipelineFrameSchedulerOptions,
  DataPipelineMessageAdapterOptions,
  DataPipelineOptions,
  DataPipelineStats,
  GeoJsonLayerHandle,
  GeoJsonLayerSpec,
  ImageryLayerHandle,
  LayerManager,
  Tiles3dLayerSpec,
  TmsLayerSpec,
  WmtsLayerSpec,
  WmsLayerHandle,
  WmsLayerSpec,
} from '../src/index.js';

describe('package public layer interface', () => {
  it('exports typed WMS filter builders from the package root', () => {
    expect(wmsFilter.and(wmsFilter.eq('status', 'OPEN'), wmsFilter.gte('priority', 2))).toEqual({
      op: 'and',
      filters: [
        { op: 'eq', property: 'status', value: 'OPEN' },
        { op: 'gte', property: 'priority', value: 2 },
      ],
    });
  });

  it('keeps capability-specific handles assignable to the common manager surface', () => {
    interface PublicLayerTypes {
      readonly manager: LayerManager;
      readonly tilesetSpec: Tiles3dLayerSpec;
      readonly geoJsonSpec: GeoJsonLayerSpec;
      readonly geoJsonHandle: GeoJsonLayerHandle;
      readonly wmsSpec: WmsLayerSpec;
      readonly wmsHandle: WmsLayerHandle;
      readonly tmsSpec: TmsLayerSpec;
      readonly wmtsSpec: WmtsLayerSpec;
      readonly imageryHandle: ImageryLayerHandle;
      readonly pipelineOptions: DataPipelineOptions<{ readonly id: string }>;
      readonly frameSchedulerOptions: DataPipelineFrameSchedulerOptions<{ readonly id: string }>;
      readonly messageAdapterOptions: DataPipelineMessageAdapterOptions<{ readonly id: string }>;
      readonly pipelineStats: DataPipelineStats;
    }
    const compileOnly: PublicLayerTypes | undefined = undefined;

    expect(compileOnly).toBeUndefined();
    expect(DataPipeline).toBeTypeOf('function');
    expect(DataPipelineFrameScheduler).toBeTypeOf('function');
    expect(DataPipelineMessageAdapter).toBeTypeOf('function');
  });
});
