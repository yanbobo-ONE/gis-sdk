import { describe, expect, it, vi } from 'vitest';

const adapters = vi.hoisted(() => ({
  geojson: vi.fn(() => Promise.resolve({ id: 'geojson-handle' })),
  tiles3d: vi.fn(() => Promise.resolve({ id: 'tileset-handle' })),
  wms: vi.fn(() => Promise.resolve({ id: 'wms-handle' })),
}));

vi.mock('../src/cesium/layers/geojson-layer.js', () => ({
  createGeoJsonLayer: adapters.geojson,
}));

vi.mock('../src/cesium/layers/wms-layer.js', () => ({
  createWmsLayer: adapters.wms,
}));

vi.mock('../src/cesium/layers/tileset-layer.js', () => ({
  createTiles3dLayer: adapters.tiles3d,
}));

import { createCesiumLayer } from '../src/cesium/layers/create-cesium-layer.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

const context: LayerFactoryContext = {
  signal: new AbortController().signal,
  onDisposed: () => undefined,
};

describe('createCesiumLayer', () => {
  it('dispatches discriminated specs to the matching Cesium adapter', async () => {
    const viewer = { kind: 'viewer' };
    const geojsonSpec = {
      id: 'targets',
      type: 'geojson' as const,
      data: { type: 'FeatureCollection' as const, features: [] },
    };
    const wmsSpec = {
      id: 'roads',
      type: 'wms' as const,
      url: '/wms',
      layers: 'roads',
    };
    const tilesetSpec = {
      id: 'city',
      type: '3d-tiles' as const,
      url: '/tiles/city/tileset.json',
    };

    await expect(createCesiumLayer(viewer as never, geojsonSpec, context)).resolves.toEqual({
      id: 'geojson-handle',
    });
    await expect(createCesiumLayer(viewer as never, wmsSpec, context)).resolves.toEqual({
      id: 'wms-handle',
    });
    await expect(createCesiumLayer(viewer as never, tilesetSpec, context)).resolves.toEqual({
      id: 'tileset-handle',
    });
    expect(adapters.geojson).toHaveBeenCalledWith(viewer, geojsonSpec, context);
    expect(adapters.wms).toHaveBeenCalledWith(viewer, wmsSpec, context);
    expect(adapters.tiles3d).toHaveBeenCalledWith(viewer, tilesetSpec, context);
  });
});
