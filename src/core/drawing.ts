import type { GeoPosition } from './controls.js';
import { GisError } from './errors.js';

/** 绘制模式。 */
export type DrawMode = 'point' | 'polyline' | 'polygon';

/** 一次绘制的结果；顶点使用 WGS84 经纬高。 */
export interface DrawGeometry {
  /** 绘制模式。 */
  readonly mode: DrawMode;
  /** 顶点序列；点模式为 1 个顶点，折线至少 2 个，面至少 3 个。 */
  readonly positions: readonly GeoPosition[];
}

/** 交给渲染端口的绘制画面。 */
export interface DrawRenderValue {
  /** 绘制模式。 */
  readonly mode: DrawMode;
  /** 当前顶点（预览时最后一个顶点是光标位置）。 */
  readonly positions: readonly GeoPosition[];
  /** 是否为预览：预览画面在光标移动时不断替换，不进入已完成集合。 */
  readonly preview: boolean;
}

/**
 * 绘制渲染端口。
 *
 * 端口把"画什么"与"怎么画"分开：Cesium 侧用图元预览，其它终端可以把同一份
 * `DrawRenderValue` 画到任意画布上。
 */
export interface DrawRendererPort<TPreviewHandle = unknown, TCompletedHandle = unknown> {
  /** 渲染预览；返回的句柄会传给 `removePreview`。 */
  renderPreview(value: DrawRenderValue): TPreviewHandle;
  /** 渲染已完成图形；返回的句柄会传给 `removeCompleted`。 */
  renderCompleted(value: DrawRenderValue): TCompletedHandle;
  /** 移除预览句柄。 */
  removePreview(handle: TPreviewHandle): void;
  /** 移除已完成图形句柄。 */
  removeCompleted(handle: TCompletedHandle): void;
}

/** 各模式的最少顶点数。 */
const MINIMUM_VERTICES: Readonly<Record<DrawMode, number>> = Object.freeze({
  point: 1,
  polyline: 2,
  polygon: 3,
});

const MODES: readonly DrawMode[] = ['point', 'polyline', 'polygon'];

function invalidInput(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_DRAWING_INPUT',
    module: 'drawing',
    operation,
  });
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 校验并规范化一个绘制顶点。
 *
 * 只接受 WGS84 范围内的有限经纬度；非法顶点被忽略而不是中断绘制。
 */
