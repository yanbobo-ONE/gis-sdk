import { beforeEach, describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  type Action = (movement: { position?: { x: number; y: number } }) => void;
  const actions = new Map<number, Action>();
  class FakeHandler {
    constructor(readonly canvas: unknown) {}
    setInputAction(action: Action, type: number): void {
      // 与 Cesium 一致：一个动作类型只有一个回调，后注册的覆盖先注册的。
      actions.set(type, action);
    }
    getInputAction(type: number): Action | undefined {
      return actions.get(type);
    }
    removeInputAction(type: number): void {
      actions.delete(type);
    }
  }
  return {
    actions,
    FakeHandler,
    LEFT_CLICK: 3,
    MOUSE_MOVE: 15,
  };
});

vi.mock('cesium', () => ({
  ScreenSpaceEventHandler: cesium.FakeHandler,
  ScreenSpaceEventType: { LEFT_CLICK: cesium.LEFT_CLICK, MOUSE_MOVE: cesium.MOUSE_MOVE },
  defined: (value: unknown) => value !== undefined,
}));

import { CesiumPickingController, toPickingHit } from '../src/cesium/picking-controller.js';
import { registerPickableEntities } from '../src/cesium/layers/pickable-entities.js';
import type { CoordinateTransform, GeoPosition, PickingEvent } from '../src/core/controls.js';

function createViewer() {
  const cameraListeners = new Set<() => void>();
  const pick = vi.fn();
  const drillPick = vi.fn(() => [] as unknown[]);
  const viewer = {
    screenSpaceEventHandler: new cesium.FakeHandler({}),
    scene: {
      pick,
      drillPick,
      camera: {
        changed: {
          addEventListener: (listener: () => void) => {
            cameraListeners.add(listener);
            return () => cameraListeners.delete(listener);
          },
        },
      },
    },
  };
  const coordinates = {
    pickGeoPosition: vi.fn((): GeoPosition => ({ longitude: 116.39, latitude: 39.9, height: 12 })),
  } as unknown as CoordinateTransform;
  return {
    viewer,
    coordinates,
    pick,
    drillPick,
    fireCameraChanged: () => {
      for (const listener of [...cameraListeners]) listener();
    },
    cameraListenerCount: () => cameraListeners.size,
  };
}

/** 用受控的 rAF 队列替换全局实现，便于精确验证"一帧一次拾取"。 */
function createFrameQueue() {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    callbacks[handle - 1] = () => undefined;
  });
  return {
    runFrame: () => {
      const pending = [...callbacks];
      callbacks.length = 0;
      for (const callback of pending) callback(0);
    },
    pendingCount: () => callbacks.length,
  };
}

