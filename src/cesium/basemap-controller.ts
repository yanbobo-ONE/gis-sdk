import { UrlTemplateImageryProvider } from 'cesium';
import type { ImageryLayer, ImageryProvider, Viewer } from 'cesium';

import type { BasemapController, BasemapType, XyzBasemapSpec } from '../core/controls.js';
import { GisError } from '../core/errors.js';
import { normalizeRequestHeaders, withRequestHeaders } from './layers/request-headers.js';

/** 归一化后的底图配置：透明度与显隐一定存在，请求头可选。 */
type NormalizedBasemap = Required<Omit<XyzBasemapSpec, 'headers'>> &
  Pick<XyzBasemapSpec, 'headers'>;

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
  current: Readonly<Pick<NormalizedBasemap, 'opacity' | 'visible'>>,
): NormalizedBasemap {
  const url = spec.url.trim();
  if (!url || !url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
    throw invalidConfig('XYZ basemap URL must contain {z}, {x}, and {y} placeholders.');
  }
  const headers = normalizeRequestHeaders(spec.headers, 'basemap', 'set');
  return {
    type: 'xyz',
    url,
    opacity: validateOpacity(spec.opacity ?? current.opacity),
    visible: spec.visible ?? current.visible,
    ...(headers === undefined ? {} : { headers }),
  };
}

interface ProviderErrorEvent {
  addEventListener(listener: (error: unknown) => void): (() => void) | undefined;
}

/** @internal */
export class CesiumBasemapController implements BasemapController {
  private currentLayer: ImageryLayer | undefined;
  private currentOpacity = 1;
  private currentType: BasemapType = 'none';
  private currentVisible = false;
  private observedErrors = 0;
  private removeErrorListener: (() => void) | undefined;
  private reporter: ((error: GisError) => void) | undefined;
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

  get errorCount(): number {
    return this.observedErrors;
  }

  /** 接入引擎级错误上报入口；由地图适配器在运行时建立后调用。 */
  setErrorReporter(reporter: (error: GisError) => void): void {
    this.reporter = reporter;
  }

  set(spec: XyzBasemapSpec): void {
    this.assertActive('set');
    const config = normalize(spec, {
      opacity: this.currentLayer ? this.currentOpacity : 1,
      visible: this.currentLayer ? this.currentVisible : true,
    });
    const candidate = this.viewer.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({ url: withRequestHeaders(config.url, config.headers) }),
      0,
    );
    candidate.alpha = config.opacity;
    candidate.show = config.visible;
    this.watchProvider(candidate.imageryProvider, config.url);

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
    this.unwatchProvider();
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

  /** 订阅瓦片错误：累计计数，并只在首个失败时上报一次，避免瓦片级错误刷屏。 */
  private watchProvider(provider: ImageryProvider, url: string): void {
    this.unwatchProvider();
    const event = (provider as { errorEvent?: ProviderErrorEvent } | undefined)?.errorEvent;
    if (!event || typeof event.addEventListener !== 'function') {
      return;
    }
    const onError = (cause: unknown) => {
      this.observedErrors += 1;
      if (this.observedErrors > 1) {
        return;
      }
      this.reporter?.(
        new GisError(`Basemap tiles from "${url}" are failing to load.`, {
          code: 'BASEMAP_LOAD_FAILED',
          module: 'basemap',
          operation: 'set',
          retryable: true,
          cause,
        }),
      );
    };
    try {
      this.removeErrorListener = event.addEventListener(onError);
    } catch {
      this.removeErrorListener = undefined;
    }
  }

  private unwatchProvider(): void {
    const remove = this.removeErrorListener;
    this.removeErrorListener = undefined;
    remove?.();
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
