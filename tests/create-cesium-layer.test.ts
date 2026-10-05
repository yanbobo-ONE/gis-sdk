import { describe, expect, it, vi } from 'vitest';

const adapters = vi.hoisted(() => ({
  geojson: vi.fn(() => Promise.resolve({ id: 'geojson-handle' })),
  tiles3d: vi.fn(() => Promise.resolve({ id: 'tileset-handle' })),
  singleImage: vi.fn(() => Promise.resolve({ id: 'single-image-handle' })),
  model: vi.fn(() => Promise.resolve({ id: 'model-handle' })),
  heatmap: vi.fn(() => Promise.resolve({ id: 'heatmap-handle' })),
  wind: vi.fn(() => Promise.resolve({ id: 'wind-handle' })),
  tms: vi.fn(() => Promise.resolve({ id: 'tms-handle' })),
  wmts: vi.fn(() => Promise.resolve({ id: 'wmts-handle' })),
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

vi.mock('../src/cesium/layers/single-image-layer.js', () => ({
  createSingleImageLayer: adapters.singleImage,
}));

vi.mock('../src/cesium/layers/model-layer.js', () => ({
  createModelLayer: adapters.model,
}));

vi.mock('../src/cesium/layers/heatmap-layer.js', () => ({
  createHeatmapLayer: adapters.heatmap,
}));

vi.mock('../src/cesium/layers/wind-field-layer.js', () => ({
  createWindFieldLayer: adapters.wind,
}));

vi.mock('../src/cesium/layers/tiled-imagery-layer.js', () => ({
  createTmsLayer: adapters.tms,
  createWmtsLayer: adapters.wmts,
}));

import { createCesiumLayer } from '../src/cesium/layers/create-cesium-layer.js';
import { ModelAppearanceShaders } from '../src/cesium/layers/model-appearance.js';
import { LoadLimiter } from '../src/cesium/load-limiter.js';
import type { LayerFactoryContext } from '../src/layers/layer-runtime.js';

const context: LayerFactoryContext = {
  signal: new AbortController().signal,
  onDisposed: () => undefined,
};
const services = {
  modelLoad: new LoadLimiter(4),
  modelAppearance: new ModelAppearanceShaders(),
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
    const tmsSpec = {
      id: 'terrain',
      type: 'tms' as const,
      url: '/tiles/terrain',
    };
    const wmtsSpec = {
      id: 'imagery',
      type: 'wmts' as const,
      url: '/wmts',
      layer: 'city:imagery',
      style: 'default',
      tileMatrixSetID: 'WebMercatorQuad',
    };
    const singleImageSpec = { id: 'survey', type: 'single-image' as const, url: '/survey.png' };
    const modelSpec = {
      id: 'vehicle',
      type: 'model' as const,
      url: '/vehicle.glb',
      position: { longitude: 116, latitude: 40 },
    };

    const windSpec = {
      id: 'wind',
      type: 'wind-field' as const,
      field: {
        axes: {
          lon: { start: 116, step: 1, count: 2 },
          lat: { start: 39, step: 1, count: 2 },
          height: { start: 0, step: 1, count: 2 },
        },
        u: new Float32Array(8),
        v: new Float32Array(8),
      },
    };

    const heatmapSpec = {
      id: 'density',
      type: 'heatmap' as const,
      points: [{ longitude: 116.391, latitude: 39.907 }],
    };

    await expect(
      createCesiumLayer(viewer as never, heatmapSpec, context, services),
    ).resolves.toEqual({
      id: 'heatmap-handle',
    });
    await expect(createCesiumLayer(viewer as never, windSpec, context, services)).resolves.toEqual({
      id: 'wind-handle',
    });
    await expect(
      createCesiumLayer(viewer as never, geojsonSpec, context, services),
    ).resolves.toEqual({
      id: 'geojson-handle',
    });
    await expect(createCesiumLayer(viewer as never, wmsSpec, context, services)).resolves.toEqual({
      id: 'wms-handle',
    });
    await expect(
      createCesiumLayer(viewer as never, tilesetSpec, context, services),
    ).resolves.toEqual({
      id: 'tileset-handle',
    });
    await expect(createCesiumLayer(viewer as never, tmsSpec, context, services)).resolves.toEqual({
      id: 'tms-handle',
    });
    await expect(createCesiumLayer(viewer as never, wmtsSpec, context, services)).resolves.toEqual({
      id: 'wmts-handle',
    });
    await expect(
      createCesiumLayer(viewer as never, singleImageSpec, context, services),
    ).resolves.toEqual({
      id: 'single-image-handle',
    });
    await expect(createCesiumLayer(viewer as never, modelSpec, context, services)).resolves.toEqual(
      {
        id: 'model-handle',
      },
    );
    expect(adapters.geojson).toHaveBeenCalledWith(viewer, geojsonSpec, context);
    expect(adapters.wms).toHaveBeenCalledWith(viewer, wmsSpec, context);
    expect(adapters.tiles3d).toHaveBeenCalledWith(viewer, tilesetSpec, context);
    expect(adapters.tms).toHaveBeenCalledWith(viewer, tmsSpec, context);
    expect(adapters.wmts).toHaveBeenCalledWith(viewer, wmtsSpec, context);
    expect(adapters.singleImage).toHaveBeenCalledWith(viewer, singleImageSpec, context);
    expect(adapters.model).toHaveBeenCalledWith(viewer, modelSpec, context, services);
    // 热力图把注入的栅格化出口一起透传（services 没给时由工厂用默认 canvas 实现）。
    expect(adapters.heatmap).toHaveBeenCalledWith(viewer, heatmapSpec, context, undefined);
    expect(adapters.wind).toHaveBeenCalledWith(viewer, windSpec, context);
  });
});
