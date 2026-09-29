import type { ImageryLayer } from 'cesium';

interface ErrorEventLike {
  addEventListener(listener: (error: unknown) => void): (() => void) | undefined;
}

interface ImageryProviderLike {
  readonly errorEvent?: ErrorEventLike;
}

/** 影像错误订阅的释放入口。 @internal */
export interface ImageryErrorWatch {
  dispose(): void;
}

/**
 * 订阅影像服务提供器的错误事件。
 *
 * 瓦片失败会按瓦片触发，因此这里把每次失败都交给调用方累计；是否对外发出事件由
 * 图层句柄决定（只发首个，避免刷屏）。
 *
 * @internal
 */
export function watchImageryErrors(
  layer: ImageryLayer,
  onError: (cause: unknown) => void,
): ImageryErrorWatch {
  const provider = layer.imageryProvider as ImageryProviderLike | undefined;
  const event = provider?.errorEvent;
  if (!event || typeof event.addEventListener !== 'function') {
    return { dispose: () => undefined };
  }

  let remove: (() => void) | undefined;
  try {
    remove = event.addEventListener(onError);
  } catch {
    return { dispose: () => undefined };
  }

  return {
    dispose: () => {
      const current = remove;
      remove = undefined;
      current?.();
    },
  };
}
