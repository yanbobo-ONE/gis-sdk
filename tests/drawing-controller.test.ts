import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class FakePointPrimitiveCollection {
    readonly points: Record<string, unknown>[] = [];
    readonly destroy = vi.fn();
    show = true;
    add(options: Record<string, unknown>): Record<string, unknown> {
      const primitive = { ...options };
      this.points.push(primitive);
      return primitive;
    }
  }
  class FakePolylineCollection {
    readonly polylines: Record<string, unknown>[] = [];
    readonly destroy = vi.fn();
    show = true;
    add(options: Record<string, unknown>): Record<string, unknown> {
      const polyline = { ...options, width: 1, material: undefined };
      this.polylines.push(polyline);
      return polyline;
    }
  }
  type Action = (movement?: { position?: { x: number; y: number } }) => void;
  const actions = new Map<number, Action>();
  class FakeHandler {
    setInputAction(action: Action, type: number): void {
      actions.set(type, action);
    }
    removeInputAction(type: number): void {
      actions.delete(type);
    }
  }
  return {
    actions,
    FakeHandler,
    FakePointPrimitiveCollection,
    FakePolylineCollection,
    LEFT_CLICK: 3,
    MOUSE_MOVE: 15,
    RIGHT_CLICK: 4,
    LEFT_DOUBLE_CLICK: 6,
  };
});

vi.mock('cesium', () => ({
  Cartesian3: {
    fromDegrees: (longitude: number, latitude: number, height: number) => ({
      longitude,
      latitude,
      height,
    }),
  },
  Color: { WHITE: { css: 'white' }, fromCssColorString: (value: string) => ({ css: value }) },
  Material: {
    fromType: (type: string, uniforms: Record<string, unknown>) => ({ type, uniforms }),
  },
  PointPrimitiveCollection: cesium.FakePointPrimitiveCollection,
  PolylineCollection: cesium.FakePolylineCollection,
  ScreenSpaceEventType: {
    LEFT_CLICK: cesium.LEFT_CLICK,
    MOUSE_MOVE: cesium.MOUSE_MOVE,
    RIGHT_CLICK: cesium.RIGHT_CLICK,
    LEFT_DOUBLE_CLICK: cesium.LEFT_DOUBLE_CLICK,
  },
}));

import { CesiumDrawingController } from '../src/cesium/drawing-controller.js';
import type { CoordinateTransform } from '../src/core/controls.js';

function createHarness() {
  const items: unknown[] = [];
  const primitives = {
    add: vi.fn((item: unknown) => {
      items.push(item);
      return item;
    }),
    remove: vi.fn((item: unknown) => {
      const index = items.indexOf(item);
      if (index < 0) {
        return false;
      }
      items.splice(index, 1);
      return true;
    }),
  };
  const keyListeners = new Set<(event: KeyboardEvent) => void>();
  const documentRef = {
    addEventListener: vi.fn((_type: string, listener: (event: KeyboardEvent) => void) => {
      keyListeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: KeyboardEvent) => void) => {
      keyListeners.delete(listener);
    }),
  };
  const viewer = {
    screenSpaceEventHandler: new cesium.FakeHandler(),
    scene: { primitives },
  };
  const coordinates = {
    pickGeoPosition: vi.fn(({ x }: { x: number; y: number }) => ({ longitude: x, latitude: 0 })),
  } as unknown as CoordinateTransform;
  return {
    viewer,
    coordinates,
    documentRef,
    items,
    primitives,
    pressEscape: () => {
      for (const listener of [...keyListeners]) {
        listener({ key: 'Escape' } as KeyboardEvent);
      }
    },
    keyListenerCount: () => keyListeners.size,
  };
}

const screen = (x: number, y = 0) => ({ position: { x, y } });

describe('CesiumDrawingController', () => {
  beforeEach(() => {
    cesium.actions.clear();
  });

  it('drives the machine from input actions and emits complete events', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    const completed: unknown[] = [];
    controller.on('complete', (geometry) => completed.push(geometry));

    expect(controller.start('polyline')).toBe(true);
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(1));
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(2));
    expect(controller.vertexCount).toBe(2);

    // 鼠标移动渲染预览图元。
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(3));
    expect(harness.primitives.add).toHaveBeenCalled();

    // 右键确认：光标位置并入几何。
    cesium.actions.get(cesium.RIGHT_CLICK)?.(screen(4));
    expect(completed).toEqual([
      {
        mode: 'polyline',
        positions: [
          { longitude: 1, latitude: 0 },
          { longitude: 2, latitude: 0 },
          { longitude: 4, latitude: 0 },
        ],
      },
    ]);
    expect(controller.mode).toBeUndefined();
  });

  it('finishes polyline by double click and cancels by Escape', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    const cancels: unknown[] = [];
    controller.on('cancel', (event) => cancels.push(event));

    controller.start('polygon');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(1));
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(2));
    // 顶点不足时双击不会完成绘制。
    cesium.actions.get(cesium.LEFT_DOUBLE_CLICK)?.();
    expect(controller.mode).toBe('polygon');

    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(3));
    cesium.actions.get(cesium.LEFT_DOUBLE_CLICK)?.();
    expect(controller.mode).toBeUndefined();

    controller.start('polyline');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(5));
    harness.pressEscape();
    expect(controller.mode).toBeUndefined();
    expect(cancels).toHaveLength(1);
  });

  it('ignores input that does not hit the globe', () => {
    const harness = createHarness();
    (harness.coordinates.pickGeoPosition as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );

    controller.start('polyline');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(1));
    expect(controller.vertexCount).toBe(0);
  });

  it('releases input actions, key listeners, and primitives on dispose', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );

    expect(cesium.actions.size).toBe(4);
    expect(harness.keyListenerCount()).toBe(1);
    controller.dispose();

    expect(cesium.actions.size).toBe(0);
    expect(harness.keyListenerCount()).toBe(0);
    expect(harness.items).toHaveLength(0);
    expect(() => controller.start('point')).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED' }),
    );
  });

  it('clears completed graphics through the controller surface', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );

    controller.start('point');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(7));
    expect(harness.items.length).toBeGreaterThan(0);

    controller.clearCompleted();
    expect(harness.items).toHaveLength(0);
  });
});
