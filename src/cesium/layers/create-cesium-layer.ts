import type { Viewer } from 'cesium';

import type { LayerHandle, LayerSpec } from '../../layers/contracts.js';
import type { LayerFactoryContext } from '../../layers/layer-runtime.js';
import type { CesiumLayerServices } from '../layer-services.js';
import { createGeoJsonLayer } from './geojson-layer.js';
import { createModelLayer } from './model-layer.js';
import { createSingleImageLayer } from './single-image-layer.js';
import { createTiles3dLayer } from './tileset-layer.js';
import { createTmsLayer, createWmtsLayer } from './tiled-imagery-layer.js';
import { createWmsLayer } from './wms-layer.js';

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
      return createModelLayer(viewer, spec, context, services);
    case '3d-tiles':
      return createTiles3dLayer(viewer, spec, context);
  }
}
