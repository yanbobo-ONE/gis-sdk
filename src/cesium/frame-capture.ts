import type { Viewer } from 'cesium';

import type { CaptureOptions, FrameCapture } from '../core/controls.js';

/** 默认等待渲染的毫秒上限。 */
const DEFAULT_TIMEOUT_MS = 400;

/** 默认渲染尝试次数；容器尺寸刚变化时首帧可能取不到像素。 */
const DEFAULT_ATTEMPTS = 2;

/** 判空采样分辨率，越高越不容易漏掉亮部。 */
const PROBE_SIZE = 16;

/** 判空亮度阈值，任一通道高于该值即认为画面有效。 */
const PROBE_THRESHOLD = 12;

/** 2D 上下文的最小接口，便于在无 DOM 环境下替换。 */
interface Canvas2DContext {
  drawImage(source: unknown, dx: number, dy: number, width?: number, height?: number): void;
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { readonly data: Uint8ClampedArray };
}

interface CanvasLike {
  width: number;
  height: number;
  readonly ownerDocument: { createElement(tag: string): CanvasLike };
  getContext(kind: '2d'): Canvas2DContext | null;
}

/** 降采样判定画面是否为空，避免把尚未渲染的绘图缓冲区当成有效截图。 */
function isBlankFrame(canvas: CanvasLike): boolean {
  const probe = canvas.ownerDocument.createElement('canvas');
  probe.width = PROBE_SIZE;
  probe.height = PROBE_SIZE;
  const context = probe.getContext('2d');
  if (!context) {
    return false;
  }
  context.drawImage(canvas, 0, 0, PROBE_SIZE, PROBE_SIZE);
  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data;
  } catch {
    // 取不到像素时按有效处理，避免误判为空。
    return false;
  }
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    if (red > PROBE_THRESHOLD || green > PROBE_THRESHOLD || blue > PROBE_THRESHOLD) {
      return false;
    }
  }
  return true;
}

/**
 * 把 WebGL 画布拷贝到离屏 canvas。
 *
 * **必须在 `postRender` 同一帧内调用**：那时绘图缓冲区仍然有效，因此不需要开启
 * `preserveDrawingBuffer`（开启它会显著增加显存与绘制开销）。
 *
 * @param source - 场景画布。
 * @returns 离屏副本；画布尺寸为零、拷贝失败或画面为空时返回 `undefined`。
 * @internal
 */
export function copyCanvasFrame(source: CanvasLike): CanvasLike | undefined {
  if (!source.width || !source.height) {
    return undefined;
  }
  const target = source.ownerDocument.createElement('canvas');
  target.width = source.width;
  target.height = source.height;
  const context = target.getContext('2d');
  if (!context) {
    return undefined;
  }
  try {
    context.drawImage(source, 0, 0);
  } catch {
    return undefined;
  }
  return isBlankFrame(target) ? undefined : target;
}

/** @internal */
export interface CaptureDependencies {
  /** 拷贝实现；测试可注入替身。 */
  readonly copy?: (source: CanvasLike) => CanvasLike | undefined;
}

/**
 * 触发一次渲染并在同帧拷贝场景画面。
 *
 * @param viewer - 目标 Viewer；缺少场景或渲染事件时返回 `undefined`。
 * @param options - 等待上限与尝试次数。
 * @param dependencies - 可注入的拷贝实现。
 * @returns 离屏截图；超时或画面为空时为 `undefined`。
 * @internal
 */
export function captureViewerFrame(
  viewer: Pick<Viewer, 'scene'> | undefined,
  options: CaptureOptions = {},
  dependencies: CaptureDependencies = {},
): Promise<FrameCapture | undefined> {
  const scene = viewer?.scene;
  const source = scene?.canvas as unknown as CanvasLike | undefined;
  const postRender = scene?.postRender;
  if (!scene || typeof postRender?.addEventListener !== 'function' || !source) {
    return Promise.resolve(undefined);
  }

  const copy = dependencies.copy ?? copyCanvasFrame;
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return new Promise<FrameCapture | undefined>((resolve) => {
    let settled = false;
    let tries = 0;
    // 释放动作集中登记：无论成功、超时还是放弃，都会一次性解绑监听并清掉定时器。
    const cleanups: (() => void)[] = [];

    const finish = (value: FrameCapture | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
      resolve(value);
    };

    cleanups.push(
      postRender.addEventListener(() => {
        const captured = copy(source);
        if (captured) {
          finish({
            canvas: captured as unknown as HTMLCanvasElement,
            width: captured.width,
            height: captured.height,
          });
          return;
        }
        tries += 1;
        if (tries >= attempts) {
          finish(undefined);
        } else {
          scene.requestRender();
        }
      }),
    );
    const timer = setTimeout(() => {
      finish(undefined);
    }, timeoutMs);
    cleanups.push(() => {
      clearTimeout(timer);
    });
    scene.requestRender();
  });
}
