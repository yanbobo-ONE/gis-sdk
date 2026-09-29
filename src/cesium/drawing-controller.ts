import {
  Cartesian3,
  Color,
  Material,
  PointPrimitiveCollection,
  PolylineCollection,
  ScreenSpaceEventType,
} from 'cesium';
import type { Cartesian2, Viewer } from 'cesium';

import type {
  CoordinateTransform,
  DrawingEventMap,
  GeoPosition,
  MapDrawingController,
} from '../core/controls.js';
import type { DrawGeometry, DrawMode, DrawRendererPort, DrawRenderValue } from '../core/drawing.js';
import { DrawingStateMachine } from '../core/drawing.js';
import { GisError } from '../core/errors.js';
import type { Unsubscribe } from '../core/event-hub.js';

interface DrawStyle {
  readonly color: string;
  readonly width: number;
}

/** 预览样式：黄色虚线，与完成图形区分。 */
const PREVIEW_STYLE: DrawStyle = Object.freeze({ color: '#ffd166', width: 2 });

/** 已完成图形样式。 */
const COMPLETED_STYLE: DrawStyle = Object.freeze({ color: '#43bfeb', width: 3 });

interface Movement {
  readonly position?: Cartesian2;
}

/** 一组绘制图元；移除时整组释放。 */
interface DrawPrimitives {
  readonly points: PointPrimitiveCollection;
  readonly polylines: PolylineCollection;
}

function parseColor(value: string): Color {
  // 这两个色值是本模块的常量；解析失败时回退白色，保证渲染不中断。
  const parsed: unknown = Color.fromCssColorString(value);
  return parsed ? (parsed as Color) : Color.WHITE;
}

function toCartesian(position: GeoPosition): Cartesian3 {
  return Cartesian3.fromDegrees(position.longitude, position.latitude, position.height ?? 0);
}

/**
 * Cesium 侧绘制控制器。
 *
 * 输入由 Cesium 的输入动作驱动：左键落点、鼠标移动预览、右键或双击确认、Esc 取消。
 * 绘制流程与几何累积由 `DrawingStateMachine` 负责，本类只做两件事：
 * 屏幕拾取 → 地理坐标，以及把 `DrawRenderValue` 画成图元。
 *
 * @internal
 */
export class CesiumDrawingController implements MapDrawingController {
  private readonly machine: DrawingStateMachine<DrawPrimitives, DrawPrimitives>;
  private readonly listeners: {
    complete: Set<(event: DrawGeometry) => void>;
    cancel: Set<(event: undefined) => void>;
  } = { complete: new Set(), cancel: new Set() };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.machine.cancel();
    }
  };
  private disposed = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly coordinates: CoordinateTransform,
    private readonly documentRef: Document | undefined = typeof document === 'undefined'
      ? undefined
      : document,
  ) {
    this.machine = new DrawingStateMachine<DrawPrimitives, DrawPrimitives>(
      this.createRenderer(),
      (geometry) => {
        for (const listener of [...this.listeners.complete]) {
          listener(geometry);
        }
      },
      () => {
        for (const listener of [...this.listeners.cancel]) {
          listener(undefined);
        }
      },
    );

    const handler = viewer.screenSpaceEventHandler;
    handler.setInputAction((movement: Movement) => {
      const position = this.pick(movement.position);
      if (position) {
        this.machine.addVertex(position);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((movement: Movement) => {
      const position = this.pick(movement.position);
      if (position) {
        this.machine.previewPositions(position);
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((movement: Movement) => {
      this.machine.finish(this.pick(movement.position));
    }, ScreenSpaceEventType.RIGHT_CLICK);
    handler.setInputAction(() => {
      this.machine.finish();
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.documentRef?.addEventListener('keydown', this.onKeyDown);
  }

  get mode(): DrawMode | undefined {
    return this.machine.mode;
  }

  get vertexCount(): number {
    return this.machine.vertexCount;
  }

  start(mode: DrawMode): boolean {
    this.assertActive('start');
    return this.machine.start(mode);
  }

  finish(): DrawGeometry | undefined {
    this.assertActive('finish');
    return this.machine.finish();
  }

  cancel(): void {
    this.assertActive('cancel');
    this.machine.cancel();
  }

  removeLatestCompleted(): void {
    this.assertActive('removeLatestCompleted');
    this.machine.removeLatestCompleted();
  }

  clearCompleted(): void {
    this.assertActive('clearCompleted');
    this.machine.clearCompleted();
  }

  on<TKey extends keyof DrawingEventMap>(
    kind: TKey,
    listener: (event: DrawingEventMap[TKey]) => void,
  ): Unsubscribe {
    const set = this.listeners[kind] as Set<(event: DrawingEventMap[TKey]) => void>;
    set.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      set.delete(listener);
    };
  }

  /** 解绑输入动作与键盘监听，并释放全部绘制图元。 */
  dispose(): void {
    this.disposed = true;
    this.listeners.complete.clear();
    this.listeners.cancel.clear();
    this.documentRef?.removeEventListener('keydown', this.onKeyDown);
    const handler = this.viewer.screenSpaceEventHandler;
    handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    handler.removeInputAction(ScreenSpaceEventType.MOUSE_MOVE);
    handler.removeInputAction(ScreenSpaceEventType.RIGHT_CLICK);
    handler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.machine.dispose();
  }

  /** 屏幕坐标 → 地表经纬高；未命中地球时返回 `undefined`。 */
  private pick(screen: Cartesian2 | undefined): GeoPosition | undefined {
    if (!screen) {
      return undefined;
    }
    try {
      return this.coordinates.pickGeoPosition({ x: screen.x, y: screen.y });
    } catch {
      return undefined;
    }
  }

  private assertActive(operation: string): void {
    if (this.disposed) {
      throw new GisError('Drawing controller has been disposed.', {
        code: 'MAP_DISPOSED',
        module: 'drawing',
        operation,
      });
    }
  }

  /** 渲染端口：预览与完成图形各用一组图元，用颜色与线型区分。 */
  private createRenderer(): DrawRendererPort<DrawPrimitives, DrawPrimitives> {
    return {
      renderPreview: (value) => this.render(value, PREVIEW_STYLE, true),
      renderCompleted: (value) => this.render(value, COMPLETED_STYLE, false),
      removePreview: (handle) => {
        this.remove(handle);
      },
      removeCompleted: (handle) => {
        this.remove(handle);
      },
    };
  }

  private render(value: DrawRenderValue, style: DrawStyle, preview: boolean): DrawPrimitives {
    const color = parseColor(style.color);
    const points = new PointPrimitiveCollection();
    for (const position of value.positions) {
      points.add({ position: toCartesian(position), color, pixelSize: style.width + 3 });
    }

    const polylines = new PolylineCollection();
    if (value.mode !== 'point' && value.positions.length > 1) {
      const line = polylines.add({ positions: value.positions.map(toCartesian) });
      line.width = style.width;
      // 只用公开材质类型：预览虚线、完成实线。
      line.material = preview
        ? Material.fromType('PolylineDash', { color, dashLength: 12 })
        : Material.fromType('Color', { color });
    }

    this.viewer.scene.primitives.add(points);
    this.viewer.scene.primitives.add(polylines);
    return { points, polylines };
  }

  private remove(handle: DrawPrimitives): void {
    if (!this.viewer.scene.primitives.remove(handle.polylines)) {
      handle.polylines.destroy();
    }
    if (!this.viewer.scene.primitives.remove(handle.points)) {
      handle.points.destroy();
    }
  }
}
