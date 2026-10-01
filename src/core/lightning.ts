import type { GeoPosition } from './controls.js';
import { GisError } from './errors.js';
import { createLocalFrame } from '../spatial/geodesy.js';

/** 分支密度。 */
export type LightningBranchDensity = 'sparse' | 'normal' | 'dense';

/** 分支密度到"主干顶点预算占比 / 最大分支数"的映射。 */
const BRANCH_PROFILES: Readonly<
  Record<LightningBranchDensity, { readonly ratio: number; readonly maxBranches: number }>
> = Object.freeze({
  sparse: { ratio: 0.45, maxBranches: 2 },
  normal: { ratio: 0.75, maxBranches: 4 },
  dense: { ratio: 1, maxBranches: 6 },
});

/** 抖动幅度下限与上限，单位为米。 */
const JITTER_MIN_METERS = 40;
const JITTER_MAX_METERS = 320;

/** 分支横向散开系数与向下偏移，单位为米。 */
const BRANCH_SPREAD_METERS = 240;
const BRANCH_DROP_METERS = 320;

function invalidLightning(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_SPATIAL_INPUT',
    module: 'lightning',
    operation,
  });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertPosition(position: unknown, label: string, operation: string): GeoPosition {
  const candidate = position as
    | { readonly longitude?: unknown; readonly latitude?: unknown; readonly height?: unknown }
    | undefined;
  if (
    !candidate ||
    !finiteNumber(candidate.longitude) ||
    !finiteNumber(candidate.latitude) ||
    (candidate.height !== undefined && !finiteNumber(candidate.height))
  ) {
    throw invalidLightning(
      `Lightning ${label} needs finite longitude / latitude(and optional height).`,
      operation,
    );
  }
  return position as GeoPosition;
}

/**
 * mulberry32 伪随机数发生器。
 *
 * 同一种子在所有平台产生同一序列，因此闪电形状可复现、可做黄金用例断言；
 * 效果层想每次不同时传入不同的 `seed` 即可。
 */
