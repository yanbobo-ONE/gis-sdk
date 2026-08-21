import { describe, expect, it, vi } from 'vitest';

import { createVanillaExampleController } from '../examples/vanilla/src/example-controller.js';

function createHarness() {
  const geoJson = {
    id: 'example-geojson',
    type: 'geojson' as const,
    state: 'ready' as const,
    visible: true,
    setVisible: vi.fn(),
    setData: vi.fn(() => Promise.resolve()),
  };
  const wms = {
    id: 'example-wms',
    type: 'wms' as const,
    state: 'ready' as const,
    visible: true,
    opacity: 0.72,
    setVisible: vi.fn(),
    setOpacity: vi.fn(),
    setFilter: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
  };
  const map = {
    state: 'ready' as const,
    layers: {
      add: vi.fn((spec: { type: string }) =>
        Promise.resolve(spec.type === 'geojson' ? geoJson : wms),
      ),
      list: vi.fn(() => [
        { id: geoJson.id, type: geoJson.type, state: geoJson.state, visible: geoJson.visible },
        { id: wms.id, type: wms.type, state: wms.state, visible: wms.visible },
      ]),
    },
    raw: {
      viewer: {
        dataSources: { get: vi.fn(() => geoJson) },
        flyTo: vi.fn(() => Promise.resolve(true)),
      },
    },
    destroy: vi.fn(() => Promise.resolve()),
  };
  const createMap = vi.fn(() => map);
  const filter = { op: 'eq' as const, property: 'status', value: 'ACTIVE' };
  const createActiveFilter = vi.fn(() => filter);

  return { createActiveFilter, createMap, filter, geoJson, map, wms };
}

describe('Vanilla example controller', () => {
  it('starts the packaged map with GeoJSON and WMS layers', async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: '/data/operations.geojson',
      wmsUrl: '/wms',
    });

    await controller.start('map');

    expect(harness.createMap).toHaveBeenCalledWith({
      container: 'map',
      cesiumBaseUrl: '/cesium/',
    });
    expect(harness.map.layers.add).toHaveBeenNthCalledWith(1, {
      id: 'example-geojson',
      type: 'geojson',
      data: '/data/operations.geojson',
      style: {
        marker: { color: '#35d7a0', size: 15 },
        stroke: '#4ee2bd',
        strokeWidth: 3,
        fill: '#22a88455',
      },
    });
    expect(harness.map.layers.add).toHaveBeenNthCalledWith(2, {
      id: 'example-wms',
      type: 'wms',
      url: '/wms',
      layers: 'demo:coverage',
      opacity: 0.72,
      parameters: { format: 'image/png', transparent: true },
    });
    expect(controller.snapshot()).toMatchObject({ state: 'ready', layerCount: 2 });
    expect(harness.map.raw.viewer.flyTo).toHaveBeenCalledWith(harness.geoJson);
  });

  it('routes data, visibility, opacity, filter, reload, and restart operations', async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: '/data/operations.geojson',
      wmsUrl: '/wms',
    });
    await controller.start('map');

    await controller.replaceGeoJson();
    controller.setGeoJsonVisible(false);
    controller.setWmsOpacity(0.4);
    await controller.setWmsFilterEnabled(true);
    await controller.reloadWms();
    await controller.restart();

    expect(harness.geoJson.setData).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FeatureCollection',
      }),
    );
    expect(harness.geoJson.setVisible).toHaveBeenCalledWith(false);
    expect(harness.wms.setOpacity).toHaveBeenCalledWith(0.4);
    expect(harness.wms.setFilter).toHaveBeenCalledWith(harness.filter);
    expect(harness.wms.reload).toHaveBeenCalledTimes(1);
    expect(harness.map.destroy).toHaveBeenCalledTimes(1);
    expect(harness.createMap).toHaveBeenCalledTimes(2);
  });
});
