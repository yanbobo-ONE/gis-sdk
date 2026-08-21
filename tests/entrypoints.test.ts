import { describe, expect, it } from 'vitest';

import { createMap } from '../src/entries/cesium.js';
import {
  DataPipeline,
  DataPipelineMessageAdapter,
  EventHub,
  GisError,
} from '../src/entries/core.js';
import type {
  DataPipelineMessageAdapterOptions,
  DataPipelineMessageSource,
  DataPipelineOptions,
  DataPipelineStats,
} from '../src/entries/core.js';
import { wmsFilter } from '../src/entries/layers.js';
import type { CreateMapOptions } from '../src/entries/cesium.js';
import type { GisMap } from '../src/entries/core.js';
import type { LayerManager, Tiles3dLayerSpec, WmsLayerSpec } from '../src/entries/layers.js';

describe('package subpath entrypoints', () => {
  it('exposes independent core, Cesium, and layer entrypoints', () => {
    interface SubpathTypes {
      readonly options: CreateMapOptions;
      readonly map: GisMap;
      readonly layers: LayerManager;
      readonly tileset: Tiles3dLayerSpec;
      readonly wms: WmsLayerSpec;
      readonly pipeline: DataPipeline<{ readonly id: string }>;
      readonly messageAdapter: DataPipelineMessageAdapter<{ readonly id: string }>;
      readonly messageAdapterOptions: DataPipelineMessageAdapterOptions<{ readonly id: string }>;
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
    expect(DataPipelineMessageAdapter).toBeTypeOf('function');
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
