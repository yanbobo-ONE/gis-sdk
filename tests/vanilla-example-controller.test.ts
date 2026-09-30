import { describe, expect, it, vi } from 'vitest';

import { createVanillaExampleController } from '../examples/vanilla/src/example-controller.js';
import type { AnalysisResultMap } from '../src/entries/core.js';
import type { GeoJsonLayerSpec, WmsLayerSpec } from '../src/entries/layers.js';

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
  const add = vi.fn((spec: GeoJsonLayerSpec | WmsLayerSpec) =>
    Promise.resolve(spec.type === 'geojson' ? geoJson : wms),
  );
  const environmentSet = vi.fn();
  const environmentClearAll = vi.fn();
  const lineOfSight = vi.fn(
    (): Promise<AnalysisResultMap['line-of-sight']> =>
      Promise.resolve({
        visible: false,
        minClearanceMeters: -12.5,
        blockedAtIndex: 7,
        sampleCount: 31,
        algorithmVersion: 1,
      }),
  );
  const map = {
    state: 'ready' as const,
    camera: {
      view: { longitude: 116.391, latitude: 39.907, height: 1_234, heading: 12, pitch: -45, roll: 0 },
    },
    environment: { set: environmentSet, clearAll: environmentClearAll },
    analysis: { run: lineOfSight },
    layers: {
      add,
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

  return {
    createActiveFilter,
    createMap,
    environmentClearAll,
    environmentSet,
    filter,
    geoJson,
    lineOfSight,
    map,
    wms,
  };
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

  it('switches environment presets, runs line of sight, and reads the camera', async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: '/data/operations.geojson',
      wmsUrl: '/wms',
    });
    await controller.start('map');

    controller.setEnvironment('depthFog');
    expect(harness.environmentSet).toHaveBeenCalledWith('depthFog', {
      density: 0.45,
      color: '#9fb6c8',
    });
    expect(controller.snapshot().environment).toBe('depthFog');

    controller.setEnvironment('snow');
    expect(harness.environmentSet).toHaveBeenLastCalledWith('snow', {
      intensity: 'light',
      flakeSize: 0.025,
    });

    controller.setEnvironment('clear');
    expect(harness.environmentClearAll).toHaveBeenCalledOnce();

    await controller.runLineOfSight();
    expect(harness.lineOfSight).toHaveBeenCalledWith('line-of-sight', {
      from: { longitude: 116.3, latitude: 39.85, height: 600 },
      to: { longitude: 116.52, latitude: 40.02, height: 600 },
      samples: 32,
    });
    expect(controller.snapshot().lineOfSight).toContain('被遮挡');

    controller.readCamera();
    expect(controller.snapshot().camera).toContain('116.391');
    expect(controller.snapshot().camera).toContain('朝向 12');
  });

  it('clears environment and analysis readouts on restart', async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: '/data/operations.geojson',
      wmsUrl: '/wms',
    });
    await controller.start('map');
    controller.setEnvironment('rain');
    controller.readCamera();

    await controller.restart();

    const snapshot = controller.snapshot();
    expect(snapshot.environment).toBe('clear');
    expect(snapshot.camera).toBeUndefined();
    expect(snapshot.lineOfSight).toBeUndefined();
  });
});