describe('CesiumPickingController', () => {
  beforeEach(() => {
    cesium.actions.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('resolves SDK markers, globe hits, and unknown objects', () => {
    expect(toPickingHit(undefined)).toBeUndefined();
    expect(toPickingHit({ id: { layerId: 'targets', objectId: 'sat-1' } })).toEqual({
      layerId: 'targets',
      objectId: 'sat-1',
      kind: 'layer',
    });
    expect(toPickingHit({ id: { layerId: 'vehicle' } })).toEqual({
      layerId: 'vehicle',
      objectId: undefined,
      kind: 'layer',
    });
    expect(toPickingHit({ getGeometry: () => undefined })).toEqual({
      layerId: undefined,
      objectId: undefined,
      kind: 'globe',
    });
    expect(toPickingHit({ id: 'business-entity' })).toEqual({
      layerId: undefined,
      objectId: 'business-entity',
      kind: 'unknown',
    });
    expect(toPickingHit({})).toEqual({ layerId: undefined, objectId: undefined, kind: 'unknown' });
  });

  it('resolves entities registered by managed data-source layers', () => {
    const satellite = { id: 'sat-1' };
    const anonymous = {};
    const business = { id: 'business-entity' };
    registerPickableEntities([satellite, anonymous], 'orbits');

    // 实体图元的 `id` 是实体对象本身。
    expect(toPickingHit({ id: satellite })).toEqual({
      layerId: 'orbits',
      objectId: 'sat-1',
      kind: 'layer',
    });
    // 实体没有字符串 id 时仍然归属图层，只是没有对象 id。
    expect(toPickingHit({ id: anonymous })).toEqual({
      layerId: 'orbits',
      objectId: undefined,
      kind: 'layer',
    });
    // 少数拾取路径直接返回实体。
    expect(toPickingHit(satellite)).toMatchObject({ layerId: 'orbits', kind: 'layer' });
    // 业务自己的实体没有登记，仍按原生对象处理。
    expect(toPickingHit({ id: business })).toEqual({
      layerId: undefined,
      objectId: undefined,
      kind: 'unknown',
    });
  });

  it('emits click events with the marker hit and the picked geo position', () => {
    const view = createViewer();
    view.pick.mockReturnValue({ id: { layerId: 'targets', objectId: 'sat-1' } });
    const controller = new CesiumPickingController(view.viewer as never, view.coordinates);
    const events: PickingEvent[] = [];
    controller.on('click', (event) => events.push(event));

    cesium.actions.get(cesium.LEFT_CLICK)?.({ position: { x: 10, y: 20 } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      screen: { x: 10, y: 20 },
      hit: { layerId: 'targets', objectId: 'sat-1', kind: 'layer' },
      position: { longitude: 116.39, latitude: 39.9, height: 12 },
    });
    expect(controller.lastHit).toMatchObject({ layerId: 'targets' });
    expect(view.drillPick).not.toHaveBeenCalled();
  });

  it('drills down on click but not on hover', () => {
    const view = createViewer();
    const frames = createFrameQueue();
    view.pick.mockReturnValue({ id: 'other' });
    view.drillPick.mockReturnValue([{ id: { layerId: 'targets', objectId: 'p-2' } }]);
    const controller = new CesiumPickingController(view.viewer as never, view.coordinates);
    const clicks: PickingEvent[] = [];
    const hovers: PickingEvent[] = [];
    controller.on('click', (event) => clicks.push(event));
    controller.on('hover', (event) => hovers.push(event));

    cesium.actions.get(cesium.LEFT_CLICK)?.({ position: { x: 1, y: 1 } });
    expect(clicks[0]?.hit).toMatchObject({ layerId: 'targets', objectId: 'p-2' });

    cesium.actions.get(cesium.MOUSE_MOVE)?.({ position: { x: 2, y: 2 } });
    frames.runFrame();

    expect(hovers[0]?.hit).toMatchObject({ kind: 'unknown', objectId: 'other' });
    expect(view.drillPick).toHaveBeenCalledTimes(1);
  });

  it('merges hover movement into one pick per animation frame', () => {
    const view = createViewer();
    const frames = createFrameQueue();
    view.pick.mockReturnValue({ id: { layerId: 'targets' } });
    const controller = new CesiumPickingController(view.viewer as never, view.coordinates);
    const hovers: PickingEvent[] = [];
    controller.on('hover', (event) => hovers.push(event));

    const move = cesium.actions.get(cesium.MOUSE_MOVE);
    move?.({ position: { x: 1, y: 1 } });
    move?.({ position: { x: 2, y: 2 } });
    move?.({ position: { x: 3, y: 3 } });

    expect(frames.pendingCount()).toBe(1);
    expect(view.pick).not.toHaveBeenCalled();

    frames.runFrame();

    // 只保留最后一次位置，并且一帧只拾取一次。
    expect(view.pick).toHaveBeenCalledTimes(1);
    expect(hovers).toHaveLength(1);
    expect(hovers[0]?.screen).toEqual({ x: 3, y: 3 });
  });

  it('suppresses hover picking while the camera is moving', () => {
    vi.useFakeTimers();
    const view = createViewer();
    const frames = createFrameQueue();
    view.pick.mockReturnValue({ id: { layerId: 'targets' } });
    const controller = new CesiumPickingController(view.viewer as never, view.coordinates);
    const hovers: PickingEvent[] = [];
    controller.on('hover', (event) => hovers.push(event));

    view.fireCameraChanged();
    cesium.actions.get(cesium.MOUSE_MOVE)?.({ position: { x: 1, y: 1 } });
    frames.runFrame();
    expect(hovers).toHaveLength(0);
    expect(view.pick).not.toHaveBeenCalled();

    // 相机停止 140ms 后恢复拾取。
    vi.advanceTimersByTime(140);
    cesium.actions.get(cesium.MOUSE_MOVE)?.({ position: { x: 2, y: 2 } });
    frames.runFrame();
    expect(hovers).toHaveLength(1);
    vi.useRealTimers();
  });

  it('stops emitting when disabled and rejects invalid values', () => {
    const view = createViewer();
    const frames = createFrameQueue();
    view.pick.mockReturnValue({ id: { layerId: 'targets' } });
    const controller = new CesiumPickingController(view.viewer as never, view.coordinates);
    const clicks: PickingEvent[] = [];
    controller.on('click', (event) => clicks.push(event));

    expect(controller.enabled).toBe(true);
    controller.setEnabled(false);
    expect(controller.enabled).toBe(false);
    cesium.actions.get(cesium.LEFT_CLICK)?.({ position: { x: 1, y: 1 } });
    cesium.actions.get(cesium.MOUSE_MOVE)?.({ position: { x: 1, y: 1 } });
    frames.runFrame();
    expect(clicks).toHaveLength(0);
    expect(view.pick).not.toHaveBeenCalled();

    expect(() => {
      controller.setEnabled('yes' as never);
    }).toThrow(expect.objectContaining({ code: 'INVALID_PICKING_CONFIG' }));
  });

  it('unbinds input actions, frame callbacks, and camera listeners on dispose', () => {
    const view = createViewer();
    const frames = createFrameQueue();
    const controller = new CesiumPickingController(view.viewer as never, view.coordinates);
    const hovers: PickingEvent[] = [];
    controller.on('hover', (event) => hovers.push(event));

    cesium.actions.get(cesium.MOUSE_MOVE)?.({ position: { x: 1, y: 1 } });
    expect(view.cameraListenerCount()).toBe(1);

    controller.dispose();

    expect(cesium.actions.size).toBe(0);
    expect(view.cameraListenerCount()).toBe(0);
    frames.runFrame();
    expect(hovers).toHaveLength(0);
  });
});
