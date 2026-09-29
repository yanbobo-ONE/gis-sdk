import { GisError } from '../core/errors.js';

/** 姿态四元数，单位为无量纲。 */
export interface Quaternion {
  /** X 分量。 */
  readonly x: number;
  /** Y 分量。 */
  readonly y: number;
  /** Z 分量。 */
  readonly z: number;
  /** 标量分量。 */
  readonly w: number;
}

/** 角速度，单位为弧度/秒。 */
export interface AngularVelocity {
  /** 绕 X 轴分量。 */
  readonly x: number;
  /** 绕 Y 轴分量。 */
  readonly y: number;
  /** 绕 Z 轴分量。 */
  readonly z: number;
}

const IDENTITY: Quaternion = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

function invalidAttitude(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'spatial',
    operation,
  });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function add(left: Quaternion, right: Quaternion): Quaternion {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
    w: left.w + right.w,
  };
}

function multiply(left: Quaternion, right: Quaternion): Quaternion {
  return {
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  };
}

/** 按运行时未知输入校验；JS 调用方可能传入缺少字段的对象。 */
function normalize(value: Quaternion | undefined, operation: string): Quaternion {
  const { x, y, z, w } = (value ?? {}) as Partial<Quaternion>;
  if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(z) || !finiteNumber(w)) {
    throw invalidAttitude('Attitude quaternion must contain finite x, y, z, and w.', operation);
  }
  const length = Math.hypot(x, y, z, w);
  if (length <= 0) {
    throw invalidAttitude('Attitude quaternion must not be all zeros.', operation);
  }
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

/**
 * 刚体姿态积分。
 *
 * 以常角速度推进四元数，每步都重新归一化，避免长时间累积导致四元数漂移。
 * 该模型只做运动学积分（不涉及转动惯量与力矩），适合把外部给出的角速度
 * 表达成可渲染的朝向。
 */
export class AttitudeDynamics {
  private current: Quaternion;
  private velocity: AngularVelocity;

  constructor(
    attitude: Quaternion = IDENTITY,
    angularVelocity: AngularVelocity = { x: 0, y: 0, z: 0 },
  ) {
    this.current = normalize(attitude, 'create');
    this.velocity = this.normalizeVelocity(angularVelocity, 'create');
  }

  /** 当前姿态（始终归一化）。 */
  get attitude(): Quaternion {
    return { ...this.current };
  }

  /** 当前角速度。 */
  get angularVelocity(): AngularVelocity {
    return { ...this.velocity };
  }

  /** 设置角速度，单位为弧度/秒。 */
  setAngularVelocity(value: AngularVelocity): void {
    this.velocity = this.normalizeVelocity(value, 'setAngularVelocity');
  }

  /** 直接设置姿态；传入值会被归一化。 */
  setAttitude(value: Quaternion): void {
    this.current = normalize(value, 'setAttitude');
  }

  /**
   * 按当前角速度推进 `deltaSeconds`。
   *
   * @param deltaSeconds - 时间增量，单位为秒；必须为非负有限数。
   * @returns 推进后的姿态。
   * @throws `INVALID_SPATIAL_INPUT` 时间增量或角速度无效。
   */
  advance(deltaSeconds: number): Quaternion {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw invalidAttitude(
        'Angular advance time must be a non-negative finite number of seconds.',
        'advance',
      );
    }
    const half = {
      x: (this.velocity.x * deltaSeconds) / 2,
      y: (this.velocity.y * deltaSeconds) / 2,
      z: (this.velocity.z * deltaSeconds) / 2,
      w: 0,
    };
    this.current = normalize(add(this.current, multiply(this.current, half)), 'advance');
    return this.attitude;
  }

  private normalizeVelocity(
    value: AngularVelocity | undefined,
    operation: string,
  ): AngularVelocity {
    const { x, y, z } = (value ?? {}) as Partial<AngularVelocity>;
    if (!finiteNumber(x) || !finiteNumber(y) || !finiteNumber(z)) {
      throw invalidAttitude('Angular velocity must contain finite x, y, and z.', operation);
    }
    return { x, y, z };
  }
}
