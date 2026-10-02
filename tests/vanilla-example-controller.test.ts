import { describe, expect, it, vi } from "vitest";

import {
  createVanillaExampleController,
  requestFrames,
} from "../examples/vanilla/src/example-controller.js";
import type {
  AnalysisController,
  AnalysisResultMap,
  CameraController,
  CoordinateTransform,
  MapClockController,
  MapLightningController,
  PickingController,
  PickingHit,
  QualityController,
  SimulationClock,
} from "../src/entries/core.js";
import type {
  CzmlLayerHandle,
  GeoJsonLayerSpec,
  HeatmapLayerHandle,
  LayerManager,
  PointsLayerHandle,
  WmsLayerHandle,
  WmsLayerSpec,
} from "../src/entries/layers.js";

function createHarness() {
  const geoJson = {
    id: "example-geojson",
    type: "geojson" as const,
    state: "ready" as const,
    visible: true,
    setVisible: vi.fn(),
    setData: vi.fn(() => Promise.resolve()),
  };
  const wms = {
    id: "example-wms",
    type: "wms" as const,
    state: "ready" as const,
    visible: true,
    opacity: 0.72,
    setVisible: vi.fn(),
    setOpacity: vi.fn(),
    setFilter: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
  };
  const points = {
    id: "example-points",
    type: "points" as const,
    state: "ready" as const,
    visible: true,
    count: 200,
    labelCount: 200,
    setVisible: vi.fn(),
    setData: vi.fn(() => Promise.resolve()),
    setStyle: vi.fn(
      (style: { readonly labels?: { readonly enabled?: boolean } }) => {
        points.labelCount = style.labels?.enabled === false ? 0 : points.count;
      },
    ),
  };
  const czml = {
    id: "example-czml",
    type: "czml" as const,
    state: "ready" as const,
    visible: true,
    entityCount: 1,
    setVisible: vi.fn(),
    setData: vi.fn(() => Promise.resolve()),
  };
  // 图层桩按 id 跟踪增删：性能矩阵的清理断言要能真的看见"加上去又收回来"。
  const trackedLayers: {
    id: string;
    type: string;
    state: string;
    visible: boolean;
  }[] = [];
  // 堆叠顺序探针用的假影像集合：数组顺序即叠加顺序。
  const imageryOrder: string[] = [];
  let imageryFrozen = false;
  const createStackableImagery = (id: string) => ({
    id,
    type: "wms" as const,
    state: "ready" as const,
    visible: true,
    opacity: 1,
    setVisible: vi.fn(),
    setOpacity: vi.fn(),
    setFilter: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    get stackIndex(): number | undefined {
      const index = imageryOrder.indexOf(id);
      return index < 0 ? undefined : index;
    },
    raiseToTop: vi.fn(() => {
      const index = imageryOrder.indexOf(id);
      if (imageryFrozen || index < 0 || index === imageryOrder.length - 1) {
        return false;
      }
      imageryOrder.splice(index, 1);
      imageryOrder.push(id);
      return true;
    }),
    lowerToBottom: vi.fn(() => {
      const index = imageryOrder.indexOf(id);
      if (imageryFrozen || index <= 0) {
        return false;
      }
      imageryOrder.splice(index, 1);
      imageryOrder.unshift(id);
      return true;
    }),
  });
  // 热力图桩：记录 setData 的点数并按真实语义回报 pointCount。
  const heatmap = {
    id: "example-heatmap",
    type: "heatmap" as const,
    state: "ready" as const,
    visible: true,
    setData: vi.fn((next: readonly unknown[]) => {
      heatmap.pointCount = next.length;
      return Promise.resolve();
    }),
    setStyle: vi.fn(() => Promise.resolve()),
    setOpacity: vi.fn(),
    setVisible: vi.fn(),
    pointCount: 0,
    opacity: 0.8,
    raise: vi.fn(() => true),
    lower: vi.fn(() => true),
    raiseToTop: vi.fn(() => true),
    lowerToBottom: vi.fn(() => true),
    stackIndex: 0,
    dispose: vi.fn(() => Promise.resolve()),
  };

  const add = vi.fn(
    (
      spec:
        | GeoJsonLayerSpec
        | WmsLayerSpec
        | { readonly id?: string; readonly type: "points" }
        | { readonly id?: string; readonly type: "czml" }
        | {
            readonly id?: string;
            readonly type: "heatmap";
            readonly points?: readonly unknown[];
          },
    ) => {
      if (spec.id) {
        trackedLayers.push({
          id: spec.id,
          type: spec.type,
          state: "ready",
          visible: true,
        });
      }
      if (spec.id?.startsWith("order-")) {
        imageryOrder.push(spec.id);
        return Promise.resolve(
          createStackableImagery(spec.id) as unknown as WmsLayerHandle,
        );
      }
      if (spec.type === "points") {
        return Promise.resolve(points as unknown as PointsLayerHandle);
      }
      if (spec.type === "czml") {
        return Promise.resolve(czml as unknown as CzmlLayerHandle);
      }
      if (spec.type === "heatmap") {
        const points =
          (spec as { readonly points?: readonly unknown[] }).points ?? [];
        heatmap.pointCount = points.length;
        return Promise.resolve(heatmap as unknown as HeatmapLayerHandle);
      }
      return Promise.resolve(spec.type === "geojson" ? geoJson : wms);
    },
  );
  const environmentSet = vi.fn();
  const environmentClearAll = vi.fn();
  const lineOfSight = vi.fn((): Promise<AnalysisResultMap["line-of-sight"]> =>
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
    tool === "line-of-sight" ? lineOfSight() : slopeAspect(),
  );
  const terrainSet = vi.fn(() => Promise.resolve());
  const terrain = {
    type: "ellipsoid" as "cesium-terrain" | "ellipsoid",
    pending: false,
    ready: Promise.resolve(),
    set: terrainSet,
  };

  // 地图时钟桩：按真实语义把源时钟镜像进读数，帧推进由注入的 waitFrames 模拟。
  let clockTime = 0;
  let clockAnimating = false;
  let boundClock: SimulationClock | undefined;
  const syncClock = () => {
    if (!boundClock) {
      return;
    }
    const snapshot = boundClock.snapshot;
    clockTime = snapshot.currentTime ?? clockTime;
    clockAnimating = snapshot.state === "playing";
  };
  const clock = {
    get time() {
      return clockTime;
    },
    get snapshot() {
      return {
        time: clockTime,
        startTime: undefined,
        endTime: undefined,
        multiplier: 1,
        animating: clockAnimating,
      };
    },
    bind: vi.fn((source: SimulationClock) => {
      boundClock = source;
      syncClock();
      return () => {
        boundClock = undefined;
        clockAnimating = false;
      };
    }),
  };
  // 闪电桩：记录触发的闪击，并把亮度读数按包络峰值给出来。
  let lightningActive = 0;
  const lightningStrike = vi.fn((options: { readonly id?: string }) => {
    lightningActive += 1;
    return options.id ?? `lightning-${String(lightningActive)}`;
  });
  const lightning = {
    get activeCount() {
      return lightningActive;
    },
    get flashLevel() {
      return lightningActive > 0 ? 0.97 : 0;
    },
    maxActive: 8,
    strike: lightningStrike,
    cancelAll: vi.fn(() => {
      lightningActive = 0;
    }),
    setStyle: vi.fn(),
    /** 面板探针会在包络起来后再读一次，因此这里保留在演状态即可。 */
    reset: () => {
      lightningActive = 0;
      lightningStrike.mockClear();
    },
  };

  /** 模拟一帧：推进源时钟并镜像，等价于真实适配器在渲染帧里做的事。 */
  const advanceFrames = (count: number) => {
    for (let index = 0; index < count; index += 1) {
      boundClock?.advance(16);
      syncClock();
    }
  };

  const pickListeners = new Set<
    (event: { readonly hit: PickingHit | undefined }) => void
  >();
  const picking = {
    on: vi.fn(
      (
        _kind: string,
        listener: (event: { readonly hit: PickingHit | undefined }) => void,
      ) => {
        pickListeners.add(listener);
        return () => {
          pickListeners.delete(listener);
        };
      },
    ),
    setEnabled: vi.fn(),
  };
  const toWindow = vi.fn((): { x: number; y: number } | undefined => ({
    x: 320,
    y: 200,
  }));
  const setView = vi.fn();
  // 地图事件桩：验收台靠 map:error 显示致命错误（例如渲染循环停止）。
  const mapErrorListeners = new Set<
    (event: { id: string; error: Error }) => void
  >();
  const events = {
    on: vi.fn(
      (
        _type: string,
        listener: (event: { id: string; error: Error }) => void,
      ) => {
        mapErrorListeners.add(listener);
        return () => {
          mapErrorListeners.delete(listener);
        };
      },
    ),
  };

  // 质量桩：矩阵读的是 SDK 自己的帧采样，桩按测试给的读数逐场景推进窗口。
  // 分位与最长帧默认与平均帧耗时一致，需要时由用例单独给出（模拟单次顿挫）。
  let qualitySample = {
    fps: 0,
    frameTimeMs: 0,
    sampleCount: 0,
    maxMs: 0,
    longFrames: 0,
  };
  let adaptive = true;
  const quality = {
    current: { resolutionScale: 1, terrainSse: 2, modelLoadConcurrency: 4 },
    get snapshot() {
      return {
        ...quality.current,
        fps: qualitySample.fps,
        frameTimeMs: qualitySample.frameTimeMs,
        sampleCount: qualitySample.sampleCount,
        frameTimeP50Ms: qualitySample.frameTimeMs,
        frameTimeP95Ms: qualitySample.frameTimeMs,
        frameTimeMaxMs: qualitySample.maxMs,
        longFrames: qualitySample.longFrames,
        longFrameRatio:
          qualitySample.longFrames / (qualitySample.sampleCount || 1),
        degraded: false,
        adaptive,
      };
    },
    get adaptive() {
      return adaptive;
    },
    setProfile: vi.fn(),
    set: vi.fn(),
    setAdaptive: vi.fn((enabled: boolean) => {
      adaptive = enabled;
    }),
  };
  const setQualitySample = (sample: {
    fps: number;
    frameTimeMs: number;
    sampleCount: number;
    maxMs?: number;
    longFrames?: number;
  }) => {
    qualitySample = {
      fps: sample.fps,
      frameTimeMs: sample.frameTimeMs,
      sampleCount: sample.sampleCount,
      maxMs: sample.maxMs ?? sample.frameTimeMs,
      longFrames: sample.longFrames ?? 0,
    };
  };
  const qualityAdaptive = () => adaptive;

  const map = {
    state: "ready" as const,
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
      setView,
    } as unknown as Pick<
      CameraController,
      "view" | "metersPerPixel" | "setView"
    >,
    environment: { set: environmentSet, clearAll: environmentClearAll },
    terrain,
    clock: clock as unknown as Pick<
      MapClockController,
      "time" | "snapshot" | "bind"
    >,
    lightning: lightning as unknown as Pick<
      MapLightningController,
      | "activeCount"
      | "flashLevel"
      | "maxActive"
      | "strike"
      | "cancelAll"
      | "setStyle"
    >,
    coordinates: { toWindow } as unknown as Pick<
      CoordinateTransform,
      "toWindow"
    >,
    quality: quality as unknown as Pick<
      QualityController,
      "current" | "snapshot" | "set" | "setProfile" | "setAdaptive" | "adaptive"
    >,
    picking: picking as unknown as Pick<PickingController, "on" | "setEnabled">,
    analysis: {
      list: vi.fn(() => []),
      run: analysisRun,
    } as unknown as AnalysisController,
    events: events as never,
    layers: {
      add,
      remove: vi.fn((id: string) => {
        const index = trackedLayers.findIndex((layer) => layer.id === id);
        if (index < 0) {
          return Promise.resolve(false);
        }
        trackedLayers.splice(index, 1);
        return Promise.resolve(true);
      }),
      list: vi.fn(() => [...trackedLayers]),
    } as unknown as Pick<LayerManager, "add" | "list" | "remove">,
    raw: {
      viewer: {
        dataSources: { get: vi.fn(() => geoJson) },
        // 探针要把画布内坐标换成页面坐标，桩给出零偏移的画布。
        canvas: {
          getBoundingClientRect: () => ({ left: 0, top: 0 }),
        } as unknown as HTMLCanvasElement,
        flyTo: vi.fn(() => Promise.resolve(true)),
      },
    },
    destroy: vi.fn(() => Promise.resolve()),
  };
  const createMap = vi.fn(
    (options: {
      readonly container: string | HTMLElement;
      readonly cesiumBaseUrl: string;
      readonly terrain?: {
        readonly type: "cesium-terrain";
        readonly url: string;
      };
    }) => {
      // 桩按真实语义建模 pending 过渡：创建后仍在途，元数据兑现后转 false。
      if (options.terrain) {
        terrain.type = "cesium-terrain";
        terrain.pending = true;
        terrain.ready = new Promise<void>((resolve) => {
          setTimeout(() => {
            terrain.pending = false;
            resolve();
          }, 0);
        });
      } else {
        terrain.type = "ellipsoid";
        terrain.pending = false;
        terrain.ready = Promise.resolve();
      }
      return map;
    },
  );
  const filter = { op: "eq" as const, property: "status", value: "ACTIVE" };
  const createActiveFilter = vi.fn(() => filter);

  /** 触发一次拾取事件，等价于验收脚本在画布上真实点了一下。 */
  const emitClick = (hit: PickingHit | undefined) => {
    for (const listener of [...pickListeners]) {
      listener({ hit });
    }
  };

  return {
    advanceFrames,
    analysisRun,
    clock,
    createActiveFilter,
    createMap,
    czml,
    emitClick,
    environmentClearAll,
    environmentSet,
    filter,
    freezeImageryOrder: () => {
      imageryFrozen = true;
    },
    geoJson,
    heatmap,
    layerOrder: () => [...imageryOrder],
    lightning,
    lineOfSight,
    map,
    points,
    emitMapError: (error: Error) => {
      for (const listener of [...mapErrorListeners]) {
        listener({ id: "map-1", error });
      }
    },
    mapErrorListenerCount: () => mapErrorListeners.size,
    qualityAdaptive,
    setQualitySample,
    setView,
    slopeAspect,
    terrainSet,
    toWindow,
    wms,
  };
}

