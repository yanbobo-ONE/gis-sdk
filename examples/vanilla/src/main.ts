import { createMap } from '@yanbobo/gis-sdk/cesium';
import { wmsFilter } from '@yanbobo/gis-sdk/layers';
import '@yanbobo/gis-sdk/styles.css';

import { createVanillaExampleController } from './example-controller.js';
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
const geoJsonVisible = element('geojson-visible') as HTMLInputElement;
const wmsFilterToggle = element('wms-filter') as HTMLInputElement;
const wmsOpacity = element('wms-opacity') as HTMLInputElement;

const controller = createVanillaExampleController({
  createMap,
  createActiveFilter: () => wmsFilter.eq('status', 'ACTIVE'),
  geoJsonUrl: '/data/operations.geojson',
  wmsUrl: '/wms',
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

element('restart-map').addEventListener('click', () => {
  void runOperation('地图销毁并重建', () => controller.restart());
});

window.addEventListener('beforeunload', () => {
  void controller.destroy();
});

void runOperation('地图创建', () => controller.start('map'));
