import type { Viewer } from 'cesium';

import type { LayerHandle, LayerSpec } from '../../layers/contracts.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import type { LoadLimiter } from '../load-limiter.js';
import { createGeoJsonLayer } from './geojson-layer.js';
import { createModelLayer } from './model-layer.js';
import { createSingleImageLayer } from './single-image-layer.js';
import { createTiles3dLayer } from './tileset-layer.js';
import { createTmsLayer, createWmtsLayer } from './tiled-imagery-layer.js';
import { createWmsLayer } from './wms-layer.js';

/** 地图级服务，供图层工厂在创建单个图层时复用。 @internal */
export interface CesiumLayerServices {
  /** 限制并发模型加载数量，避免一次添加大量模型时的请求风暴。 */
  readonly modelLoad: LoadLimiter;
}

/** @internal */
export function createCesiumLayer(
  viewer: Viewer,
  spec: LayerSpec,
  context: LayerFactoryContext,
  services: CesiumLayerServices,
): Promise<LayerHandle> {
  switch (spec.type) {
    case 'geojson':
      return createGeoJsonLayer(viewer, spec, context);
    case 'wms':
      return createWmsLayer(viewer, spec, context);
    case 'tms':
      return createTmsLayer(viewer, spec, context);
    case 'wmts':
      return createWmtsLayer(viewer, spec, context);
    case 'single-image':
      return createSingleImageLayer(viewer, spec, context);
    case 'model':
      return createModelLayer(viewer, spec, context, services.modelLoad);
    case '3d-tiles':
      return createTiles3dLayer(viewer, spec, context);
  }
}