describe("Vanilla example controller", () => {
  it("starts the packaged map with GeoJSON and WMS layers", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });

    await controller.start("map");

    expect(harness.createMap).toHaveBeenCalledWith({
      container: "map",
      cesiumBaseUrl: "/cesium/",
    });
    expect(harness.map.layers.add).toHaveBeenNthCalledWith(1, {
      id: "example-geojson",
      type: "geojson",
      data: "/data/operations.geojson",
      style: {
        marker: { color: "#35d7a0", size: 15 },
        stroke: "#4ee2bd",
        strokeWidth: 3,
        fill: "#22a88455",
      },
    });
    expect(harness.map.layers.add).toHaveBeenNthCalledWith(2, {
      id: "example-wms",
      type: "wms",
      url: "/wms",
      layers: "demo:coverage",
      opacity: 0.72,
      parameters: { format: "image/png", transparent: true },
      // 示例带自定义鉴权头，用来验证请求头真的发到了服务端。
      headers: { "X-Example-Auth": "gis-sdk-example-token" },
    });
    expect(controller.snapshot()).toMatchObject({
      state: "ready",
      layerCount: 2,
    });
    expect(harness.map.raw.viewer.flyTo).toHaveBeenCalledWith(harness.geoJson);
  });

  it("routes data, visibility, opacity, filter, reload, and restart operations", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    await controller.replaceGeoJson();
    controller.setGeoJsonVisible(false);
    controller.setWmsOpacity(0.4);
    await controller.setWmsFilterEnabled(true);
    await controller.reloadWms();
    await controller.restart();

    expect(harness.geoJson.setData).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "FeatureCollection",
      }),
    );
    expect(harness.geoJson.setVisible).toHaveBeenCalledWith(false);
    expect(harness.wms.setOpacity).toHaveBeenCalledWith(0.4);
    expect(harness.wms.setFilter).toHaveBeenCalledWith(harness.filter);
    expect(harness.wms.reload).toHaveBeenCalledTimes(1);
    expect(harness.map.destroy).toHaveBeenCalledTimes(1);
    expect(harness.createMap).toHaveBeenCalledTimes(2);
  });

  it("switches environment presets, runs line of sight, and reads the camera", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    controller.setEnvironment("depthFog");
    expect(harness.environmentSet).toHaveBeenCalledWith("depthFog", {
      density: 0.45,
      color: "#9fb6c8",
    });
    expect(controller.snapshot().environment).toBe("depthFog");

    controller.setEnvironment("snow");
    expect(harness.environmentSet).toHaveBeenLastCalledWith("snow", {
      intensity: "light",
      flakeSize: 0.025,
    });

    controller.setEnvironment("clear");
    expect(harness.environmentClearAll).toHaveBeenCalledOnce();

    await controller.runLineOfSight();
    expect(harness.analysisRun).toHaveBeenCalledWith("line-of-sight", {
      from: { longitude: 116.3, latitude: 39.85, height: 600 },
      to: { longitude: 116.52, latitude: 40.02, height: 600 },
      samples: 32,
    });
    expect(controller.snapshot().lineOfSight).toContain("被遮挡");

    controller.readCamera();
    expect(controller.snapshot().camera).toContain("116.391");
    expect(controller.snapshot().camera).toContain("朝向 12");
  });

  it("clears environment and analysis readouts on restart", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");
    controller.setEnvironment("rain");
    controller.readCamera();

    await controller.restart();

    const snapshot = controller.snapshot();
    expect(snapshot.environment).toBe("clear");
    expect(snapshot.camera).toBeUndefined();
    expect(snapshot.lineOfSight).toBeUndefined();
  });

  it("adds a labelled point layer, toggles labels, clusters by pixel and loads CZML", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    await controller.addPointLayer();
    expect(harness.points.count).toBe(200);
    expect(controller.snapshot().points).toBe("点位 200 / 标签 200");

    controller.togglePointLabels();
    expect(harness.points.setStyle).toHaveBeenCalledWith({
      labels: { enabled: false },
    });
    expect(controller.snapshot().points).toBe("点位 200 / 标签 0");

    controller.clusterPoints();
    // 每像素 120 米 → 网格 5760 米，2000 个点会聚成若干簇。
    expect(controller.snapshot().clusters).toMatch(
      /^聚合 \d+ 簇 \/ 2000 点（每簇 48 像素）$/,
    );

    await controller.addCzmlLayer();
    expect(controller.snapshot().czml).toBe("实体 1（60 个采样点）");
  });

  it("runs a batch analysis with per-item results and reports progress", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    await controller.runBatchAnalysis();

    expect(harness.analysisRun).toHaveBeenCalledTimes(20);
    expect(harness.analysisRun.mock.calls[0]?.[0]).toBe("slope-aspect");
    expect(controller.snapshot().batch).toBe("完成 20 / 失败 0 / 总数 20");
  });

  it("measures a performance matrix over the scripted scenes and restores the map state", async () => {
    const harness = createHarness();
    // 每个场景一次等待 = 一个采样窗口；读数刻意让最重场景最慢，
    // 并在「点位 20 000」那次给一个 180 毫秒的长帧，用来验证摘要会点出最长帧。
    const fpsPerScenario = [60, 58, 44, 21, 52, 48, 60, 39, 21, 22, 20, 23];
    let scenarioIndex = 0;
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
      waitFrames: () => {
        const fps = fpsPerScenario[scenarioIndex] ?? 0;
        // 第 3 个场景（点位 20 000）出现一次 180 毫秒的长帧。
        const hitch = scenarioIndex === 2;
        scenarioIndex += 1;
        harness.setQualitySample({
          fps,
          frameTimeMs: 1000 / (fps || 1),
          sampleCount: 60,
          ...(hitch ? { maxMs: 180, longFrames: 1 } : {}),
        });
        return Promise.resolve();
      },
    });
    await controller.start("map");

    await controller.measurePerformanceMatrix();

    const rows = JSON.parse(
      controller.snapshot().performanceMatrix ?? "[]",
    ) as {
      scenario: string;
      fps: number;
      samples: number;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      longFrames: number;
    }[];
    expect(rows).toHaveLength(fpsPerScenario.length);
    expect(rows.map((row) => row.scenario)).toEqual([
      "空场景（椭球地形）",
      "点位 5 000",
      "点位 20 000",
      "点位 100 000",
      "折线 2 000",
      "CZML 500 实体",
      "WMS 影像",
      "雨（环境效果）",
      "点位 100 000 + 影像 + 雨",
      "同上（low 档）",
      "同上（仅分辨率 0.75）",
      "同上（默认档·复测）",
    ]);
    expect(rows.every((row) => row.samples === 60)).toBe(true);
    // 分位与最长帧逐场景落进矩阵：第 3 个场景那一次顿挫只在 maxMs / longFrames 上体现，
    // 平均值与 P95 都看不出（桩里 P50/P95 跟平均帧耗时一致）。
    const hitched = rows[2];
    expect(hitched).toMatchObject({
      p50Ms: 22.73,
      p95Ms: 22.73,
      maxMs: 180,
      longFrames: 1,
    });
    expect(rows[0]).toMatchObject({ maxMs: 16.67, longFrames: 0 });
    expect(controller.snapshot().performance).toBe(
      "12 场景 · 最低 20 fps（同上（仅分辨率 0.75））· 最高 60 fps（空场景（椭球地形））· 最长帧 180 ms（点位 20 000）",
    );

    // 隔离行只改分辨率缩放：档位与覆盖分开下发，才能判断是哪一项参数造成的差异。
    expect(harness.map.quality.set).toHaveBeenCalledWith({
      resolutionScale: 0.75,
    });

    // 测量期间关掉自动降档（否则测的是降档后的开销），结束后恢复。
    expect(harness.map.quality.setAdaptive).toHaveBeenNthCalledWith(1, false);
    expect(harness.qualityAdaptive()).toBe(true);
    // 固定机位，读数才跨场景可比。
    expect(harness.setView).toHaveBeenCalledWith(
      expect.objectContaining({
        longitude: 116.4,
        latitude: 39.9,
        height: 900_000,
      }),
    );
    // 重量级场景真的建过图层，且收尾时按前缀清理干净。
    expect(harness.map.layers.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: "perf-points-100000", type: "points" }),
    );
    expect(harness.map.layers.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: "perf-wms", type: "wms" }),
    );
    expect(
      harness.map.layers.list().some((layer) => layer.id.startsWith("perf-")),
    ).toBe(false);
    // 环境效果同样恢复晴。
    expect(harness.environmentClearAll).toHaveBeenCalled();
  });

  it("reorders imagery layers and cleans the probe layers up", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    await controller.probeLayerOrdering();

    // 后加的在上（0/1），换序后两者互换。
    expect(controller.snapshot().layerOrder).toBe(
      "下 0/上 1 → 换序后 下 1/上 0",
    );
    expect(harness.layerOrder()).toEqual(["order-upper", "order-lower"]);
    expect(
      harness.map.layers.list().some((layer) => layer.id.startsWith("order-")),
    ).toBe(false);
  });

  it("fails the ordering probe loudly when nothing actually moves", async () => {
    const harness = createHarness();
    harness.freezeImageryOrder();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    await expect(controller.probeLayerOrdering()).rejects.toThrow(
      "没有发生移动",
    );
    // 探针失败也要把临时图层收干净。
    expect(
      harness.map.layers.list().some((layer) => layer.id.startsWith("order-")),
    ).toBe(false);
  });

  it("fails the frame wait with a clear error when rendering is suspended", async () => {
    vi.useFakeTimers();
    // 永不回调的 requestAnimationFrame：模拟标签页在后台（浏览器会暂停渲染帧）。
    const raf = vi.fn(() => 0);
    vi.stubGlobal("requestAnimationFrame", raf);
    try {
      const pending = requestFrames(3);
      // 先把断言挂上再推时间：否则拒绝先于处理函数出现，会被报成未处理拒绝。
      const expectation = expect(pending).rejects.toThrow("等待渲染帧超时");
      // 拒绝要由定时器兜底触发——把超时检查写进帧回调里就永远不会发生。
      await vi.advanceTimersByTimeAsync(5_000);
      await expectation;
      expect(raf).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("resolves the frame wait once enough frames arrive", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    try {
      const pending = requestFrames(2);
      // 每一帧会再排一个回调，所以要一直排空到没有为止。
      while (callbacks.length > 0) {
        callbacks.shift()?.(0);
      }
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces fatal map errors and releases the subscription on destroy", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    expect(controller.snapshot().mapError).toBeUndefined();
    expect(harness.mapErrorListenerCount()).toBe(1);

    // 渲染循环停止这类错误不会让任何一次操作失败，只有事件会告诉业务。
    harness.emitMapError(
      Object.assign(
        new Error("Rendering stopped after an unrecoverable engine error."),
        {
          code: "RENDER_LOOP_FAILED",
        },
      ),
    );
    expect(controller.snapshot().mapError).toBe(
      "RENDER_LOOP_FAILED: Rendering stopped after an unrecoverable engine error.",
    );

    // 重建地图不会留下上一个实例的订阅。
    await controller.restart();
    expect(harness.mapErrorListenerCount()).toBe(1);
    expect(controller.snapshot().mapError).toBeUndefined();

    await controller.destroy();
    expect(harness.mapErrorListenerCount()).toBe(0);
  });

  it("declares terrain at map creation, awaits ready, then falls back to ellipsoid", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    await controller.createWithTerrain();

    expect(harness.createMap).toHaveBeenNthCalledWith(2, {
      container: "map",
      cesiumBaseUrl: "/cesium/",
      terrain: { type: "cesium-terrain", url: "/__test/terrain/" },
    });
    expect(harness.terrainSet).toHaveBeenCalledWith({ type: "ellipsoid" });
    expect(controller.snapshot().terrain).toBe(
      "创建期声明 → cesium-terrain / 加载中 pending=true / 兑现后 pending=false",
    );
  });

  it("strikes lightning near the current view and reports the SDK readout", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    await controller.strikeLightning();

    expect(harness.lightning.strike).toHaveBeenCalledWith(
      expect.objectContaining({ branches: "dense", durationMs: 4_000 }),
    );
    expect(controller.snapshot().lightning).toBe(
      "在演 1 条 / 亮度 0.97 / 上限 8",
    );
  });

  it("renders a heatmap from weighted points and reports the readout", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
    });
    await controller.start("map");

    await controller.addHeatmap();

    expect(harness.map.layers.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heatmap",
        radiusMeters: 900,
        resolution: 512,
        colorRamp: "thermal",
      }),
    );
    expect(harness.heatmap.pointCount).toBe(2_000);
    expect(controller.snapshot().heatmap).toBe(
      "点数 2000 / 半径 900 米 / 色带 thermal",
    );

    // 再点一次走 setData 路径（原子替换），不新建图层。
    await controller.addHeatmap();
    expect(harness.heatmap.setData).toHaveBeenCalledTimes(1);
  });

  it("drives the map clock from a simulation clock across rendered frames", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
      // 单测里用假帧替代 requestAnimationFrame：一帧等于 16ms。
      waitFrames: (count) => {
        harness.advanceFrames(count);
        return Promise.resolve();
      },
    });
    await controller.start("map");

    await controller.probeCzmlClock();

    // 6 帧 × 16ms × 8 倍速 = 768ms。
    expect(controller.snapshot().clock).toBe(
      "推进 768 ms / 源时钟一致 / animating=true / 实体 1",
    );
    expect(harness.map.layers.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: "example-czml-clock", type: "czml" }),
    );
    // 绑定在探针结束时解除：地图时钟不再跟随源时钟。
    expect(harness.clock.bind).toHaveBeenCalledTimes(1);
  });

  it("reports the click point for the entity probe and records the resolved hit", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
      waitFrames: () => Promise.resolve(),
    });
    await controller.start("map");

    await controller.armEntityPickProbe();

    // 探针要把实体交到验收脚本手里：先给坐标，命中结果在真实点击后才写入。
    expect(controller.snapshot().entityPickScreen).toBe("320,200");
    expect(controller.snapshot().entityPick).toBeUndefined();
    expect(harness.setView).toHaveBeenCalledWith(
      expect.objectContaining({ longitude: 116.5, latitude: 39.95 }),
    );

    harness.emitClick({
      layerId: "example-czml-pick",
      objectId: "pick-probe",
      kind: "layer",
    });

    const snapshot = controller.snapshot();
    expect(snapshot.entityPick).toBe(
      "命中图层 example-czml-pick / 实体 pick-probe",
    );
    expect(snapshot.entityPickScreen).toBeUndefined();
  });

  it("reports a probe miss without claiming a managed layer", async () => {
    const harness = createHarness();
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
      waitFrames: () => Promise.resolve(),
    });
    await controller.start("map");
    await controller.armEntityPickProbe();

    harness.emitClick({
      layerId: undefined,
      objectId: undefined,
      kind: "globe",
    });

    expect(controller.snapshot().entityPick).toBe(
      "未命中托管图层（kind=globe）",
    );
  });

  it("rejects the entity probe when the target cannot be projected to the screen", async () => {
    const harness = createHarness();
    harness.toWindow.mockReturnValue(undefined);
    const controller = createVanillaExampleController({
      createMap: harness.createMap,
      createActiveFilter: harness.createActiveFilter,
      geoJsonUrl: "/data/operations.geojson",
      wmsUrl: "/wms",
      terrainUrl: "/__test/terrain/",
      waitFrames: () => Promise.resolve(),
    });
    await controller.start("map");

    await expect(controller.armEntityPickProbe()).rejects.toThrow(
      "无法投影出点击坐标",
    );
  });
});
