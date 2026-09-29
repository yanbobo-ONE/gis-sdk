import { describe, expect, it, vi } from 'vitest';

import { captureViewerFrame, copyCanvasFrame } from '../src/cesium/frame-capture.js';
import type { CaptureDependencies } from '../src/cesium/frame-capture.js';

interface Canvas2DContext {
  drawImage(source: unknown, dx: number, dy: number, width?: number, height?: number): void;
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): { readonly data: Uint8ClampedArray };
}

interface FakeCanvas {
  width: number;
  height: number;
  ownerDocument: { createElement(tag: string): FakeCanvas };
  getContext(kind: '2d'): Canvas2DContext | null;
}

/**
 * 构造可用于判空的画布替身。
 *
 * 每次 `createElement` 都返回**新的**替身，并继承同一组选项——这样离屏拷贝与它的
 * 判空采样用的是各自独立的画布，与真实 DOM 行为一致。
 */
function createFakeCanvas(
  width: number,
  height: number,
  options: {
    readonly pixels?: readonly number[];
    readonly throwOnProbe?: boolean;
    readonly withoutContext?: boolean;
  } = {},
): FakeCanvas {
  const context: Canvas2DContext = {
    drawImage: () => undefined,
    getImageData: () => {
      if (options.throwOnProbe === true) {
        throw new Error('canvas is tainted');
      }
      return {
        data: new Uint8ClampedArray(options.pixels ?? new Array<number>(16 * 16 * 4).fill(200)),
      };
    },
  };
  return {
    width,
    height,
    ownerDocument: { createElement: () => createFakeCanvas(0, 0, options) },
    getContext: () => (options.withoutContext === true ? null : context),
  };
}

describe('copyCanvasFrame', () => {
  it('copies a rendered frame into an offscreen canvas at device resolution', () => {
    const source = createFakeCanvas(320, 180);
    const copy = copyCanvasFrame(source);

    expect(copy).toBeDefined();
    expect(copy?.width).toBe(320);
    expect(copy?.height).toBe(180);
  });

  it('rejects empty sizes and blank frames', () => {
    expect(copyCanvasFrame(createFakeCanvas(0, 0))).toBeUndefined();

    const blank: number[] = new Array<number>(16 * 16 * 4).fill(0);
    expect(
      copyCanvasFrame(
        createFakeCanvas(320, 180, { pixels: blank }) as unknown as HTMLCanvasElement,
      ),
    ).toBeUndefined();

    // 取不到像素时按有效处理，避免把正常画面误判为空。
    const tainted = copyCanvasFrame(createFakeCanvas(320, 180, { throwOnProbe: true }));
    expect(tainted).toBeDefined();
  });

  it('returns undefined when the canvas has no 2D context', () => {
    const source = createFakeCanvas(320, 180, { withoutContext: true });
    expect(copyCanvasFrame(source)).toBeUndefined();
  });
});

describe('captureViewerFrame', () => {
  function createViewer() {
    const listeners = new Set<() => void>();
    const requestRender = vi.fn();
    return {
      viewer: {
        scene: {
          canvas: createFakeCanvas(640, 360),
          postRender: {
            addEventListener: (listener: () => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          requestRender,
        },
      },
      requestRender,
      fireRender: () => {
        for (const listener of [...listeners]) listener();
      },
      listenerCount: () => listeners.size,
    };
  }

  it('captures inside the postRender callback and releases the listener', async () => {
    const harness = createViewer();
    const pending = captureViewerFrame(harness.viewer as never);

    expect(harness.requestRender).toHaveBeenCalledOnce();
    expect(harness.listenerCount()).toBe(1);

    harness.fireRender();

    const capture = await pending;
    expect(capture).toMatchObject({ width: 640, height: 360 });
    expect(harness.listenerCount()).toBe(0);
  });

  it('retries blank frames and gives up after the attempt limit', async () => {
    const harness = createViewer();
    const copy = vi
      .fn<NonNullable<CaptureDependencies['copy']>>()
      .mockReturnValueOnce(undefined)
      .mockReturnValue(createFakeCanvas(640, 360));

    const pending = captureViewerFrame(harness.viewer as never, { attempts: 2 }, { copy });
    harness.fireRender();
    // 第一次为空：重新请求渲染后再抓一次。
    expect(harness.requestRender).toHaveBeenCalledTimes(2);
    harness.fireRender();

    await expect(pending).resolves.toMatchObject({ width: 640 });

    const alwaysBlank = vi.fn(() => undefined);
    const failing = captureViewerFrame(
      harness.viewer as never,
      { attempts: 2 },
      { copy: alwaysBlank },
    );
    harness.fireRender();
    harness.fireRender();
    await expect(failing).resolves.toBeUndefined();
    expect(alwaysBlank).toHaveBeenCalledTimes(2);
    expect(harness.listenerCount()).toBe(0);
  });

  it('resolves undefined on timeout and when the viewer cannot capture', async () => {
    vi.useFakeTimers();
    try {
      const harness = createViewer();
      const pending = captureViewerFrame(harness.viewer as never, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toBeUndefined();
      expect(harness.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    await expect(captureViewerFrame(undefined)).resolves.toBeUndefined();
    await expect(captureViewerFrame({ scene: {} } as never)).resolves.toBeUndefined();
  });
});
