import { GisError } from '../core/errors.js';
import type { Vector3 } from './orbit.js';

/**
 * 参与接近分析的物体。
 *
 * 在分析窗口内按**匀速直线运动**处理（不考虑引力与机动），适合短窗口的接近预警。
 */
export interface ApproachTrack {
  /** 对象标识，必须非空且在本次分析内唯一。 */
  readonly id: string;
  /** 当前位置，单位为米。 */
  readonly position: Vector3;
  /** 当前速度，单位为米/秒。 */
  readonly velocity: Vector3;
  /** 碰撞半径，单位为米，默认 0；两物体半径之和会作为距离阈值的一部分。 */
  readonly radiusMeters?: number;
}

/** 一次接近告警。 */
export interface ApproachWarning {
  /** 第一个对象 id。 */
  readonly firstId: string;
  /** 第二个对象 id。 */
  readonly secondId: string;
  /** 最近接近时刻，相对当前时刻的秒数；落在分析窗口内。 */
  readonly timeSeconds: number;
  /** 最近接近时的距离，单位为米。 */
  readonly distanceMeters: number;
}

/** 接近分析配置。 */
export interface ApproachOptions {
  /** 分析时间窗口，单位为秒。 */
  readonly horizonSeconds: number;
  /** 距离阈值，单位为米，默认 1000。 */
  readonly thresholdMeters?: number;
}

const DEFAULT_THRESHOLD_METERS = 1_000;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function invalidInput(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'spatial',
    operation: 'findClosestApproaches',
  });
}

function isFiniteVector(value: unknown): value is Vector3 {
  const vector = value as Partial<Vector3> | undefined;
  return (
    !!vector && Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z)
  );
}

/**
 * 找出时间窗口内会互相接近的对象对。
 *
 * 对每一对物体求相对运动的最近点：相对位移 `r`、相对速度 `v`，最近时刻为
 * `t = clamp(−(r·v)/|v|², 0, 窗口)`；当最近距离不超过 `max(阈值, 两半径之和)` 时给出告警，
 * 结果按最近时刻升序排列。
 *
 * **复杂度是两两比较（O(n²)）**：几百个对象不成问题，成千上万时应先按空间分箱裁剪候选对。
 * 匀速直线假设也意味着它只适合短窗口预警，长时间推演请用 `propagateTwoBody` 先采样再比较。
 *
 * @param tracks - 参与分析的物体；id 必须非空且唯一。
 * @param options - 时间窗口与距离阈值。
 * @returns 接近告警，按最近时刻升序；没有接近时为空心数组。
 * @throws `INVALID_SPATIAL_INPUT` 参数或物体状态无效、id 重复，或取值越界。
 */
export function findClosestApproaches(
  tracks: readonly ApproachTrack[],
  options: ApproachOptions | undefined,
): readonly ApproachWarning[] {
  if (!Array.isArray(tracks)) {
    throw invalidInput('Approach tracks must be an array.');
  }
  const { horizonSeconds } = options ?? {};
  const thresholdMeters = options?.thresholdMeters ?? DEFAULT_THRESHOLD_METERS;
  if (!finiteNumber(horizonSeconds) || horizonSeconds < 0) {
    throw invalidInput('Approach horizonSeconds must be a non-negative finite number.');
  }
  if (!finiteNumber(thresholdMeters) || thresholdMeters < 0) {
    throw invalidInput('Approach thresholdMeters must be a non-negative finite number.');
  }

  const seen = new Set<string>();
  for (const track of tracks as readonly unknown[]) {
    const candidate = (track ?? {}) as Partial<ApproachTrack>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id) {
      throw invalidInput('Approach track id must be a non-empty string.');
    }
    if (seen.has(id)) {
      throw invalidInput(`Approach track id "${id}" is duplicated.`);
    }
    seen.add(id);
    if (!isFiniteVector(candidate.position) || !isFiniteVector(candidate.velocity)) {
      throw invalidInput(`Approach track "${id}" must contain finite position and velocity.`);
    }
    const radius = candidate.radiusMeters ?? 0;
    if (!finiteNumber(radius) || radius < 0) {
      throw invalidInput(
        `Approach track "${id}" radiusMeters must be a non-negative finite number.`,
      );
    }
  }

  const warnings: ApproachWarning[] = [];
  for (let index = 0; index < tracks.length; index += 1) {
    for (let other = index + 1; other < tracks.length; other += 1) {
      const left = tracks[index] as ApproachTrack;
      const right = tracks[other] as ApproachTrack;
      const relativePosition: Vector3 = {
        x: left.position.x - right.position.x,
        y: left.position.y - right.position.y,
        z: left.position.z - right.position.z,
      };
      const relativeVelocity: Vector3 = {
        x: left.velocity.x - right.velocity.x,
        y: left.velocity.y - right.velocity.y,
        z: left.velocity.z - right.velocity.z,
      };
      const speedSquared =
        relativeVelocity.x ** 2 + relativeVelocity.y ** 2 + relativeVelocity.z ** 2;
      const approachTime =
        speedSquared === 0
          ? 0
          : Math.max(
              0,
              Math.min(
                horizonSeconds,
                -(
                  relativePosition.x * relativeVelocity.x +
                  relativePosition.y * relativeVelocity.y +
                  relativePosition.z * relativeVelocity.z
                ) / speedSquared,
              ),
            );
      const distance = Math.hypot(
        relativePosition.x + relativeVelocity.x * approachTime,
        relativePosition.y + relativeVelocity.y * approachTime,
        relativePosition.z + relativeVelocity.z * approachTime,
      );
      const effectiveThreshold = Math.max(
        thresholdMeters,
        (left.radiusMeters ?? 0) + (right.radiusMeters ?? 0),
      );
      if (distance <= effectiveThreshold) {
        warnings.push({
          firstId: left.id,
          secondId: right.id,
          timeSeconds: approachTime,
          distanceMeters: distance,
        });
      }
    }
  }
  return warnings.sort((left, right) => left.timeSeconds - right.timeSeconds);
}
