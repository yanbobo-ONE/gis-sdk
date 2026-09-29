import type { GeoPosition } from './controls.js';
import { GisError } from './errors.js';
import type { DrawGeometry } from './drawing.js';

/** 编辑目标。 */
export interface DrawEditTarget {
  /** 会话标识，用于诊断与事件。 */
  readonly id: string;
  /** 顶点索引；省略表示整体移动（点几何）。 */
  readonly vertexIndex?: number;
}

/** 编辑会话的只读快照。 */
export interface DrawEditSnapshot {
  /** 会话标识。 */
  readonly id: string;
  /** 正在编辑的顶点索引；整体移动时为 `undefined`。 */
  readonly vertexIndex: number | undefined;
  /** 当前几何（拖动过程中实时更新）。 */
  readonly geometry: DrawGeometry;
}

/** 编辑状态机依赖的端口：把"几何存在哪里"交给调用方。 */
export interface DrawingEditPort {
  /** 读取当前几何；不存在时返回 `undefined`。 */
  get(id: string): DrawGeometry | undefined;
  /** 写回几何。 */
  update(geometry: DrawGeometry): void;
}

function invalidEdit(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_DRAWING_INPUT',
    module: 'drawing',
    operation,
  });
}

function cloneGeometry(geometry: DrawGeometry): DrawGeometry {
  return {
    mode: geometry.mode,
    positions: geometry.positions.map((position) => ({ ...position })),
  };
}

/**
 * 校验拖动落点：必须是范围内的有限经纬高。
 *
 * @param position - 待校验的落点；可传任意值。
 * @returns 是否为可直接写入几何的合法落点。
 */
export function isValidDrawPosition(position: unknown): position is GeoPosition {
  const { longitude, latitude, height = 0 } = (position ?? {}) as Partial<GeoPosition>;
  return (
    typeof longitude === 'number' &&
    typeof latitude === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    Number.isFinite(height) &&
    Math.abs(longitude) <= 180 &&
    Math.abs(latitude) <= 90
  );
}

/**
 * 校验一份几何是否可进入编辑会话：模式合法且至少有一个合法顶点。
 *
 * @param geometry - 待校验的几何；可传任意值。
 * @returns 是否可以作为编辑对象。
 */
export function isEditableGeometry(geometry: unknown): geometry is DrawGeometry {
  if (typeof geometry !== 'object' || geometry === null) {
    return false;
  }
  const { mode, positions } = geometry as { mode?: unknown; positions?: unknown };
  return (
    (mode === 'point' || mode === 'polyline' || mode === 'polygon') &&
    Array.isArray(positions) &&
    positions.length > 0 &&
    positions.every(isValidDrawPosition)
  );
}

/**
 * 绘制编辑状态机。
 *
 * 只维护"正在编辑哪个顶点、原值是什么"，几何的实际存放位置由 {@link DrawingEditPort} 决定，
 * 因此同一套编辑流程可以作用在绘制会话的临时几何上，也可以作用在业务自己的数据上。
 *
 * 与绘制一致，非法落点（非有限值或超出经纬范围）会被忽略而不是中断编辑；`cancel()` 会
 * 把几何恢复成开始编辑前的快照。
 */
export class DrawingEditMachine {
  private active: { readonly target: DrawEditTarget; readonly origin: DrawGeometry } | undefined;
  private disposed = false;

  constructor(
    private readonly port: DrawingEditPort,
    private readonly onChange?: (geometry: DrawGeometry) => void,
    private readonly onCommit?: (geometry: DrawGeometry) => void,
    private readonly onCancel?: (geometry: DrawGeometry) => void,
  ) {}

  /** 当前编辑会话；没有会话时为 `undefined`。 */
  get snapshot(): DrawEditSnapshot | undefined {
    if (!this.active) {
      return undefined;
    }
    const geometry = this.port.get(this.active.target.id);
    return geometry === undefined
      ? undefined
      : {
          id: this.active.target.id,
          vertexIndex: this.active.target.vertexIndex,
          geometry,
        };
  }

  /**
   * 开始编辑。
   *
   * @param target - 会话标识与可选顶点索引；多顶点几何必须给出合法索引，点几何不能给出索引。
   * @returns 是否成功开始；几何不存在或索引非法时返回 `false`。
   */
  begin(target: DrawEditTarget): boolean {
    const candidate: unknown = target;
    const { id } = (candidate ?? {}) as Partial<DrawEditTarget>;
    if (this.disposed || typeof id !== 'string' || id.length === 0) {
      return false;
    }
    const geometry = this.port.get(id);
    if (!geometry) {
      return false;
    }
    const multiVertex = geometry.positions.length > 1;
    if (multiVertex) {
      const index = target.vertexIndex;
      if (index === undefined || !Number.isInteger(index) || index < 0 || index >= geometry.positions.length) {
        return false;
      }
    } else if (target.vertexIndex !== undefined) {
      return false;
    }
    this.active = { target, origin: cloneGeometry(geometry) };
    return true;
  }

  /**
   * 把当前编辑对象移动到新的落点。
   *
   * @param position - 新的 WGS84 经纬高；非法落点被忽略。
   * @returns 更新后的几何；没有会话或落点非法时返回 `undefined`。
   */
  move(position: GeoPosition): DrawGeometry | undefined {
    if (this.disposed || !this.active || !isValidDrawPosition(position)) {
      return undefined;
    }
    const current = this.port.get(this.active.target.id);
    if (!current) {
      return undefined;
    }
    const vertexIndex = this.active.target.vertexIndex;
    const positions =
      vertexIndex === undefined
        ? [{ ...position }]
        : current.positions.map((vertex, index) => (index === vertexIndex ? { ...position } : { ...vertex }));
    const geometry: DrawGeometry = { mode: current.mode, positions };
    this.port.update(geometry);
    this.onChange?.(cloneGeometry(geometry));
    return geometry;
  }

  /** 提交编辑并结束会话。 */
  end(): DrawGeometry | undefined {
    if (this.disposed || !this.active) {
      return undefined;
    }
    const id = this.active.target.id;
    this.active = undefined;
    const geometry = this.port.get(id);
    if (geometry) {
      this.onCommit?.(cloneGeometry(geometry));
    }
    return geometry;
  }

  /** 取消编辑：恢复开始前的几何并结束会话。 */
  cancel(): DrawGeometry | undefined {
    if (this.disposed || !this.active) {
      return undefined;
    }
    const { target, origin } = this.active;
    this.active = undefined;
    this.port.update(origin);
    const restored = this.port.get(target.id) ?? origin;
    this.onCancel?.(cloneGeometry(restored));
    return restored;
  }

  /** 丢弃会话（不恢复几何），之后 `begin` 会抛错。 */
  dispose(): void {
    this.disposed = true;
    this.active = undefined;
  }

  /** 供端口实现方在几何被删除时调用，避免继续往不存在的目标写数据。 */
  assertActive(operation = 'edit'): void {
    if (this.disposed) {
      throw invalidEdit('Drawing edit machine has been disposed.', operation);
    }
  }
}
