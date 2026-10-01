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
  DrawingSnapOptions,
  GeoPosition,
  MapDrawingController,
  ResolvedDrawingSnapOptions,
} from '../core/controls.js';
import type { DrawGeometry, DrawMode, DrawRendererPort, DrawRenderValue } from '../core/drawing.js';
import { DrawingStateMachine } from '../core/drawing.js';
import { DrawingEditMachine, insertVertexAt, removeVertexAt } from '../core/drawing-edit.js';
import type { DrawEditTarget } from '../core/drawing-edit.js';
import { isEditableGeometry } from '../core/drawing-edit.js';
import { findSnapTarget, resolveSnapOptions } from '../core/drawing-snap.js';
import type { SnapSegment, SnapVertex } from '../core/drawing-snap.js';
import { GisError } from '../core/errors.js';
import type { Unsubscribe } from '../core/event-hub.js';
import { addInputAction } from './input-actions.js';

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

/** 复制一份几何，避免把内部状态直接交给调用方。 */
function cloneGeometry(geometry: DrawGeometry): DrawGeometry {
  return {
    mode: geometry.mode,
    positions: geometry.positions.map((position) => ({ ...position })),
  };
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
  /** 吸附配置；默认关闭，行为与未实现吸附时完全一致。 */
  private snapOptions: ResolvedDrawingSnapOptions = { ...resolveSnapOptions(), enabled: false };
  /** 已完成几何，按渲染句柄索引：吸附候选按需投影，移除时精确删除。 */
  private readonly completedSnapSources = new Map<DrawPrimitives, DrawGeometry>();
  /** 绘制中的已确定顶点（预览会带上光标位置，这里只留已确定的）。 */
  private drawPreviewSnap: DrawGeometry | undefined;
  /** 编辑会话中正在拖动的顶点下标，吸附时要排除它自身。 */
  private editVertexIndex: number | undefined;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return;
    }
    if (this.dragging) {
      // 拖动中按 Esc 只回退这一次拖动，编辑会话继续。
      this.dragging = false;
      this.editVertexIndex = undefined;
      this.editMachine.cancel();
    } else if (this.editGeometry) {
      this.cancelEdit();
    } else {
      this.machine.cancel();
    }
  };
  private disposed = false;
  /** 输入动作的取消订阅：与拾取控制器共用同一个处理器，按类型挂在同一条链上。 */
  private readonly removeInputActions: Unsubscribe[] = [];

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
    // 与拾取控制器共用同一个处理器：动作按类型挂到同一条链上，直接 setInputAction 会互相覆盖。
    this.removeInputActions.push(
      addInputAction(handler, ScreenSpaceEventType.LEFT_CLICK, (movement) => {
        const { position } = movement as Movement;
        if (this.editGeometry) {
          // 编辑会话期间左键用于拖动顶点，不再累积绘制顶点。
          return;
        }
        const picked = this.pick(position, true);
        if (picked) {
          this.machine.addVertex(picked);
        }
      }),
      addInputAction(handler, ScreenSpaceEventType.MOUSE_MOVE, (movement) => {
        const { position } = movement as Movement;
        if (this.editGeometry) {
          if (this.dragging) {
            const picked = this.pick(position, true);
            if (picked) {
              this.editMachine.move(picked);
            }
          }
          return;
        }
        const picked = this.pick(position, true);
        if (picked) {
          this.machine.previewPositions(picked);
        }
      }),
      addInputAction(handler, ScreenSpaceEventType.LEFT_DOWN, (movement) => {
        this.beginDrag((movement as Movement).position);
      }),
      addInputAction(handler, ScreenSpaceEventType.LEFT_UP, () => {
        if (!this.dragging) {
          return;
        }
        this.dragging = false;
        this.editVertexIndex = undefined;
        this.editMachine.end();
      }),
      addInputAction(handler, ScreenSpaceEventType.RIGHT_CLICK, (movement) => {
        this.machine.finish(this.pick((movement as Movement).position));
      }),
      addInputAction(handler, ScreenSpaceEventType.LEFT_DOUBLE_CLICK, () => {
        this.machine.finish();
      }),
    );
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

  get snap(): ResolvedDrawingSnapOptions {
    return this.snapOptions;
  }

  /**
   * 设置吸附配置。
   *
   * 关闭吸附会立即丢弃已收集的候选；开启后在每次落点与拖动时按屏幕像素阈值吸附。
   */
  setSnap(options: DrawingSnapOptions): void {
    this.assertActive('setSnap');
    const resolved = resolveSnapOptions(options);
    this.snapOptions = {
      enabled: options.enabled,
      pixelTolerance: resolved.pixelTolerance,
      includeEdges: resolved.includeEdges,
    };
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

  /**
   * 在编辑会话中插入顶点。
   *
   * 会话整体由控制器持有（而不是按拖动起停），因此这里直接在当前编辑几何上做增删并重绘；
   * 顶点算法的纯函数在 `/core`，其它终端可以直接复用。
   */
  insertVertex(position: GeoPosition, index?: number): DrawGeometry | undefined {
    this.assertActive('insertVertex');
    const current = this.editGeometry;
    if (!current) {
      return undefined;
    }
    const geometry = insertVertexAt(current, position, index);
    if (!geometry) {
      return undefined;
    }
    this.editGeometry = geometry;
    // 插入点在拖动目标之前时，拖动目标后移一位。
    const target = index ?? current.positions.length;
    if (this.editVertexIndex !== undefined && target <= this.editVertexIndex) {
      this.editVertexIndex += 1;
    }
    this.renderEdit();
    return cloneGeometry(geometry);
  }

  /** 在编辑会话中删除顶点；删除正在编辑的顶点后，拖动目标顺延到后一个顶点。 */
  removeVertex(index?: number): DrawGeometry | undefined {
    this.assertActive('removeVertex');
    const current = this.editGeometry;
    if (!current) {
      return undefined;
    }
    const target = index ?? this.editVertexIndex;
    if (target === undefined) {
      return undefined;
    }
    const geometry = removeVertexAt(current, target);
    if (!geometry) {
      return undefined;
    }
    this.editGeometry = geometry;
    if (this.editVertexIndex !== undefined) {
      this.editVertexIndex =
        this.editVertexIndex === target
          ? Math.min(target, geometry.positions.length - 1)
          : target < this.editVertexIndex
            ? this.editVertexIndex - 1
            : this.editVertexIndex;
    }
    this.renderEdit();
    return cloneGeometry(geometry);
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
    for (const remove of this.removeInputActions) {
      remove();
    }
    this.removeInputActions.length = 0;
    this.dragging = false;
    this.editVertexIndex = undefined;
    this.editGeometry = undefined;
    this.editOrigin = undefined;
    this.drawPreviewSnap = undefined;
    this.completedSnapSources.clear();
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
      this.editVertexIndex = geometry.positions.length > 1 ? index : undefined;
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
  private pick(screen: Cartesian2 | undefined, applySnap = false): GeoPosition | undefined {
    if (!screen) {
      return undefined;
    }
    let position: GeoPosition | undefined;
    try {
      position = this.coordinates.pickGeoPosition({ x: screen.x, y: screen.y });
    } catch {
      return undefined;
    }
    if (!position || !applySnap || !this.snapOptions.enabled) {
      return position;
    }
    return this.snapPosition(screen, position);
  }

  /**
   * 把落点吸附到已完成图形与当前绘制顶点的最近候选上。
   *
   * 编辑会话中额外把"同一图形里除当前拖动顶点之外的顶点"作为候选，因此拖动时也能对齐到相邻顶点。
   */
  private snapPosition(screen: Cartesian2, fallback: GeoPosition): GeoPosition {
    const candidates = this.collectSnapCandidates();
    const hit = findSnapTarget(
      candidates.vertices,
      candidates.segments,
      { x: screen.x, y: screen.y },
      this.snapOptions,
    );
    return hit ? hit.position : fallback;
  }

  /** 收集当前所有吸附候选：已完成图形 + 绘制中的已确定顶点 + 编辑图形（排除拖动中的顶点）。 */
  private collectSnapCandidates(): {
    readonly vertices: SnapVertex[];
    readonly segments: SnapSegment[];
  } {
    const geometries = [...this.completedSnapSources.values()];
    if (this.drawPreviewSnap) {
      geometries.push(this.drawPreviewSnap);
    }
    const editing = this.editGeometry;
    const skipIndex = editing ? this.editVertexIndex : undefined;
    if (editing) {
      geometries.push({ mode: editing.mode, positions: editing.positions });
    }
    return projectSnapCandidates(geometries, this.coordinates, skipIndex);
  }

  /**
   * 进入编辑会话。
   *
   * 传入几何会被复制，编辑过程与结果都不回写调用方对象；进入编辑会先取消进行中的绘制。
   * 左键按下时按屏幕距离命中最近顶点（默认命中半径 12 像素），拖动中持续更新几何并抛出
   * `edit` 事件，松开左键结束本次拖动但保留会话。
   */
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
      renderPreview: (value) => {
        // 预览的最后一个顶点是光标位置，只把已确定的顶点留作吸附候选。
        // 候选只存几何副本，投影推迟到真正吸附时做，因此吸附关闭时几乎没有额外开销。
        this.drawPreviewSnap =
          value.positions.length > 1
            ? {
                mode: value.mode,
                positions: value.positions.slice(0, -1).map((position) => ({ ...position })),
              }
            : undefined;
        return this.render(value, PREVIEW_STYLE, true);
      },
      renderCompleted: (value) => {
        const handle = this.render(value, COMPLETED_STYLE, false);
        this.completedSnapSources.set(handle, {
          mode: value.mode,
          positions: value.positions.map((position) => ({ ...position })),
        });
        return handle;
      },
      removePreview: (handle) => {
        this.drawPreviewSnap = undefined;
        this.remove(handle);
      },
      removeCompleted: (handle) => {
        this.completedSnapSources.delete(handle);
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

/**
 * 把一组几何投影成吸附候选。
 *
 * `skipIndex` 指定的顶点会被排除（编辑拖动时排除自身）；该顶点两侧的线段也随之断开——
 * 这是刻意的取舍：宁可少一条候选，也不要吸附到"已经不在那里的线段"上。
 */
function projectSnapCandidates(
  geometries: readonly DrawGeometry[],
  coordinates: CoordinateTransform,
  skipIndex: number | undefined,
): { readonly vertices: SnapVertex[]; readonly segments: SnapSegment[] } {
  const vertices: SnapVertex[] = [];
  const segments: SnapSegment[] = [];
  for (const geometry of geometries) {
    const projected = geometry.positions.map((position, index): SnapVertex | undefined | null => {
      if (skipIndex !== undefined && index === skipIndex) {
        return null;
      }
      let window: { x: number; y: number } | undefined;
      try {
        window = coordinates.toWindow(position);
      } catch {
        window = undefined;
      }
      return window ? { position, screen: window } : undefined;
    });
    for (const vertex of projected) {
      if (vertex) {
        vertices.push(vertex);
      }
    }
    if (geometry.mode === 'point') {
      continue;
    }
    for (let index = 0; index + 1 < projected.length; index += 1) {
      const from = projected[index];
      const to = projected[index + 1];
      if (!from || !to) {
        continue;
      }
      segments.push({
        from: from.position,
        fromScreen: from.screen,
        to: to.position,
        toScreen: to.screen,
      });
    }
  }
  return { vertices, segments };
}
