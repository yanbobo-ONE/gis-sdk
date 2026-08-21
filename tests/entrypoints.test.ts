import { describe, expect, it } from 'vitest';

import { createMap } from '../src/entries/cesium.js';
import { EventHub, GisError } from '../src/entries/core.js';
import { wmsFilter } from '../src/entries/layers.js';
import type { CreateMapOptions } from '../src/entries/cesium.js';
import type { GisMap } from '../src/entries/core.js';
import type { LayerManager, WmsLayerSpec } from '../src/entries/layers.js';

describe('package subpath entrypoints', () => {
  it('exposes independent core, Cesium, and layer entrypoints', () => {
    interface SubpathTypes {
      readonly options: CreateMapOptions;
      readonly map: GisMap;
      readonly layers: LayerManager;
      readonly wms: WmsLayerSpec;
    }

    const compileOnly: SubpathTypes | undefined = undefined;

    expect(createMap).toBeTypeOf('function');
    expect(EventHub).toBeTypeOf('function');
    expect(GisError).toBeTypeOf('function');
    expect(wmsFilter.eq('status', 'OPEN')).toEqual({
      op: 'eq',
      property: 'status',
      value: 'OPEN',
    });
    expect(compileOnly).toBeUndefined();
  });
});