function isValidVertex(position: unknown): position is GeoPosition {
  const { longitude, latitude, height = 0 } = (position ?? {}) as Partial<GeoPosition>;
  return (
    finite(longitude) &&
    finite(latitude) &&
    finite(height) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
}

/**
 * 绘制状态机。
 *
 * 只负责绘制流程与几何累积，不关心输入来自鼠标、触摸还是脚本：
 * 调用方把"左键落点"交给 `addVertex`、"光标移动"交给 `previewPositions`、
 * "右键/双击确认"交给 `finish`、"Esc 取消"交给 `cancel`。
 *
 * 各模式的完成条件与 Plugin-web 的既有交互一致：
 *
 * - `point`：落一个点即完成；
 * - `polyline`：至少 2 个顶点，确认时把光标位置并入；
 * - `polygon`：至少 3 个顶点，确认时把光标位置并入；
 * - 顶点不足时的确认不会结束绘制，也不会产生结果。
 */
export class DrawingStateMachine<TPreviewHandle = unknown, TCompletedHandle = unknown> {
  private currentMode: DrawMode | undefined;
  private vertices: GeoPosition[] = [];
  private previewHandle: TPreviewHandle | undefined;
  private readonly completed: TCompletedHandle[] = [];

  constructor(
    private readonly renderer: DrawRendererPort<TPreviewHandle, TCompletedHandle>,
    private readonly onComplete?: (geometry: DrawGeometry) => void,
    private readonly onCancel?: () => void,
  ) {}

  /** 当前绘制模式；未在绘制时为 `undefined`。 */
  get mode(): DrawMode | undefined {
    return this.currentMode;
  }

  /** 已确定的顶点数（不含预览用的光标位置）。 */
  get vertexCount(): number {
    return this.vertices.length;
  }

  /** 是否正在绘制。 */
  get drawing(): boolean {
    return this.currentMode !== undefined;
  }

  /**
   * 开始绘制。
   *
   * 开始新的绘制会先取消进行中的那一次，避免两份预览同时存在。
   *
   * @param mode - `'point'`、`'polyline'` 或 `'polygon'`。
   * @returns 是否成功开始；模式取值不受支持时返回 `false`。
   */
  start(mode: DrawMode): boolean {
    if (!MODES.includes(mode)) {
      return false;
    }
    this.cancel();
    this.currentMode = mode;
    this.vertices = [];
    return true;
  }

  /**
   * 追加一个顶点。
   *
   * 点模式立即完成并返回几何；折线与面模式只累积顶点。
   *
   * @param position - 顶点坐标；非法坐标被忽略。
   * @returns 点模式的完成结果；其余情况为 `undefined`。
   */
  addVertex(position: GeoPosition): DrawGeometry | undefined {
    if (!this.drawing || !isValidVertex(position)) {
      return undefined;
    }
    if (this.currentMode === 'point') {
      return this.complete([position]);
    }
    this.vertices.push({ ...position });
    return undefined;
  }

  /**
   * 更新预览：把光标位置作为最后一个临时顶点渲染。
   *
   * @param position - 光标位置；非法坐标或点模式（无预览）时不渲染。
   */
  previewPositions(position: GeoPosition): void {
    if (!this.drawing || !this.currentMode || !isValidVertex(position)) {
      return;
    }
    this.clearPreview();
    if (this.currentMode === 'point' || this.vertices.length === 0) {
      return;
    }
    this.previewHandle = this.renderer.renderPreview({
      mode: this.currentMode,
      positions: [...this.vertices, position],
      preview: true,
    });
  }

  /**
   * 结束绘制。
   *
   * @param position - 可选的收尾顶点（右键/双击位置）；给定时并入几何。
   * @returns 满足最少顶点数时的几何；否则返回 `undefined` 且保持绘制中。
   */
  finish(position?: GeoPosition): DrawGeometry | undefined {
    if (!this.drawing || !this.currentMode) {
      return undefined;
    }
    const positions = [...this.vertices];
    if (position !== undefined && isValidVertex(position)) {
      positions.push({ ...position });
    }
    if (positions.length < MINIMUM_VERTICES[this.currentMode]) {
      return undefined;
    }
    return this.complete(positions);
  }

  /** 取消当前绘制并移除预览；已完成图形不受影响。 */
  cancel(): void {
    if (this.currentMode === undefined && this.vertices.length === 0) {
      return;
    }
    this.clearPreview();
    this.currentMode = undefined;
    this.vertices = [];
    this.onCancel?.();
  }

  /** 移除全部已完成图形。 */
  clearCompleted(): void {
    for (const handle of this.completed.splice(0)) {
      this.renderer.removeCompleted(handle);
    }
  }

  /** 移除最近一次完成的图形。 */
  removeLatestCompleted(): void {
    const handle = this.completed.pop();
    if (handle === undefined) {
      return;
    }
    try {
      this.renderer.removeCompleted(handle);
    } catch {
      // 渲染器可能已经销毁；这里只保证控制器自身状态一致。
    }
  }

  /** 取消当前绘制并清除已完成图形。 */
  dispose(): void {
    this.cancel();
    this.clearCompleted();
  }

  private complete(positions: readonly GeoPosition[]): DrawGeometry {
    const mode = this.currentMode;
    if (!mode) {
      throw invalidInput('Drawing has no active mode.', 'finish');
    }
    this.clearPreview();
    const geometry: DrawGeometry = { mode, positions: positions.map((vertex) => ({ ...vertex })) };
    this.completed.push(
      this.renderer.renderCompleted({ mode, positions: geometry.positions, preview: false }),
    );
    this.currentMode = undefined;
    this.vertices = [];
    this.onComplete?.(geometry);
    return geometry;
  }

  private clearPreview(): void {
    if (this.previewHandle === undefined) {
      return;
    }
    this.renderer.removePreview(this.previewHandle);
    this.previewHandle = undefined;
  }
}
