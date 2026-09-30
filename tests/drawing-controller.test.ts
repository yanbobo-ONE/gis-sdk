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
    LEFT_DOWN: 8,
    LEFT_UP: 9,
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
    LEFT_DOWN: cesium.LEFT_DOWN,
    LEFT_UP: cesium.LEFT_UP,
  },
}));

import { CesiumDrawingController } from '../src/cesium/drawing-controller.js';
import type { CoordinateTransform } from '../src/core/controls.js';
import type { DrawGeometry } from '../src/core/drawing.js';

const polylineGeometry = (): DrawGeometry => ({
  mode: 'polyline',
  positions: [
    { longitude: 10, latitude: 0 },
    { longitude: 11, latitude: 0 },
    { longitude: 12, latitude: 0 },
  ],
});

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
    // 顶点在地图上的屏幕横坐标等于其经度，便于构造命中与不命中的落点。
    toWindow: vi.fn(({ longitude }: { longitude: number }) => ({ x: longitude, y: 0 })),
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

    expect(cesium.actions.size).toBe(6);
    expect(harness.keyListenerCount()).toBe(1);
    controller.edit(polylineGeometry());
    expect(harness.items.length).toBeGreaterThan(0);

    controller.dispose();

    expect(cesium.actions.size).toBe(0);
    expect(harness.keyListenerCount()).toBe(0);
    expect(harness.items).toHaveLength(0);
    expect(() => controller.start('point')).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED' }),
    );
    expect(() => controller.edit(polylineGeometry())).toThrow(
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

  it('edits a copy of the geometry and drags the nearest vertex', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    const input = polylineGeometry();
    const edits: DrawGeometry[] = [];
    const commits: DrawGeometry[] = [];
    controller.on('edit', (geometry) => edits.push(geometry));
    controller.on('editCommit', (geometry) => commits.push(geometry));

    expect(controller.edit(input)).toBe(true);
    expect(controller.editing).toEqual(input);
    expect(controller.editing).not.toBe(input);
    expect(controller.editing?.positions[0]).not.toBe(input.positions[0]);

    // 左键按在最接近的顶点（屏幕横坐标 = 经度）上开始拖动。
    cesium.actions.get(cesium.LEFT_DOWN)?.(screen(11.4));
    expect(edits).toHaveLength(0);
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(50));
    expect(controller.editing?.positions).toEqual([
      { longitude: 10, latitude: 0 },
      { longitude: 50, latitude: 0 },
      { longitude: 12, latitude: 0 },
    ]);
    expect(edits).toHaveLength(1);
    // 调用方传入的几何不受影响。
    expect(input.positions[1]).toEqual({ longitude: 11, latitude: 0 });

    // 松开左键结束拖动，但会话保留：此后移动鼠标不再改变几何。
    cesium.actions.get(cesium.LEFT_UP)?.();
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(70));
    expect(controller.editing?.positions[1]).toEqual({ longitude: 50, latitude: 0 });

    const committed = controller.commitEdit();
    expect(commits).toHaveLength(1);
    expect(committed?.positions[1]).toEqual({ longitude: 50, latitude: 0 });
    expect(controller.editing).toBeUndefined();
    expect(controller.commitEdit()).toBeUndefined();
  });

  it('moves the whole point geometry without a hit test', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );

    expect(controller.edit({ mode: 'point', positions: [{ longitude: 5, latitude: 0 }] })).toBe(
      true,
    );
    cesium.actions.get(cesium.LEFT_DOWN)?.(screen(300));
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(7));

    expect(controller.editing?.positions).toEqual([{ longitude: 7, latitude: 0 }]);
  });

  it('restores the snapshot when the edit session is cancelled', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    const input = polylineGeometry();
    const cancels: DrawGeometry[] = [];
    controller.on('editCancel', (geometry) => cancels.push(geometry));

    controller.edit(input);
    cesium.actions.get(cesium.LEFT_DOWN)?.(screen(10));
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(80));
    cesium.actions.get(cesium.LEFT_UP)?.();
    expect(controller.editing?.positions[0]).toEqual({ longitude: 80, latitude: 0 });

    harness.pressEscape();

    expect(cancels).toEqual([input]);
    expect(controller.editing).toBeUndefined();
    expect(harness.items).toHaveLength(0);
  });

  it('reverts only the drag when Escape is pressed mid-drag', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    const cancels: DrawGeometry[] = [];
    controller.on('editCancel', (geometry) => cancels.push(geometry));

    controller.edit(polylineGeometry());
    cesium.actions.get(cesium.LEFT_DOWN)?.(screen(11));
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(60));
    expect(controller.editing?.positions[1]).toEqual({ longitude: 60, latitude: 0 });

    harness.pressEscape();

    expect(controller.editing?.positions[1]).toEqual({ longitude: 11, latitude: 0 });
    expect(controller.editing).toBeDefined();
    expect(cancels).toHaveLength(0);
  });

  it('ignores drag starts that miss every vertex', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    const edits: DrawGeometry[] = [];
    controller.on('edit', (geometry) => edits.push(geometry));

    const spread: DrawGeometry = {
      mode: 'polyline',
      positions: [
        { longitude: 0, latitude: 0 },
        { longitude: 100, latitude: 0 },
      ],
    };
    controller.edit(spread);
    // 第 1 个顶点被视锥剔除：屏幕同一位置不再命中。
    (harness.coordinates.toWindow as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      undefined,
    );
    cesium.actions.get(cesium.LEFT_DOWN)?.(screen(0));
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(40));
    expect(edits).toHaveLength(0);
    expect(controller.editing?.positions).toEqual(spread.positions);

    // 被剔除的是视锥外的顶点，其余顶点照常命中。
    cesium.actions.get(cesium.LEFT_DOWN)?.(screen(100));
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(60));
    expect(controller.editing?.positions[1]).toEqual({ longitude: 60, latitude: 0 });

    // 超出命中半径的落点同样不开始拖动。
    const near = { ...controller.editing };
    cesium.actions.get(cesium.LEFT_DOWN)?.(screen(240));
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(300));
    expect(edits).toHaveLength(1);
    expect(controller.editing).toEqual(near);
  });

  it('rejects geometry that cannot be edited', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );

    expect(controller.edit({ mode: 'polyline', positions: [] })).toBe(false);
    expect(
      controller.edit({ mode: 'point', positions: [{ longitude: Number.NaN, latitude: 0 }] }),
    ).toBe(false);
    expect(controller.editing).toBeUndefined();
    expect(harness.items).toHaveLength(0);
  });

  it('keeps drawing and editing sessions mutually exclusive', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    const cancels: DrawGeometry[] = [];
    controller.on('editCancel', (geometry) => cancels.push(geometry));

    controller.start('polyline');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(1));
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(2));
    expect(controller.mode).toBe('polyline');

    // 进入编辑会先取消进行中的绘制。
    controller.edit(polylineGeometry());
    expect(controller.mode).toBeUndefined();
    expect(controller.vertexCount).toBe(0);

    // 编辑会话期间左键不再累积绘制顶点。
    const before = harness.items.length;
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(30));
    expect(harness.items.length).toBe(before);

    // 重新开始绘制会结束编辑会话。
    controller.start('point');
    expect(cancels).toEqual([polylineGeometry()]);
    expect(controller.editing).toBeUndefined();
    expect(controller.mode).toBe('point');
  });

  it('snaps picked positions to completed vertices when enabled', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    const completed: DrawGeometry[] = [];
    controller.on('complete', (geometry) => completed.push(geometry));

    // 先画一条折线：(10,0) → (12,0)。
    controller.start('polyline');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(10));
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(12));
    cesium.actions.get(cesium.LEFT_DOUBLE_CLICK)?.();
    expect(completed).toHaveLength(1);

    // 吸附关闭时落点按拾取结果走（11）；随后移除它，避免它自己成为吸附目标。
    controller.start('point');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(11));
    expect(completed[1]?.positions[0]).toEqual({ longitude: 11, latitude: 0 });
    controller.removeLatestCompleted();

    // 打开吸附：11 距离顶点 10 只有 1 像素，落点应吸到 10。
    controller.setSnap({ enabled: true, pixelTolerance: 12 });
    expect(controller.snap).toEqual({ enabled: true, pixelTolerance: 12, includeEdges: false });
    controller.start('point');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(11));
    cesium.actions.get(cesium.LEFT_DOUBLE_CLICK)?.();

    // 关掉吸附后回到拾取结果。
    controller.setSnap({ enabled: false });
    controller.start('point');
    cesium.actions.get(cesium.LEFT_CLICK)?.(screen(11));
    cesium.actions.get(cesium.LEFT_DOUBLE_CLICK)?.();
    expect(completed[completed.length - 1]?.positions[0]).toEqual({ longitude: 11, latitude: 0 });
  });

  it('snaps a dragged vertex to its neighbours and rejects invalid tolerance', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );
    expect(() => {
      controller.setSnap({ enabled: true, pixelTolerance: 0 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_DRAWING_INPUT' }));

    controller.setSnap({ enabled: true, pixelTolerance: 12 });
    controller.edit(polylineGeometry());
    // 拖动第 3 个顶点（经度 12），光标落在 11：距离顶点 11（第二个顶点）最近，应吸过去。
    cesium.actions.get(cesium.LEFT_DOWN)?.(screen(12));
    cesium.actions.get(cesium.MOUSE_MOVE)?.(screen(11));

    expect(controller.editing?.positions[2]).toEqual({ longitude: 11, latitude: 0 });
  });

  it('delegates insert and remove vertex to the edit session', () => {
    const harness = createHarness();
    const controller = new CesiumDrawingController(
      harness.viewer as never,
      harness.coordinates,
      harness.documentRef as never,
    );

    // 没有编辑会话时返回 undefined，而不是抛错。
    expect(controller.insertVertex({ longitude: 1, latitude: 1 })).toBeUndefined();
    expect(controller.removeVertex(0)).toBeUndefined();

    controller.edit(polylineGeometry());
    const inserted = controller.insertVertex({ longitude: 10.5, latitude: 0 }, 1);
    expect(inserted?.positions.map((vertex) => vertex.longitude)).toEqual([10, 10.5, 11, 12]);
    // 起点就是编辑顶点：插入会写进几何，但返回的是副本。
    expect(inserted).not.toBe(controller.editing);

    const removed = controller.removeVertex(0);
    expect(removed?.positions.map((vertex) => vertex.longitude)).toEqual([10.5, 11, 12]);

    controller.dispose();
    expect(() => controller.insertVertex({ longitude: 1, latitude: 1 })).toThrow(
      expect.objectContaining({ code: 'MAP_DISPOSED' }),
    );
  });
});
