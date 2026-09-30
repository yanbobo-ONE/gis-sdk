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

/** 航向 / 俯仰 / 翻滚，单位为度。 */
export interface HeadingPitchRollDegrees {
  /** 航向：正北为 0，顺时针为正。 */
  readonly heading: number;
  /** 俯仰：抬头为正。 */
  readonly pitch: number;
  /** 翻滚：右倾为正。 */
  readonly roll: number;
}

/**
 * 归一化四元数。
 *
 * @param value - 任意非零四元数。
 * @returns 单位四元数。
 * @throws `INVALID_SPATIAL_INPUT` 分量非有限值或全零。
 */
export function normalizeQuaternion(value: Quaternion): Quaternion {
  return normalize(value, 'normalizeQuaternion');
}

/**
 * 四元数球面线性插值（slerp），走**最短弧**。
 *
 * 两个姿态夹角很小时退化为线性插值再归一化（nlerp）：此时 slerp 的 `sin` 分母趋近 0，
 * 数值上不稳定，而两者结果差异远小于浮点误差。
 *
 * @param from - 起始姿态。
 * @param to - 结束姿态。
 * @param ratio - 插值比例，0 取 `from`、1 取 `to`；超出范围会按端点夹取。
 * @returns 插值后的单位四元数。
 * @throws `INVALID_SPATIAL_INPUT` 四元数非法或比例非有限数。
 */
export function slerp(from: Quaternion, to: Quaternion, ratio: number): Quaternion {
  const start = normalize(from, 'slerp');
  const end = normalize(to, 'slerp');
  if (!finiteNumber(ratio)) {
    throw invalidAttitude('slerp ratio must be a finite number.', 'slerp');
  }
  const clamped = Math.min(1, Math.max(0, ratio));
  let dot = start.x * end.x + start.y * end.y + start.z * end.z + start.w * end.w;
  // 四元数与它的相反数表示同一姿态：取较近的那一支，保证走最短弧。
  const target: Quaternion = dot < 0 ? { x: -end.x, y: -end.y, z: -end.z, w: -end.w } : end;
  dot = Math.abs(dot);
  if (dot > 0.9995) {
    return normalize(
      {
        x: start.x + (target.x - start.x) * clamped,
        y: start.y + (target.y - start.y) * clamped,
        z: start.z + (target.z - start.z) * clamped,
        w: start.w + (target.w - start.w) * clamped,
      },
      'slerp',
    );
  }
  const angle = Math.acos(Math.min(1, dot));
  const sin = Math.sin(angle);
  const startWeight = Math.sin((1 - clamped) * angle) / sin;
  const endWeight = Math.sin(clamped * angle) / sin;
  return normalize(
    {
      x: start.x * startWeight + target.x * endWeight,
      y: start.y * startWeight + target.y * endWeight,
      z: start.z * startWeight + target.z * endWeight,
      w: start.w * startWeight + target.w * endWeight,
    },
    'slerp',
  );
}

/**
 * 航向 / 俯仰 / 翻滚（度）转四元数。
 *
 * 与 Cesium 的 `HeadingPitchRoll`（以及 SDK 模型图层的 `orientation`）**逐位一致**：航向绕 -Z、
 * 俯仰绕 -Y、翻滚绕 +X，组合顺序 `heading · pitch · roll`。因此同一组角度既能直接喂给模型图层，
 * 也能与 CZML 的 `unitQuaternion` 对照。
 *
 * @param value - 航向 / 俯仰 / 翻滚，单位为度。
 * @returns 单位四元数。
 * @throws `INVALID_SPATIAL_INPUT` 任一分量非有限数。
 */
export function quaternionFromHeadingPitchRollDegrees(
  value: HeadingPitchRollDegrees,
): Quaternion {
  const candidate: unknown = value;
  const { heading, pitch, roll } = (candidate ?? {}) as Partial<HeadingPitchRollDegrees>;
  if (!finiteNumber(heading) || !finiteNumber(pitch) || !finiteNumber(roll)) {
    throw invalidAttitude(
      'heading, pitch, and roll must be finite degrees.',
      'quaternionFromHeadingPitchRollDegrees',
    );
  }
  // 与 Cesium 的 `HeadingPitchRoll` 完全一致：航向绕 -Z、俯仰绕 -Y、翻滚绕 +X，
  // 组合顺序为 heading · pitch · roll。这样同一组角度传给模型图层与 SDK 得到同一姿态。
  const halfHeading = -(heading * Math.PI) / 360;
  const halfPitch = -(pitch * Math.PI) / 360;
  const halfRoll = (roll * Math.PI) / 360;
  const headingQuaternion: Quaternion = {
    x: 0,
    y: 0,
    z: Math.sin(halfHeading),
    w: Math.cos(halfHeading),
  };
  const pitchQuaternion: Quaternion = {
    x: 0,
    y: Math.sin(halfPitch),
    z: 0,
    w: Math.cos(halfPitch),
  };
  const rollQuaternion: Quaternion = {
    x: Math.sin(halfRoll),
    y: 0,
    z: 0,
    w: Math.cos(halfRoll),
  };
  return normalize(multiply(multiply(headingQuaternion, pitchQuaternion), rollQuaternion), 'quaternionFromHeadingPitchRollDegrees');
}

/**
 * 四元数转航向 / 俯仰 / 翻滚（度）。
 *
 * 与 {@link quaternionFromHeadingPitchRollDegrees} 互为逆运算（在俯仰不越过 ±90° 时唯一）；
 * 翻滚与航向是姿态在该顺序下的分解值，可直接写进模型图层的 `orientation`。
 *
 * @param value - 任意非零四元数。
 * @returns 航向 ∈ [0, 360)、俯仰 ∈ [-90, 90]、翻滚 ∈ (-180, 180]，单位为度。
 * @throws `INVALID_SPATIAL_INPUT` 四元数非法。
 */
export function headingPitchRollDegreesFromQuaternion(value: Quaternion): HeadingPitchRollDegrees {
  const { x, y, z, w } = normalize(value, 'headingPitchRollDegreesFromQuaternion');
  const heading = -Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const pitch = -Math.asin(Math.min(1, Math.max(-1, 2 * (w * y - z * x))));
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
  const wrap = (degrees: number): number => ((degrees % 360) + 360) % 360;
  // 归一化负零：否则恒等姿态会给出 -0，比较与序列化时容易让人困惑。
  const zeroSafe = (degrees: number): number => (degrees === 0 ? 0 : degrees);
  return {
    heading: zeroSafe(wrap(toDegrees(heading))),
    pitch: zeroSafe(toDegrees(pitch)),
    roll: zeroSafe(((toDegrees(roll) + 540) % 360) - 180),
  };
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
