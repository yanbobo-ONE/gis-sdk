import { ScreenSpaceEventType, defined } from 'cesium';
import type { Cartesian2, Viewer } from 'cesium';

import type {
  CoordinateTransform,
  GeoPosition,
  PickingController,
  PickingEvent,
  PickingEventKind,
  PickingHit,
  PickingMarker,
} from '../core/controls.js';
import { GisError } from '../core/errors.js';
import type { Unsubscribe } from '../core/event-hub.js';
import { addInputAction } from './input-actions.js';
import { pickableEntityMarker } from './layers/pickable-entities.js';

/** 相机停止变化多久后恢复悬停拾取，单位为毫秒。 */
const CAMERA_IDLE_MS = 140;

/** 点击兜底时最多向下钻取的对象数。 */
const DRILL_LIMIT = 8;

/** Cesium 输入回调的移动事件；屏幕坐标是 Cartesian2。 */
interface PickedMovement {
  readonly position?: Cartesian2;
}

function isPickingMarker(value: unknown): value is PickingMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { layerId?: unknown }).layerId === 'string'
  );
}

/**
 * 把原生拾取结果归一化为命中信息。
 *
 * SDK 拥有的可拾取对象用 `id` 写入 {@link PickingMarker}；数据源提供的实体（CZML / GeoJSON）
 * 按已登记的归属还原成图层命中；命中地球表面时按 `'globe'` 归类；其余原生对象归为
 * `'unknown'`，调用方可用事件里的 `raw` 自行识别。
 *
 * @internal
 */
export function toPickingHit(picked: unknown): PickingHit | undefined {
  if (!defined(picked)) {
    return undefined;
  }
  const marker = (picked as { id?: unknown }).id;
  if (isPickingMarker(marker)) {
    return { layerId: marker.layerId, objectId: marker.objectId, kind: 'layer' };
  }
  // 实体图元的 `id` 是实体对象；少数拾取路径直接返回实体本身，两处都查一次。
  const owned = pickableEntityMarker(marker) ?? pickableEntityMarker(picked);
  if (owned) {
    return { layerId: owned.layerId, objectId: owned.objectId, kind: 'layer' };
  }
  if (typeof (picked as { getGeometry?: unknown }).getGeometry === 'function') {
    return { layerId: undefined, objectId: undefined, kind: 'globe' };
  }
  return {
    layerId: undefined,
    objectId: typeof marker === 'string' ? marker : undefined,
    kind: 'unknown',
  };
}

/**
 * Cesium 侧拾取控制器。
 *
 * 悬停拾取按动画帧合并，一帧最多一次 `scene.pick`；相机变化后的 140ms 内暂停拾取，
 * 这两条是 Plugin-web 用于消除"悬停拖动时逐帧拾取拖慢渲染"的做法。
 *
 * @internal
 */
