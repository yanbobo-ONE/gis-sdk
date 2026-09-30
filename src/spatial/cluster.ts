import type { GeoBBox, GeoPoint } from './types.js';
import { MAX_BATCH_POINTS, spatialError } from './types.js';

/** 一个聚合簇。 */
export interface PointCluster<T> {
  /**
   * 稳定的网格键（`行:列`）。
   *
   * 同一批数据在同样参数下重复聚合时键不变，可以直接用它当渲染对象的 id；
   * 数据变化后同一位置的簇仍是同一个键。
   */
  readonly id: string;
  /** 簇中心：成员位置的均值（经度按最短弧处理）。 */
  readonly center: GeoPoint;
  /** 成员数量。 */
  readonly count: number;
  /** 成员原始数据，顺序与输入一致。 */
  readonly members: readonly T[];
  /** 成员的经纬包围盒。 */
  readonly bounds: GeoBBox;
}

/** 聚合参数。 */
export interface ClusterOptions<T> {
  /** 网格边长，单位为米；必须为正。 */
  readonly cellSizeMeters: number;
  /** 从元素取位置；省略时元素本身要是 `GeoPoint`。 */
  readonly positionOf?: (item: T) => GeoPoint;
  /** 只返回成员数不少于该值的簇，默认 1（全部保留）；用于"少于 N 个不聚合"的渲染策略。 */
  readonly minCount?: number;
}

/** 一度的纬度对应的米数（球面近似，与 SDK 的球面算法一致）。 */
const METERS_PER_DEGREE_LATITUDE = (2 * Math.PI * 6_371_008.8) / 360;

/** 运行期数组判断；单独写一层是为了不让 `Array.isArray` 把类型塌成 `any[]`。 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function invalidInput(message: string, operation: string): Error {
  return spatialError(message, 'INVALID_SPATIAL_INPUT', operation);
}

/** 把经度按最短弧映射到连续值，跨 180° 经线时不会跳到另一侧。 */
function unwrapLongitude(reference: number, longitude: number): number {
  const delta = ((longitude - reference + 540) % 360) - 180;
  return reference + delta;
}

/** 把经度归一化到 (-180, 180]。 */
function wrapLongitude(longitude: number): number {
  const wrapped = ((longitude % 360) + 540) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * 纯计算的点聚合：按**米制网格**把点分组，返回每簇的中心、计数、成员与包围盒。
 *
 * 只做分组，不做渲染：业务可以把簇当成一个点交给点位图层（用 `count` 决定大小），
 * 也可以把少于阈值的簇展开成原始点——"什么时候展开、怎么画"是渲染策略，SDK 不替业务决定。
 *
 * 网格边长按米给：先按参考纬度换算成经纬步长，因此同样的 `cellSizeMeters` 在不同纬度
 * 覆盖的地面面积一致，不会出现高纬度被过度聚合。经度用连续值参与计算，跨 180° 经线的数据
 * 不会因为绕圈被错误拆成两簇。
 *
 * @param items - 待聚合的元素。
 * @param options - 网格边长（米）、位置取值函数与最小簇规模。
 * @returns 聚合结果，按网格行列排序（从南到北、从西到东），同一批数据输出顺序稳定。
 * @throws `INVALID_SPATIAL_INPUT` 边长非法、坐标非法或点数超过上限。
 */
export function clusterPoints<T>(items: readonly T[], options: ClusterOptions<T>): readonly PointCluster<T>[] {
  const operation = 'clusterPoints';
  const rawItems: unknown = items;
  if (!isUnknownArray(rawItems)) {
    throw invalidInput('clusterPoints requires an array of items.', operation);
  }
  if (items.length > MAX_BATCH_POINTS) {
    throw invalidInput(
      `clusterPoints accepts at most ${String(MAX_BATCH_POINTS)} items.`,
      operation,
    );
  }
  const candidate: unknown = options;
  const cellSizeMeters = (candidate as Partial<ClusterOptions<T>> | undefined)?.cellSizeMeters;
  if (typeof cellSizeMeters !== 'number' || !Number.isFinite(cellSizeMeters) || cellSizeMeters <= 0) {
    throw invalidInput('clusterPoints cellSizeMeters must be a positive finite number.', operation);
  }
  const minCount = (candidate as Partial<ClusterOptions<T>>).minCount ?? 1;
  if (!Number.isInteger(minCount) || minCount < 1) {
    throw invalidInput('clusterPoints minCount must be a positive integer.', operation);
  }
  const positionOf =
    (candidate as Partial<ClusterOptions<T>>).positionOf ??
    ((item: T) => item as unknown as GeoPoint);

  const cells = new Map<
    string,
    {
      row: number;
      column: number;
      count: number;
      sumLongitude: number;
      sumLatitude: number;
      minLongitude: number;
      maxLongitude: number;
      minLatitude: number;
      maxLatitude: number;
      members: T[];
    }
  >();

  let referenceLongitude: number | undefined;
  for (const item of items) {
    const position: unknown = positionOf(item);
    const { longitude, latitude } = (position ?? {}) as Partial<GeoPoint>;
    if (
      typeof longitude !== 'number' ||
      typeof latitude !== 'number' ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    ) {
      throw invalidInput('clusterPoints requires finite WGS84 coordinates.', operation);
    }
    // 第一个点定义参考系，后续点都相对它展开经度。
    referenceLongitude ??= longitude;
    const unwrapped = unwrapLongitude(referenceLongitude, longitude);
    const metersPerDegreeLongitude =
      METERS_PER_DEGREE_LATITUDE * Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
    const column = Math.floor((unwrapped * metersPerDegreeLongitude) / cellSizeMeters);
    const row = Math.floor((latitude * METERS_PER_DEGREE_LATITUDE) / cellSizeMeters);
    const key = `${String(row)}:${String(column)}`;
    const existing = cells.get(key);
    if (existing) {
      existing.count += 1;
      existing.sumLongitude += unwrapped;
      existing.sumLatitude += latitude;
      existing.minLongitude = Math.min(existing.minLongitude, unwrapped);
      existing.maxLongitude = Math.max(existing.maxLongitude, unwrapped);
      existing.minLatitude = Math.min(existing.minLatitude, latitude);
      existing.maxLatitude = Math.max(existing.maxLatitude, latitude);
      existing.members.push(item);
      continue;
    }
    cells.set(key, {
      row,
      column,
      count: 1,
      sumLongitude: unwrapped,
      sumLatitude: latitude,
      minLongitude: unwrapped,
      maxLongitude: unwrapped,
      minLatitude: latitude,
      maxLatitude: latitude,
      members: [item],
    });
  }

  // 按网格行列排序，保证同一批数据的输出顺序稳定（从南到北、从西到东）。
  const ordered = [...cells.entries()].sort(
    (left, right) => left[1].row - right[1].row || left[1].column - right[1].column,
  );
  const clusters: PointCluster<T>[] = [];
  for (const [id, cell] of ordered) {
    if (cell.count < minCount) {
      continue;
    }
    clusters.push({
      id,
      center: {
        longitude: wrapLongitude(cell.sumLongitude / cell.count),
        latitude: cell.sumLatitude / cell.count,
      },
      count: cell.count,
      members: cell.members,
      bounds: {
        west: wrapLongitude(cell.minLongitude),
        east: wrapLongitude(cell.maxLongitude),
        south: cell.minLatitude,
        north: cell.maxLatitude,
      },
    });
  }
  return clusters;
}
