import { createMap } from '@yanbobo/gis-sdk/cesium';
import { wmsFilter } from '@yanbobo/gis-sdk/layers';
import '@yanbobo/gis-sdk/styles.css';

import { createVanillaExampleController } from './example-controller.js';
import type { VanillaEnvironmentPreset } from './example-controller.js';
import './style.css';

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing example element: ${id}`);
  }
  return value;
}

const runtimeState = element('runtime-state');
const layerCount = element('layer-count');
const dataRevision = element('data-revision');
const opacityValue = element('opacity-value');
const operationMessage = element('operation-message');
const mapErrorMessage = element('map-error-message');
const geoJsonVisible = element('geojson-visible') as HTMLInputElement;
const wmsFilterToggle = element('wms-filter') as HTMLInputElement;
const wmsOpacity = element('wms-opacity') as HTMLInputElement;
const layerOrderValue = element('layer-order-value');
const environmentValue = element('environment-value');
const cameraValue = element('camera-value');
const lineOfSightValue = element('line-of-sight-value');
const pointsValue = element('points-value');
const clustersValue = element('clusters-value');
const czmlValue = element('czml-value');
const clockValue = element('clock-value');
const entityPickValue = element('entity-pick-value');
const batchValue = element('batch-value');
const perfValue = element('perf-value');
const terrainValue = element('terrain-value');
const lightningValue = element('lightning-value');
const heatmapValue = element('heatmap-value');
const windValue = element('wind-value');

const controller = createVanillaExampleController({
  createMap,
  createActiveFilter: () => wmsFilter.eq('status', 'ACTIVE'),
  geoJsonUrl: '/data/operations.geojson',
  wmsUrl: '/wms',
  terrainUrl: '/__test/terrain/',
});

controller.subscribe((snapshot) => {
  runtimeState.textContent = snapshot.state;
  runtimeState.dataset.state = snapshot.state;
  layerCount.textContent = String(snapshot.layerCount);
  dataRevision.textContent = String(snapshot.dataRevision);
  opacityValue.textContent = snapshot.wmsOpacity.toFixed(2);
  geoJsonVisible.checked = snapshot.geoJsonVisible;
  wmsFilterToggle.checked = snapshot.wmsFilterEnabled;
  wmsOpacity.value = String(snapshot.wmsOpacity);
  environmentValue.textContent = snapshot.environment;
  cameraValue.textContent = snapshot.camera ?? '未读取';
  lineOfSightValue.textContent = snapshot.lineOfSight ?? '未分析';
  pointsValue.textContent = snapshot.points ?? '未添加';
  clustersValue.textContent = snapshot.clusters ?? '未聚合';
  czmlValue.textContent = snapshot.czml ?? '未加载';
  clockValue.textContent = snapshot.clock ?? '未验证';
  entityPickValue.textContent = snapshot.entityPick ?? '未验证';
  // 验收脚本据此在画布上真实点击；布防期间才有值。
  entityPickValue.dataset.screen = snapshot.entityPickScreen ?? '';
  batchValue.textContent = snapshot.batch ?? '未运行';
  perfValue.textContent = snapshot.performance ?? '未测量';
  // 验收脚本与文档从这里取原始矩阵，不用去解析面板文案。
  perfValue.dataset.matrix = snapshot.performanceMatrix ?? '';
  terrainValue.textContent = snapshot.terrain ?? '未验证';
  lightningValue.textContent = snapshot.lightning ?? '未触发';
  heatmapValue.textContent = snapshot.heatmap ?? '未添加';
  windValue.textContent = snapshot.wind ?? '未添加';
  layerOrderValue.textContent = snapshot.layerOrder ?? '未验证';
  // SDK 上报的致命错误单独占一行：它不会让某次操作失败，只会让地图不再动。
  if (snapshot.mapError) {
    mapErrorMessage.textContent = `地图错误 ${snapshot.mapError}`;
    mapErrorMessage.hidden = false;
  } else {
    mapErrorMessage.hidden = true;
  }
  if (snapshot.error) {
    operationMessage.textContent = snapshot.error;
    operationMessage.dataset.kind = 'error';
  }
});

async function runOperation(message: string, operation: () => void | Promise<void>) {
  operationMessage.textContent = `${message}...`;
  operationMessage.dataset.kind = 'working';
  try {
    await operation();
    operationMessage.textContent = `${message}完成`;
    operationMessage.dataset.kind = 'success';
  } catch (error: unknown) {
    operationMessage.textContent = error instanceof Error ? error.message : String(error);
    operationMessage.dataset.kind = 'error';
  }
}

element('replace-geojson').addEventListener('click', () => {
  void runOperation('GeoJSON 数据替换', () => controller.replaceGeoJson());
});

geoJsonVisible.addEventListener('change', () => {
  void runOperation('GeoJSON 显隐更新', () => {
    controller.setGeoJsonVisible(geoJsonVisible.checked);
  });
});

wmsOpacity.addEventListener('input', () => {
  const opacity = Number(wmsOpacity.value);
  controller.setWmsOpacity(opacity);
  opacityValue.textContent = opacity.toFixed(2);
  operationMessage.textContent = 'WMS 透明度已更新';
  operationMessage.dataset.kind = 'success';
});

wmsFilterToggle.addEventListener('change', () => {
  void runOperation('WMS 过滤更新', () => controller.setWmsFilterEnabled(wmsFilterToggle.checked));
});

element('reload-wms').addEventListener('click', () => {
  void runOperation('WMS Provider 刷新', () => controller.reloadWms());
});

element('probe-layer-order').addEventListener('click', () => {
  void runOperation('堆叠顺序探针', () => controller.probeLayerOrdering());
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-environment]')) {
  button.addEventListener('click', () => {
    const preset = button.dataset.environment as VanillaEnvironmentPreset | undefined;
    if (!preset) {
      return;
    }
    void runOperation(`环境切换 ${preset}`, () => {
      controller.setEnvironment(preset);
    });
  });
}

element('run-line-of-sight').addEventListener('click', () => {
  void runOperation('通视分析', () => controller.runLineOfSight());
});

element('read-camera').addEventListener('click', () => {
  void runOperation('读取相机位姿', () => {
    controller.readCamera();
  });
});

element('add-points').addEventListener('click', () => {
  void runOperation('添加 200 个带标签点位', () => controller.addPointLayer());
});

element('toggle-labels').addEventListener('click', () => {
  void runOperation('切换点位标签', () => {
    controller.togglePointLabels();
  });
});

element('cluster-points').addEventListener('click', () => {
  void runOperation('按屏幕像素聚合', () => {
    controller.clusterPoints();
  });
});

element('add-czml').addEventListener('click', () => {
  void runOperation('加载 CZML 轨迹', () => controller.addCzmlLayer());
});

element('probe-czml-clock').addEventListener('click', () => {
  void runOperation('时钟探针', () => controller.probeCzmlClock());
});

element('arm-entity-pick').addEventListener('click', () => {
  void runOperation('布防实体拾取探针', () => controller.armEntityPickProbe());
});

element('add-wind').addEventListener('click', () => {
  void runOperation('三维风场', () => controller.addWindField());
});

element('add-heatmap').addEventListener('click', () => {
  void runOperation('密度热力图', () => controller.addHeatmap());
});

element('run-batch').addEventListener('click', () => {
  void runOperation('批量坡度坡向分析', () => controller.runBatchAnalysis());
});

element('run-perf-matrix').addEventListener('click', () => {
  void runOperation('性能矩阵（需保持标签页可见）', () => controller.measurePerformanceMatrix());
});

element('restart-map').addEventListener('click', () => {
  void runOperation('地图销毁并重建', () => controller.restart());
});

element('strike-lightning').addEventListener('click', () => {
  void runOperation('触发闪电', () => controller.strikeLightning());
});

element('create-with-terrain').addEventListener('click', () => {
  void runOperation('创建期声明地形', () => controller.createWithTerrain());
});

window.addEventListener('beforeunload', () => {
  void controller.destroy();
});

void runOperation('地图创建', () => controller.start('map'));
