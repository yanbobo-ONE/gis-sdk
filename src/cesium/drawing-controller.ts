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
import { DrawingEditMachine } from '../core/drawing-edit.js';
import type { DrawEditTarget } from '../core/drawing-edit.js';
import { isEditableGeometry } from '../core/drawing-edit.js';
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

/** 编辑中样式：品红实线，与预览、完成图形同时可辨。 */
const EDIT_STYLE: DrawStyle = Object.freeze({ color: '#ff5bc8', width: 4 });

/** 编辑会话在状态机中的固定标识：几何存放在控制器里，不进入业务数据。 */
const EDIT_ID = 'drawing-edit';

/** 顶点命中半径（屏幕像素）。 */
const VERTEX_HIT_RADIUS_PX = 12;

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
  private readonly editMachine: DrawingEditMachine;
  private readonly listeners: {
    complete: Set<(event: DrawGeometry) => void>;
    cancel: Set<(event: undefined) => void>;
    edit: Set<(event: DrawGeometry) => void>;
    editCommit: Set<(event: DrawGeometry) => void>;
    editCancel: Set<(event: DrawGeometry) => void>;
  } = {
    complete: new Set(),
    cancel: new Set(),
    edit: new Set(),
    editCommit: new Set(),
    editCancel: new Set(),
  };
  /** 编辑会话的几何副本；会话结束后清零。 */
  private editGeometry: DrawGeometry | undefined;
  /** 进入编辑会话时的快照，用于 `cancelEdit()` 还原。 */
  private editOrigin: DrawGeometry | undefined;
  private editPrimitives: DrawPrimitives | undefined;
  /** 是否正在拖动顶点：左键按下命中顶点后置位，抬起清位。 */
  private dragging = false;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return;
    }
    if (this.dragging) {
      // 拖动中按 Esc 只回退这一次拖动，编辑会话继续。
      this.dragging = false;
      this.editMachine.cancel();
    } else if (this.editGeometry) {
      this.cancelEdit();
    } else {
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
        this.emit('complete', geometry);
      },
      () => {
        this.emit('cancel', undefined);
      },
    );
    this.editMachine = new DrawingEditMachine(
      {
        get: (id) => (id === EDIT_ID ? this.editGeometry : undefined),
        update: (geometry) => {
          this.editGeometry = geometry;
          this.renderEdit();
        },
      },
      (geometry) => {
        this.emit('edit', geometry);
      },
    );

    const handler = viewer.screenSpaceEventHandler;
    handler.setInputAction((movement: Movement) => {
      if (this.editGeometry) {
        // 编辑会话期间左键用于拖动顶点，不再累积绘制顶点。
        return;
      }
      const position = this.pick(movement.position);
      if (position) {
        this.machine.addVertex(position);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction((movement: Movement) => {
      if (this.editGeometry) {
        if (this.dragging) {
          const position = this.pick(movement.position);
          if (position) {
            this.editMachine.move(position);
          }
        }
        return;
      }
      const position = this.pick(movement.position);
      if (position) {
        this.machine.previewPositions(position);
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);
    handler.setInputAction((movement: Movement) => {
      this.beginDrag(movement.position);
    }, ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(() => {
      if (!this.dragging) {
        return;
      }
      this.dragging = false;
      this.editMachine.end();
    }, ScreenSpaceEventType.LEFT_UP);
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
    if (this.editGeometry) {
      this.cancelEdit();
    }
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

  get editing(): DrawGeometry | undefined {
    return this.editGeometry;
  }

  /**
   * 进入编辑会话。
   *
   * 传入几何会被复制，编辑过程与结果都不回写调用方对象；进入编辑会先取消进行中的绘制。
   * 左键按下时按屏幕距离命中最近顶点（默认命中半径 12 像素），拖动中持续更新几何并抛出
   * `edit` 事件，松开左键结束本次拖动但保留会话。
   */
  edit(geometry: DrawGeometry): boolean {
    this.assertActive('edit');
    const candidate: unknown = geometry;
    if (!isEditableGeometry(candidate)) {
      return false;
    }
    if (this.editGeometry) {
      this.cancelEdit();
    }
    this.machine.cancel();
    const copy: DrawGeometry = {
      mode: candidate.mode,
      positions: candidate.positions.map((position) => ({ ...position })),
    };
    this.editOrigin = copy;
    this.editGeometry = copy;
    this.renderEdit();
    return true;
  }

  /** 提交编辑并返回最终几何；没有会话时返回 `undefined`。 */
  commitEdit(): DrawGeometry | undefined {
    this.assertActive('commitEdit');
    const geometry = this.editGeometry;
    if (!geometry) {
      return undefined;
    }
    this.dragging = false;
    this.editGeometry = undefined;
    this.editOrigin = undefined;
    this.renderEdit();
    const committed: DrawGeometry = {
      mode: geometry.mode,
      positions: geometry.positions.map((position) => ({ ...position })),
    };
    this.emit('editCommit', committed);
    return committed;
  }

  /** 取消编辑并丢弃改动，几何回到 `edit()` 时的快照。 */
  cancelEdit(): void {
    this.assertActive('cancelEdit');
    const geometry = this.editGeometry;
    if (!geometry) {
      return;
    }
    this.dragging = false;
    this.editMachine.cancel();
    this.editGeometry = undefined;
    const origin = this.editOrigin;
    this.editOrigin = undefined;
    this.renderEdit();
    this.emit('editCancel', origin ?? geometry);
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
    for (const set of Object.values(this.listeners)) {
      set.clear();
    }
    this.documentRef?.removeEventListener('keydown', this.onKeyDown);
    const handler = this.viewer.screenSpaceEventHandler;
    handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
    handler.removeInputAction(ScreenSpaceEventType.MOUSE_MOVE);
    handler.removeInputAction(ScreenSpaceEventType.LEFT_DOWN);
    handler.removeInputAction(ScreenSpaceEventType.LEFT_UP);
    handler.removeInputAction(ScreenSpaceEventType.RIGHT_CLICK);
    handler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.dragging = false;
    this.editGeometry = undefined;
    this.editOrigin = undefined;
    if (this.editPrimitives) {
      this.remove(this.editPrimitives);
      this.editPrimitives = undefined;
    }
    this.editMachine.dispose();
    this.machine.dispose();
  }

  private emit<TKey extends keyof DrawingEventMap>(kind: TKey, event: DrawingEventMap[TKey]): void {
    const set = this.listeners[kind] as Set<(event: DrawingEventMap[TKey]) => void>;
    for (const listener of [...set]) {
      listener(event);
    }
  }

  /** 左键按下：命中顶点才开始拖动。 */
  private beginDrag(screen: Cartesian2 | undefined): void {
    const geometry = this.editGeometry;
    if (!geometry || !screen || this.dragging) {
      return;
    }
    const index = this.hitTestVertex(screen);
    if (index === undefined) {
      return;
    }
    const target: DrawEditTarget =
      geometry.positions.length > 1 ? { id: EDIT_ID, vertexIndex: index } : { id: EDIT_ID };
    if (this.editMachine.begin(target)) {
      this.dragging = true;
    }
  }

  /** 屏幕坐标命中最近的编辑顶点；都不在命中半径内时返回 `undefined`。 */
  private hitTestVertex(screen: Cartesian2): number | undefined {
    const geometry = this.editGeometry;
    if (!geometry) {
      return undefined;
    }
    if (geometry.positions.length === 1) {
      return 0;
    }
    let hit: number | undefined;
    let nearest = VERTEX_HIT_RADIUS_PX;
    geometry.positions.forEach((position, index) => {
      let window: { x: number; y: number } | undefined;
      try {
        window = this.coordinates.toWindow(position);
      } catch {
        // 非法坐标视为不可命中，不影响其余顶点。
        return;
      }
      if (!window) {
        return;
      }
      const distance = Math.hypot(window.x - screen.x, window.y - screen.y);
      if (distance <= nearest) {
        nearest = distance;
        hit = index;
      }
    });
    return hit;
  }

  /** 用与完成图形同一套渲染路径重画编辑几何。 */
  private renderEdit(): void {
    if (this.editPrimitives) {
      this.remove(this.editPrimitives);
      this.editPrimitives = undefined;
    }
    const geometry = this.editGeometry;
    if (!geometry) {
      return;
    }
    this.editPrimitives = this.render(
      { mode: geometry.mode, positions: geometry.positions, preview: false },
      EDIT_STYLE,
      false,
    );
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