export class CesiumPickingController implements PickingController {
  private readonly listeners: Record<PickingEventKind, Set<(event: PickingEvent) => void>> = {
    click: new Set(),
    hover: new Set(),
  };
  private currentEnabled = true;
  private currentHit: PickingHit | undefined;
  private cameraMoving = false;
  private pendingHover: Cartesian2 | undefined;
  private hoverFrame: number | undefined;
  private cameraIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private removeCameraChanged: (() => void) | undefined;
  /** 输入动作的取消订阅：与绘图控制器共用同一个处理器，按类型挂在同一条链上。 */
  private readonly removeInputActions: Unsubscribe[] = [];
  private disposed = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly coordinates: CoordinateTransform,
  ) {
    const handler = viewer.screenSpaceEventHandler;
    this.removeInputActions.push(
      addInputAction(handler, ScreenSpaceEventType.LEFT_CLICK, (movement) => {
        this.emit('click', (movement as PickedMovement).position);
      }),
      addInputAction(handler, ScreenSpaceEventType.MOUSE_MOVE, (movement) => {
        this.scheduleHover((movement as PickedMovement).position);
      }),
    );

    const removeCameraChanged = viewer.scene.camera.changed.addEventListener(() => {
      this.cameraMoving = true;
      this.pendingHover = undefined;
      if (this.hoverFrame !== undefined) {
        cancelAnimationFrame(this.hoverFrame);
        this.hoverFrame = undefined;
      }
      if (this.cameraIdleTimer !== undefined) {
        clearTimeout(this.cameraIdleTimer);
      }
      this.cameraIdleTimer = setTimeout(() => {
        this.cameraIdleTimer = undefined;
        this.cameraMoving = false;
      }, CAMERA_IDLE_MS);
    });
    if (typeof removeCameraChanged === 'function') {
      this.removeCameraChanged = removeCameraChanged;
    }
  }

  get enabled(): boolean {
    return this.currentEnabled;
  }

  get lastHit(): PickingHit | undefined {
    return this.currentHit;
  }

  on(kind: PickingEventKind, listener: (event: PickingEvent) => void): Unsubscribe {
    this.listeners[kind].add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners[kind].delete(listener);
    };
  }

  setEnabled(enabled: boolean): void {
    if (typeof enabled !== 'boolean') {
      throw new GisError('Picking enabled must be a boolean.', {
        code: 'INVALID_PICKING_CONFIG',
        module: 'picking',
        operation: 'setEnabled',
      });
    }
    this.currentEnabled = enabled;
    if (!enabled) {
      this.pendingHover = undefined;
      if (this.hoverFrame !== undefined) {
        cancelAnimationFrame(this.hoverFrame);
        this.hoverFrame = undefined;
      }
    }
  }

  /** 解绑输入动作、帧回调与相机监听。 */
  dispose(): void {
    this.disposed = true;
    this.listeners.click.clear();
    this.listeners.hover.clear();
    if (this.hoverFrame !== undefined) {
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = undefined;
    }
    if (this.cameraIdleTimer !== undefined) {
      clearTimeout(this.cameraIdleTimer);
      this.cameraIdleTimer = undefined;
    }
    this.removeCameraChanged?.();
    this.removeCameraChanged = undefined;
    for (const remove of this.removeInputActions) {
      remove();
    }
    this.removeInputActions.length = 0;
  }

  /** 合并一帧内的移动事件；相机移动期间不进入拾取。 */
  private scheduleHover(screen: Cartesian2 | undefined): void {
    if (!screen || !this.currentEnabled || this.cameraMoving || this.disposed) {
      return;
    }
    this.pendingHover = screen;
    if (this.hoverFrame !== undefined) {
      return;
    }
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = undefined;
      const latest = this.pendingHover;
      this.pendingHover = undefined;
      if (!latest || !this.currentEnabled || this.cameraMoving || this.disposed) {
        return;
      }
      this.emit('hover', latest);
    });
  }

  private emit(kind: PickingEventKind, screen: Cartesian2 | undefined): void {
    if (!screen || !this.currentEnabled || this.disposed) {
      return;
    }
    const scene = this.viewer.scene;
    const picked: unknown = scene.pick(screen);
    let hit = toPickingHit(picked);
    let raw: unknown = picked;
    if (kind === 'click' && hit?.kind !== 'layer') {
      // 点击时向下钻取，命中被遮挡的 SDK 对象；悬停只信任最上层结果，避免每帧多花拾取开销。
      const drilled: readonly unknown[] = scene.drillPick(screen, DRILL_LIMIT);
      for (const candidate of drilled) {
        const candidateHit = toPickingHit(candidate);
        if (candidateHit?.kind === 'layer') {
          hit = candidateHit;
          raw = candidate;
          break;
        }
      }
    }

    this.currentHit = hit;
    const position = this.resolvePosition(screen);
    const event: PickingEvent = {
      screen: { x: screen.x, y: screen.y },
      hit,
      position,
      raw,
    };
    for (const listener of [...this.listeners[kind]]) {
      try {
        listener(event);
      } catch {
        // 业务监听失败不能中断其余监听或地图交互。
      }
    }
  }

  /** 屏幕位置对应的经纬高；用现有的坐标转换取地表点。 */
  private resolvePosition(screen: Cartesian2): GeoPosition | undefined {
    try {
      return this.coordinates.pickGeoPosition({ x: screen.x, y: screen.y });
    } catch {
      return undefined;
    }
  }
}
