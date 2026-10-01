import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  /** 假处理器复刻 Cesium 的覆盖语义：一个动作类型只有一个回调，后注册的顶掉先注册的。 */
  const actions = new Map<number, (movement?: { position?: { x: number; y: number } }) => void>();
  class FakeHandler {
    constructor(readonly canvas: unknown = {}) {}
    setInputAction(
      action: (movement?: { position?: { x: number; y: number } }) => void,
      type: number,
    ): void {
      actions.set(type, action);
    }
    getInputAction(
      type: number,
    ): ((movement?: { position?: { x: number; y: number } }) => void) | undefined {
      return actions.get(type);
    }
    removeInputAction(type: number): void {
      actions.delete(type);
    }
  }
  class FakePointPrimitiveCollection {
    add(options: Record<string, unknown>): Record<string, unknown> {
      return { ...options };
    }
    destroy(): void {
      // 假集合没有需要释放的资源。
    }
  }
  class FakePolylineCollection {
    add(options: Record<string, unknown>): Record<string, unknown> {
      return { ...options, width: 1, material: undefined };
    }
    destroy(): void {
      // 假集合没有需要释放的资源。
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
    LEFT_DOWN: 8,
    LEFT_UP: 9,
  };
});

vi.mock('cesium', () => ({
  Cartesian3: { fromDegrees: (longitude: number, latitude: number) => ({ longitude, latitude }) },
  Color: { WHITE: { css: 'white' }, fromCssColorString: (value: string) => ({ css: value }) },
  Material: { fromType: (type: string, uniforms: unknown) => ({ type, uniforms }) },
  PointPrimitiveCollection: cesium.FakePointPrimitiveCollection,
  PolylineCollection: cesium.FakePolylineCollection,
  ScreenSpaceEventType: {
    LEFT_CLICK: cesium.LEFT_CLICK,
    MOUSE_MOVE: cesium.MOUSE_MOVE,
    RIGHT_CLICK: cesium.RIGHT_CLICK,
    LEFT_DOUBLE_CLICK: cesium.LEFT_DOUBLE_CLICK,
    LEFT_DOWN: cesium.LEFT_DOWN,
    LEFT_UP: cesium.LEFT_UP,
  },
  defined: (value: unknown) => value !== undefined,
}));

import { CesiumDrawingController } from '../src/cesium/drawing-controller.js';
import { addInputAction } from '../src/cesium/input-actions.js';
import { CesiumPickingController } from '../src/cesium/picking-controller.js';
import type { CoordinateTransform, GeoPosition, PickingEvent } from '../src/core/controls.js';

function createCoordinates() {
  return {
    pickGeoPosition: vi.fn(({ x }: { x: number; y: number }): GeoPosition => ({
      longitude: x,
      latitude: 0,
      height: 0,
    })),
    toWindow: vi.fn(({ longitude }: { longitude: number }) => ({ x: longitude, y: 0 })),
  } as unknown as CoordinateTransform;
}

describe('input action chain', () => {
  beforeEach(() => {
    cesium.actions.clear();
  });

  it('runs every subscriber of one action type instead of letting the last one win', () => {
    const handler = new cesium.FakeHandler();
    const first = vi.fn();
    const second = vi.fn();

    const offFirst = addInputAction(handler as never, cesium.LEFT_CLICK, first);
    const offSecond = addInputAction(handler as never, cesium.LEFT_CLICK, second);

    // 只安装一个 Cesium 动作：覆盖语义下再多订阅者也只占一个槽位。
    expect(cesium.actions.size).toBe(1);
    cesium.actions.get(cesium.LEFT_CLICK)?.({ position: { x: 1, y: 2 } });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    offFirst();
    expect(cesium.actions.size).toBe(1);
    offSecond();
    expect(cesium.actions.size).toBe(0);
  });

  it('keeps the action installed while any subscriber remains, and restores an overwritten one', () => {
    const handler = new cesium.FakeHandler();
    const off = addInputAction(handler as never, cesium.MOUSE_MOVE, vi.fn());

    // 业务在订阅期间自己覆盖了同一个动作：退出时不能把业务的动作删掉。
    const business = vi.fn();
    handler.setInputAction(business, cesium.MOUSE_MOVE);
    off();

    expect(cesium.actions.get(cesium.MOUSE_MOVE)).toBe(business);
  });

  it('delivers the event to the other subscribers even when one throws', () => {
    const handler = new cesium.FakeHandler();
    const failure = new Error('listener failed');
    const broken = vi.fn(() => {
      throw failure;
    });
    const healthy = vi.fn();

    addInputAction(handler as never, cesium.LEFT_CLICK, broken);
    addInputAction(handler as never, cesium.LEFT_CLICK, healthy);

    expect(() => {
      cesium.actions.get(cesium.LEFT_CLICK)?.({ position: { x: 1, y: 2 } });
    }).toThrow(failure);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('lets picking and drawing share one viewer handler', () => {
    const handler = new cesium.FakeHandler();
    const coordinates = createCoordinates();
    const picked: unknown[] = [];
    const cameraListeners = new Set<() => void>();
    const viewer = {
      screenSpaceEventHandler: handler,
      scene: {
        pick: vi.fn(() => ({ id: { layerId: 'targets', objectId: 'sat-1' } })),
        drillPick: vi.fn(() => []),
        camera: {
          changed: {
            addEventListener: (listener: () => void) => {
              cameraListeners.add(listener);
              return () => cameraListeners.delete(listener);
            },
          },
        },
        primitives: {
          add: vi.fn((item: unknown) => item),
          remove: vi.fn(() => true),
        },
      },
    };

    // 真实地图里的构造顺序：先拾取，后绘制——绘制曾经把拾取的 LEFT_CLICK 顶掉。
    const picking = new CesiumPickingController(viewer as never, coordinates);
    picking.on('click', (event: PickingEvent) => picked.push(event.hit));
    const drawing = new CesiumDrawingController(viewer as never, coordinates, undefined);

    expect(drawing.start('polyline')).toBe(true);
    cesium.actions.get(cesium.LEFT_CLICK)?.({ position: { x: 10, y: 0 } });

    // 两个控制器都收到了同一次点击：绘制累积了顶点，拾取也照常派发。
    expect(drawing.vertexCount).toBe(1);
    expect(picked).toEqual([{ layerId: 'targets', objectId: 'sat-1', kind: 'layer' }]);

    drawing.dispose();
    // 绘制退出后链上仍有拾取，动作继续安装。
    expect(cesium.actions.size).toBeGreaterThan(0);
    cesium.actions.get(cesium.LEFT_CLICK)?.({ position: { x: 11, y: 0 } });
    expect(picked).toHaveLength(2);

    picking.dispose();
    expect(cesium.actions.size).toBe(0);
  });
});
