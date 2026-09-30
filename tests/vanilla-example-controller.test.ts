import { describe, expect, it, vi } from 'vitest';

import { createVanillaExampleController } from '../examples/vanilla/src/example-controller.js';
import type {
  AnalysisController,
  AnalysisResultMap,
  CameraController,
} from '../src/entries/core.js';
import type {
  CzmlLayerHandle,
  GeoJsonLayerSpec,
  LayerManager,
  PointsLayerHandle,
  WmsLayerSpec,
} from '../src/entries/layers.js';

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
  const points = {
    id: 'example-points',
    type: 'points' as const,
    state: 'ready' as const,
    visible: true,
    count: 200,
    labelCount: 200,
    setVisible: vi.fn(),
    setData: vi.fn(() => Promise.resolve()),
    setStyle: vi.fn((style: { readonly labels?: { readonly enabled?: boolean } }) => {
      points.labelCount = style.labels?.enabled === false ? 0 : points.count;
    }),
  };
  const czml = {
    id: 'example-czml',
    type: 'czml' as const,
    state: 'ready' as const,
    visible: true,
    entityCount: 1,
    setVisible: vi.fn(),
    setData: vi.fn(() => Promise.resolve()),
  };
  const add = vi.fn(
    (
      spec:
        GeoJsonLayerSpec | WmsLayerSpec | { readonly type: 'points' } | { readonly type: 'czml' },
    ) => {
      if (spec.type === 'points') {
        return Promise.resolve(points as unknown as PointsLayerHandle);
      }
      if (spec.type === 'czml') {
        return Promise.resolve(czml as unknown as CzmlLayerHandle);
      }
      return Promise.resolve(spec.type === 'geojson' ? geoJson : wms);
    },
  );
  const environmentSet = vi.fn();
  const environmentClearAll = vi.fn();
  const lineOfSight = vi.fn((): Promise<AnalysisResultMap['line-of-sight']> =>
    Promise.resolve({
      visible: false,
      minClearanceMeters: -12.5,
      blockedAtIndex: 7,
      sampleCount: 31,
      algorithmVersion: 1,
    }),
  );
  const slopeAspect = vi.fn(() =>
    Promise.resolve({
      slopeDegrees: 12.5,
      aspectDegrees: 200,
      sampleCount: 9,
      centerHeightMeters: 30,
      algorithmVersion: 1,
    }),
  );
  const analysisRun = vi.fn((tool: string) =>
    tool === 'line-of-sight' ? lineOfSight() : slopeAspect(),
  );
  const terrainSet = vi.fn(() => Promise.resolve());
  const terrain = {
    type: 'ellipsoid' as 'cesium-terrain' | 'ellipsoid',
    pending: false,
    ready: Promise.resolve(),
    set: terrainSet,
  };

  const map = {
    state: 'ready' as const,
    camera: {
      view: {
        longitude: 116.391,
        latitude: 39.907,
        height: 1_234,
        heading: 12,
        pitch: -45,
        roll: 0,
      },
      metersPerPixel: 120,
    } as unknown as Pick<CameraController, 'view' | 'metersPerPixel'>,
    environment: { set: environmentSet, clearAll: environmentClearAll },
    terrain,
    analysis: { list: vi.fn(() => []), run: analysisRun } as unknown as AnalysisController,
    layers: {
      add,
      remove: vi.fn(() => Promise.resolve(true)),
      list: vi.fn(() => [
        { id: geoJson.id, type: geoJson.type, state: geoJson.state, visible: geoJson.visible },
        { id: wms.id, type: wms.type, state: wms.state, visible: wms.visible },
      ]),
    } as unknown as Pick<LayerManager, 'add' | 'list' | 'remove'>,
    raw: {
      viewer: {
        dataSources: { get: vi.fn(() => geoJson) },
        flyTo: vi.fn(() => Promise.resolve(true)),
      },
    },
    destroy: vi.fn(() => Promise.resolve()),
  };
  const createMap = vi.fn(
    (options: {
      readonly container: string | HTMLElement;
      readonly cesiumBaseUrl: string;
      readonly terrain?: { readonly type: 'cesium-terrain'; readonly url: string };
    }) => {
      // 桩按真实语义建模 pending 过渡：创建后仍在途，元数据兑现后转 false。
      if (options.terrain) {
        terrain.type = 'cesium-terrain';
        terrain.pending = true;
        terrain.ready = new Promise<void>((resolve) => {
          setTimeout(() => {
            terrain.pending = false;
            resolve();
          }, 0);
        });
      } else {
        terrain.type = 'ellipsoid';
        terrain.pending = false;
        terrain.ready = Promise.resolve();
      }
      return map;
    },
  );
  const filter = { op: 'eq' as const, property: 'status', value: 'ACTIVE' };
  const createActiveFilter = vi.fn(() => filter);

  return {
    analysisRun,
    createActiveFilter,
    createMap,
    czml,
    environmentClearAll,
    environmentSet,
    filter,
    geoJson,
    lineOfSight,
    map,
    points,
    slopeAspect,
    terrainSet,
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
      terrainUrl: '/__test/terrain/',
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
      // 示例带自定义鉴权头，用来验证请求头真的发到了服务端。
      headers: { 'X-Example-Auth': 'gis-sdk-example-token' },
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
      terrainUrl: '/__test/terrain/',
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
      terrainUrl: '/__test/terrain/',
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
    expect(harness.analysisRun).toHaveBeenCalledWith('line-of-sight', {
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
      terrainUrl: '/__test/terrain/',
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

  it('adds a labelled point layer, toggles labels, clusters by pixel and loads CZML', async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: '/data/operations.geojson',
      wmsUrl: '/wms',
      terrainUrl: '/__test/terrain/',
    });
    await controller.start('map');

    await controller.addPointLayer();
    expect(harness.points.count).toBe(200);
    expect(controller.snapshot().points).toBe('点位 200 / 标签 200');

    controller.togglePointLabels();
    expect(harness.points.setStyle).toHaveBeenCalledWith({ labels: { enabled: false } });
    expect(controller.snapshot().points).toBe('点位 200 / 标签 0');

    controller.clusterPoints();
    // 每像素 120 米 → 网格 5760 米，2000 个点会聚成若干簇。
    expect(controller.snapshot().clusters).toMatch(/^聚合 \d+ 簇 \/ 2000 点（每簇 48 像素）$/);

    await controller.addCzmlLayer();
    expect(controller.snapshot().czml).toBe('实体 1（60 个采样点）');
  });

  it('runs a batch analysis with per-item results and reports progress', async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: '/data/operations.geojson',
      wmsUrl: '/wms',
      terrainUrl: '/__test/terrain/',
    });
    await controller.start('map');

    await controller.runBatchAnalysis();

    expect(harness.analysisRun).toHaveBeenCalledTimes(20);
    expect(harness.analysisRun.mock.calls[0]?.[0]).toBe('slope-aspect');
    expect(controller.snapshot().batch).toBe('完成 20 / 失败 0 / 总数 20');
  });

  it('declares terrain at map creation, awaits ready, then falls back to ellipsoid', async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: '/data/operations.geojson',
      wmsUrl: '/wms',
      terrainUrl: '/__test/terrain/',
    });
    await controller.start('map');

    await controller.createWithTerrain();

    expect(harness.createMap).toHaveBeenNthCalledWith(2, {
      container: 'map',
      cesiumBaseUrl: '/cesium/',
      terrain: { type: 'cesium-terrain', url: '/__test/terrain/' },
    });
    expect(harness.terrainSet).toHaveBeenCalledWith({ type: 'ellipsoid' });
    expect(controller.snapshot().terrain).toBe(
      '创建期声明 → cesium-terrain / 加载中 pending=true / 兑现后 pending=false',
    );
  });
});