export function createSeededRandom(seed: number): () => number {
  let state = Math.floor(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 闪击亮度包络：给定归一化相位返回 0 到 1 的亮度。
 *
 * 形状是"预闪 → 主峰（相位 0.14）→ 若干次脉冲 → 余辉"，与效果层渲染时用的曲线一致，
 * 因此屏幕闪光、云体照亮与折线高亮可以共用同一条包络而不是各自实现。
 *
 * @param phase - 归一化相位，超出 0 到 1 会被夹取。
 * @param pulses - 主峰之后的脉冲次数，取 0 到 3；非有限值按 1 处理。
 */
export function lightningEnvelope(phase: number, pulses: number): number {
  const clamped = Math.min(Math.max(finiteNumber(phase) ? phase : 0, 0), 1);
  const requestedPulses = finiteNumber(pulses) ? Math.min(Math.max(pulses, 0), 3) : 1;
  const pulse = (center: number, width: number): number => {
    const distance = (clamped - center) / Math.max(width, 0.001);
    return Math.exp(-distance * distance);
  };
  const preflash = (1 - Math.min(1, clamped / 0.12)) * 0.32;
  const main = pulse(0.14, 0.07);
  let secondary = 0;
  for (let index = 0; index < 3; index += 1) {
    if (index + 0.5 > requestedPulses) {
      break;
    }
    secondary = Math.max(secondary, pulse(0.36 + index * 0.15, 0.032) * (0.78 - 0.16 * index));
  }
  const afterglow = (1 - Math.min(1, Math.max(0, (clamped - 0.55) / 0.45))) * 0.22;
  return Math.min(1, Math.max(main, Math.max(secondary, Math.max(preflash, afterglow))));
}

/**
 * 闪击亮度通道：效果层写入、屏幕闪光与云体读取。
 *
 * 衰减由调用方按帧推进（`advance(deltaSeconds)`），暂停时不再调用，因此闪击会随回放冻结；
 * 这样多个读取方不必各自维护时间。
 */
export class LightningFlashChannel {
  private level = 0;

  /** 每秒衰减比例；闪击结束后约 1 秒回到零点。 */
  private readonly decayPerSecond = 1.6;

  /** 写入当前亮度；非有限值忽略，超出 0 到 1 按物理上限夹取。 */
  publish(level: number): void {
    if (!finiteNumber(level)) {
      return;
    }
    this.level = Math.min(Math.max(level, 0), 1);
  }

  /** 读取当前亮度，范围 0 到 1。 */
  read(): number {
    return this.level;
  }

  /** 按经过的秒数推进衰减；非正数或非有限值无副作用。 */
  advance(deltaSeconds: number): void {
    if (!finiteNumber(deltaSeconds) || deltaSeconds <= 0) {
      return;
    }
    this.level = Math.max(0, this.level - this.decayPerSecond * deltaSeconds);
  }

  /** 立即清零；移除效果时调用，避免残留亮度污染下一帧。 */
  reset(): void {
    this.level = 0;
  }
}

/** 一条闪电折线；主干一条，分支各自一条。 */
export interface LightningPath {
  /** `trunk` 是主干，`branch` 是分支。 */
  readonly kind: 'trunk' | 'branch';
  /** 经纬高序列，可直接交给折线图层渲染。 */
  readonly points: readonly GeoPosition[];
}

/** 闪电几何。 */
export interface LightningShape {
  /** 主干在前，分支其后。 */
  readonly paths: readonly LightningPath[];
  /** 本次使用的随机种子；记录下来即可复现同一次形状。 */
  readonly seed: number;
}

/** 闪电生成选项。 */
export interface LightningBoltOptions {
  /** 起点（云底）经纬高。 */
  readonly origin: GeoPosition;
  /**
   * 终点（落点）经纬高；省略时按 `lengthMeters` 与 `bearingDegrees` 从起点推算。
   *
   * 给出 `waypoints` 时它是最后一个途经点。
   */
  readonly target?: GeoPosition;
  /** 途经点，按顺序插在起点与终点之间。 */
  readonly waypoints?: readonly GeoPosition[];
  /** 未给 `target` 时的主干长度，单位为米，默认 3000。 */
  readonly lengthMeters?: number;
  /** 未给 `target` 时的主干方位角（度，0 为正北、顺时针），默认 0。 */
  readonly bearingDegrees?: number;
  /** 分支密度，默认 `'normal'`。 */
  readonly branches?: LightningBranchDensity;
  /** 随机种子，默认 1；同一组输入与种子得到同一条形状。 */
  readonly seed?: number;
  /** 主干顶点预算（含端点），默认 24；实际会按途经点段数分摊。 */
  readonly trunkVertices?: number;
  /** 分支顶点预算（每条分支），默认 8。 */
  readonly branchVertices?: number;
}

/** 局部 ENU 中的米制点。 */
interface LocalPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 段内抖动：首尾贴合端点，中段按正弦包络展开；幅度随段长自适应并夹在 40 到 320 米。 */
function segmentJitter(
  random: () => number,
  from: LocalPoint,
  to: LocalPoint,
  ratio: number,
): LocalPoint {
  const envelope = Math.sin(Math.PI * ratio);
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const amplitude =
    Math.min(JITTER_MAX_METERS, Math.max(JITTER_MIN_METERS, length * 0.06)) * envelope;
  return {
    x: (random() - 0.5) * amplitude,
    y: (random() - 0.5) * amplitude,
    z: (random() - 0.5) * amplitude * 0.6,
  };
}

/**
 * 生成一条闪电的几何：主干按途经点分段并在段内抖动，分支从主干随机节点向外散开。
 *
 * 全部计算在起点建立的局部 ENU 坐标系里完成，因此"向东 300 米、向北 200 米"这类形状
 * 与纬度无关；输出是经纬高序列，交给折线图层即可渲染。同一 `seed` 得到同一条形状，
 * 便于测试与问题复现。
 *
 * @throws `INVALID_SPATIAL_INPUT` 经纬度/高程不是有限数、`lengthMeters` 非正、
 * `trunkVertices` 小于 2，或起终点重合导致主干顶点不足。
 */
export function generateLightningBolt(options: LightningBoltOptions): LightningShape {
  const requested =
    (options as
      | {
          readonly origin?: GeoPosition;
          readonly target?: GeoPosition;
          readonly waypoints?: readonly GeoPosition[];
          readonly lengthMeters?: number;
          readonly bearingDegrees?: number;
          readonly branches?: LightningBranchDensity;
          readonly seed?: number;
          readonly trunkVertices?: number;
          readonly branchVertices?: number;
        }
      | undefined) ?? {};
  const origin = assertPosition(requested.origin, 'origin', 'generateLightningBolt');
  const seed = requested.seed ?? 1;
  if (!finiteNumber(seed)) {
    throw invalidLightning('Lightning seed must be a finite number.', 'generateLightningBolt');
  }
  const trunkVertices = requested.trunkVertices ?? 24;
  if (!Number.isSafeInteger(trunkVertices) || trunkVertices < 2) {
    throw invalidLightning(
      'Lightning trunkVertices must be an integer of at least 2.',
      'generateLightningBolt',
    );
  }
  const branchVertices = requested.branchVertices ?? 8;
  if (!Number.isSafeInteger(branchVertices) || branchVertices < 2) {
    throw invalidLightning(
      'Lightning branchVertices must be an integer of at least 2.',
      'generateLightningBolt',
    );
  }
  const density: LightningBranchDensity = requested.branches ?? 'normal';
  // 运行时（JS 调用方）可能传别的字符串：索引结果按可能为空处理。
  const profile = (
    BRANCH_PROFILES as Readonly<
      Record<string, { readonly ratio: number; readonly maxBranches: number } | undefined>
    >
  )[density];
  if (!profile) {
    throw invalidLightning(
      'Lightning branches must be "sparse", "normal", or "dense".',
      'generateLightningBolt',
    );
  }

  const frame = createLocalFrame(origin);
  const waypoints = (requested.waypoints ?? []).map((point, index) =>
    assertPosition(point, `waypoint ${String(index)}`, 'generateLightningBolt'),
  );

  let target: GeoPosition;
  if (requested.target === undefined) {
    const lengthMeters = requested.lengthMeters ?? 3_000;
    if (!finiteNumber(lengthMeters) || lengthMeters <= 0) {
      throw invalidLightning(
        'Lightning lengthMeters must be a positive finite number.',
        'generateLightningBolt',
      );
    }
    const bearingDegrees = requested.bearingDegrees ?? 0;
    if (!finiteNumber(bearingDegrees)) {
      throw invalidLightning(
        'Lightning bearingDegrees must be a finite number.',
        'generateLightningBolt',
      );
    }
    const bearing = (bearingDegrees * Math.PI) / 180;
    const height = origin.height ?? 0;
    target = frame.toGeographic({
      x: lengthMeters * Math.sin(bearing),
      y: lengthMeters * Math.cos(bearing),
      z: 0,
    });
    target = { longitude: target.longitude, latitude: target.latitude, height };
  } else {
    target = assertPosition(requested.target, 'target', 'generateLightningBolt');
  }

  const nodes: readonly GeoPosition[] = [origin, ...waypoints, target];
  const localNodes = nodes.map((node) => frame.toLocal(node));
  const segments = localNodes.length - 1;
  const random = createSeededRandom(seed);
  const trunk: LocalPoint[] = [];
  const budgetForTrunk = Math.max(4, Math.floor(trunkVertices * profile.ratio));
  const perSegment = Math.max(2, Math.floor(budgetForTrunk / segments));

  for (let segment = 0; segment < segments; segment += 1) {
    const from = localNodes[segment];
    const to = localNodes[segment + 1];
    if (!from || !to) {
      continue;
    }
    const steps = segment === segments - 1 ? perSegment : perSegment - 1;
    for (let step = 0; step <= steps; step += 1) {
      if (segment > 0 && step === 0) {
        // 段与段的连接点只保留一次。
        continue;
      }
      const ratio = steps === 0 ? 0 : step / steps;
      const jitter = segmentJitter(random, from, to, ratio);
      trunk.push({
        x: from.x + (to.x - from.x) * ratio + jitter.x,
        y: from.y + (to.y - from.y) * ratio + jitter.y,
        z: from.z + (to.z - from.z) * ratio + jitter.z,
      });
    }
  }

  if (trunk.length < 2) {
    throw invalidLightning(
      'Lightning trunk needs at least two vertices; check that origin and target differ.',
      'generateLightningBolt',
    );
  }

  const paths: LightningPath[] = [
    Object.freeze({
      kind: 'trunk' as const,
      points: Object.freeze(trunk.map((point) => frame.toGeographic(point))),
    }),
  ];

  const maxBranches = profile.maxBranches;
  for (let index = 0; index < maxBranches; index += 1) {
    const originIndex = Math.min(
      Math.floor(random() * (trunk.length - 1)),
      Math.max(0, trunk.length - 2),
    );
    const start = trunk[originIndex];
    const next = trunk[originIndex + 1];
    if (!start || !next) {
      continue;
    }
    const direction = { x: next.x - start.x, y: next.y - start.y, z: next.z - start.z };
    const points: LocalPoint[] = [start];
    for (let step = 1; step < branchVertices; step += 1) {
      const ratio = step / branchVertices;
      const spread = BRANCH_SPREAD_METERS * ratio * (0.4 + random());
      points.push({
        x: start.x + direction.x * ratio * 2.4 + (random() - 0.5) * spread,
        y: start.y + direction.y * ratio * 2.4 + (random() - 0.5) * spread,
        z: start.z + direction.z * ratio * 2.4 - ratio * BRANCH_DROP_METERS,
      });
    }
    paths.push(
      Object.freeze({
        kind: 'branch' as const,
        points: Object.freeze(points.map((point) => frame.toGeographic(point))),
      }),
    );
  }

  return Object.freeze({ paths: Object.freeze(paths), seed });
}
