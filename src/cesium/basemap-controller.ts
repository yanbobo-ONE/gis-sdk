import { UrlTemplateImageryProvider } from 'cesium';
import type { ImageryLayer, Viewer } from 'cesium';

import type { BasemapController, BasemapType, XyzBasemapSpec } from '../core/controls.js';
import { GisError } from '../core/errors.js';

function invalidConfig(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_BASEMAP_CONFIG',
    module: 'basemap',
    operation: 'set',
  });
}

function validateOpacity(opacity: number): number {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    throw new GisError('Basemap opacity must be a finite number between 0 and 1.', {
      code: 'INVALID_BASEMAP_OPACITY',
      module: 'basemap',
      operation: 'setOpacity',
    });
  }
  return opacity;
}

function normalize(
  spec: XyzBasemapSpec,
  current: Readonly<Pick<Required<XyzBasemapSpec>, 'opacity' | 'visible'>>,
): Required<XyzBasemapSpec> {
  const url = spec.url.trim();
  if (!url || !url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
    throw invalidConfig('XYZ basemap URL must contain {z}, {x}, and {y} placeholders.');
  }
  return {
    type: 'xyz',
    url,
    opacity: validateOpacity(spec.opacity ?? current.opacity),
    visible: spec.visible ?? current.visible,
  };
}

/** @internal */
export class CesiumBasemapController implements BasemapController {
  private currentLayer: ImageryLayer | undefined;
  private currentOpacity = 1;
  private currentType: BasemapType = 'none';
  private currentVisible = false;
  private disposed = false;

  constructor(private readonly viewer: Pick<Viewer, 'imageryLayers'>) {}

  get type(): BasemapType {
    return this.currentType;
  }

  get visible(): boolean {
    return this.currentVisible;
  }

  get opacity(): number {
    return this.currentOpacity;
  }

  set(spec: XyzBasemapSpec): void {
    this.assertActive('set');
    const config = normalize(spec, {
      opacity: this.currentLayer ? this.currentOpacity : 1,
      visible: this.currentLayer ? this.currentVisible : true,
    });
    const candidate = this.viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({ url: config.url }),
      0,
    );
    candidate.alpha = config.opacity;
    candidate.show = config.visible;

    const previous = this.currentLayer;
    this.currentLayer = candidate;
    this.currentType = 'xyz';
    this.currentOpacity = config.opacity;
    this.currentVisible = config.visible;
    if (previous) {
      this.viewer.imageryLayers.remove(previous, true);
    }
  }

  clear(): void {
    this.assertActive('clear');
    if (this.currentLayer) {
      this.viewer.imageryLayers.remove(this.currentLayer, true);
    }
    this.currentLayer = undefined;
    this.currentType = 'none';
    this.currentOpacity = 1;
    this.currentVisible = false;
  }

  setVisible(visible: boolean): void {
    this.assertActive('setVisible');
    if (!this.currentLayer) {
      return;
    }
    this.currentLayer.show = visible;
    this.currentVisible = visible;
  }

  setOpacity(opacity: number): void {
    this.assertActive('setOpacity');
    const normalizedOpacity = validateOpacity(opacity);
    if (!this.currentLayer) {
      return;
    }
    this.currentLayer.alpha = normalizedOpacity;
    this.currentOpacity = normalizedOpacity;
  }

  destroy(): void {
    if (!this.disposed) {
      this.clear();
      this.disposed = true;
    }
  }

  private assertActive(operation: string): void {
    if (this.disposed) {
      throw new GisError('Basemap controller has been disposed.', {
        code: 'MAP_DISPOSED',
        module: 'basemap',
        operation,
      });
    }
  }
}
