import proj4 from 'proj4';

import type { GeoPoint, GeoRing } from './types.js';
import { finite, spatialError } from './types.js';

/** 已注册 CRS 的只读描述。 */
export interface CrsDescriptor {
  /** CRS 标识，例如 `EPSG:4490` 或 `CGCS2000-GK-3D-CM117E`。 */
  readonly code: string;
  /** 坐标类型：地理坐标（经纬度）或投影坐标（平面米）。 */
  readonly kind: 'geographic' | 'projected' | 'unknown';
  /** 单位；地理坐标通常为 `degree`，投影坐标通常为 `m`。 */
  readonly units: string;
  /** 椭球名，例如 `GRS80`。 */
  readonly ellipsoid: string | undefined;
  /** 中央经线，单位为度；仅投影坐标有值。 */
  readonly centralMeridian: number | undefined;
  /** 高斯带号；仅通过 `registerChinaCrs` 注册时有值。 */
  readonly zone: number | undefined;
  /** 高斯带宽度，单位为度；仅通过 `registerChinaCrs` 注册时有值。 */
  readonly zoneWidth: 3 | 6 | undefined;
  /** 东坐标是否带带号前缀（`x_0 = 带号 × 1000000 + 500000`）。 */
  readonly zonePrefix: boolean | undefined;
}

/** 注册 CRS 的选项。 */
export interface RegisterCrsOptions {
  /**
   * 是否覆盖同 code 的既有定义。
   *
   * 默认 `false`：重复注册会抛 `INVALID_CRS_DEFINITION`，避免同一标识在同一进程内指向两套定义。
   */
  readonly overwrite?: boolean;
  /** 补充或覆盖描述信息；`code` 由第一个参数决定，不能被覆盖。 */
  readonly descriptor?: Partial<Omit<CrsDescriptor, 'code'>>;
}

/** CGCS2000 高斯带的带号与可选标识。 */
export interface ChinaGaussZone {
  /** 带号；3 度带为 25–45，6 度带为 13–23。 */
  readonly zone: number;
  /**
   * 写入注册表的 CRS 标识；省略时按 SDK 约定生成。
   *
   * SDK **不校验**该标识与 EPSG 注册表的对应关系：需要 EPSG 号时请先核对中央经线、
   * `x_0` 与单位，再传入核对过的号。
   */
  readonly code?: string;
}

/** `registerChinaCrs` 的选项。 */
export interface RegisterChinaCrsOptions {
  /** 需要注册的带号；不预设全集，由调用方显式指定。 */
  readonly zones: readonly (number | ChinaGaussZone)[];
  /** 带宽度，单位为度，默认 3。 */
  readonly zoneWidth?: 3 | 6;
  /**
   * 东坐标是否带带号前缀，默认 `false`。
   *
   * `false` 时 `x_0 = 500000`；`true` 时 `x_0 = 带号 × 1000000 + 500000`。
   */
  readonly withZonePrefix?: boolean;
  /** 是否同时注册 CGCS2000 地理坐标（`EPSG:4490`），默认 `true`。 */
  readonly registerGeographic?: boolean;
}

/** 3 度带的合法带号范围（中央经线 75°E–135°E）。 */
const GAUSS_3D_ZONES = { min: 25, max: 45 } as const;

/** 6 度带的合法带号范围（中央经线 75°E–135°E）。 */
const GAUSS_6D_ZONES = { min: 13, max: 23 } as const;

const registry = new Map<string, CrsDescriptor>();

function normalizeCode(code: unknown, operation: string): string {
  const normalized = typeof code === 'string' ? code.trim() : '';
  if (!normalized) {
    throw spatialError('CRS code must be a non-empty string.', 'INVALID_CRS_DEFINITION', operation);
  }
  return normalized;
}

function requireCode(code: unknown, operation: string): string {
  const normalized = typeof code === 'string' ? code.trim() : '';
  if (!normalized) {
    throw spatialError('CRS code must be a non-empty string.', 'UNSUPPORTED_CRS', operation);
  }
  return normalized;
}

/** 从 proj4 字符串中解析可读参数；WKT 定义解析不出这些字段。 */
function parseProjString(definition: string): {
  kind: CrsDescriptor['kind'];
  units: string;
  ellipsoid: string | undefined;
  centralMeridian: number | undefined;
} {
  const parameters = new Map<string, string>();
  for (const token of definition.trim().split(/\s+/u)) {
    if (!token.startsWith('+')) {
      continue;
    }
    const [key, value] = token.slice(1).split('=');
    if (key) {
      parameters.set(key, value ?? 'true');
    }
  }
  const projection = parameters.get('proj');
  const kind: CrsDescriptor['kind'] =
    projection === undefined
      ? 'unknown'
      : projection === 'longlat' || projection === 'latlong'
        ? 'geographic'
        : 'projected';
  const centralMeridian = Number(parameters.get('lon_0'));
  return {
    kind,
    units: parameters.get('units') ?? (kind === 'geographic' ? 'degree' : 'unknown'),
    ellipsoid: parameters.get('ellps') ?? parameters.get('datum'),
    centralMeridian: Number.isFinite(centralMeridian) ? centralMeridian : undefined,
  };
}

function descriptorOf(
  code: string,
  definition: string,
  extra: Partial<Omit<CrsDescriptor, 'code'>> = {},
): CrsDescriptor {
  const parsed = definition.trim().startsWith('+')
    ? parseProjString(definition)
    : {
        kind: 'unknown' as const,
        units: 'unknown',
        ellipsoid: undefined,
        centralMeridian: undefined,
      };
  return Object.freeze({
    code,
    kind: extra.kind ?? parsed.kind,
    units: extra.units ?? parsed.units,
    ellipsoid: extra.ellipsoid ?? parsed.ellipsoid,
    centralMeridian: extra.centralMeridian ?? parsed.centralMeridian,
    zone: extra.zone ?? undefined,
    zoneWidth: extra.zoneWidth ?? undefined,
    zonePrefix: extra.zonePrefix ?? undefined,
  });
}

function isSupported(code: string): boolean {
  if (registry.has(code)) {
    return true;
  }
  try {
    // proj4 的类型声明认为任何字符串都有定义，运行时才可能返回空，因此按未知值判断。
    const definition: unknown = (proj4.defs as (value: string) => unknown)(code);
    return definition !== undefined;
  } catch {
    return false;
  }
}

function requireSupported(code: unknown, operation: string): string {
  const normalized = requireCode(code, operation);
  if (!isSupported(normalized)) {
    throw spatialError(
      `CRS "${normalized}" is not registered. Register it with registerCrs() or registerChinaCrs() first.`,
      'UNSUPPORTED_CRS',
      operation,
    );
  }
  return normalized;
}

/** 读取一个待转换的点；地理坐标按经纬度范围校验，投影坐标只要求有限数。 */
function readPoint(
  point: unknown,
  descriptor: CrsDescriptor | undefined,
  operation: string,
): [number, number] {
  const { longitude, latitude } = (point ?? {}) as Partial<GeoPoint>;
  if (!finite(longitude) || !finite(latitude)) {
    throw spatialError(
      'Point must contain finite longitude and latitude.',
      'INVALID_COORDINATES',
      operation,
    );
  }
  if (
    descriptor?.kind === 'geographic' &&
    (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)
  ) {
    throw spatialError(
      'Geographic point is outside the WGS84 degree range.',
      'INVALID_COORDINATES',
      operation,
    );
  }
  return [longitude, latitude];
}

function convert(
  coordinates: [number, number],
  from: string,
  to: string,
  operation: string,
): [number, number] {
  try {
    const result = proj4(from, to, coordinates);
    if (!finite(result[0]) || !finite(result[1])) {
      throw spatialError(
        `CRS transform from "${from}" to "${to}" produced a non-finite result.`,
        'INVALID_COORDINATES',
        operation,
      );
    }
    return result;
  } catch (cause: unknown) {
    if (cause instanceof Error && cause.name === 'GisError') {
      throw cause;
    }
    throw spatialError(
      `CRS transform from "${from}" to "${to}" failed.`,
      'UNSUPPORTED_CRS',
      operation,
      cause,
    );
  }
}

/**
 * 注册一条 CRS。
 *
 * 定义可以是 proj4 字符串或 WKT；从 proj4 字符串中可以解析出坐标类型、单位、
 * 椭球与中央经线，WKT 只登记标识（描述字段为 `unknown`）。
 *
 * @param code - CRS 标识，必须非空。
 * @param definition - proj4 字符串或 WKT 定义。
 * @param options - 覆盖与描述补充；重复注册默认抛错。
 * @returns 注册后的只读描述。
 * @throws `INVALID_CRS_DEFINITION` 标识为空、定义为空、重复注册或解析失败。
 */
export function registerCrs(
  code: string,
  definition: string,
  options: RegisterCrsOptions = {},
): CrsDescriptor {
  const operation = 'registerCrs';
  const normalizedCode = normalizeCode(code, operation);
  const normalizedDefinition = typeof definition === 'string' ? definition.trim() : '';
  if (!normalizedDefinition) {
    throw spatialError(
      `CRS "${normalizedCode}" requires a non-empty proj4 string or WKT definition.`,
      'INVALID_CRS_DEFINITION',
      operation,
    );
  }
  if (registry.has(normalizedCode) && options.overwrite !== true) {
    throw spatialError(
      `CRS "${normalizedCode}" is already registered. Pass { overwrite: true } to replace it.`,
      'INVALID_CRS_DEFINITION',
      operation,
    );
  }

  try {
    proj4.defs(normalizedCode, normalizedDefinition);
  } catch (cause: unknown) {
    throw spatialError(
      `CRS "${normalizedCode}" definition could not be parsed.`,
      'INVALID_CRS_DEFINITION',
      operation,
      cause,
    );
  }

  const descriptor = descriptorOf(normalizedCode, normalizedDefinition, options.descriptor ?? {});
  registry.set(normalizedCode, descriptor);
  return descriptor;
}

function zoneRange(zoneWidth: 3 | 6): { min: number; max: number } {
  return zoneWidth === 3 ? GAUSS_3D_ZONES : GAUSS_6D_ZONES;
}

/**
 * 中央经线：3 度带为 `3n`，6 度带为 `6n − 3`（n 为带号）。
 * @internal
 */
export function centralMeridianOf(zone: number, zoneWidth: 3 | 6): number {
  return zoneWidth === 3 ? 3 * zone : 6 * zone - 3;
}

/**
 * 注册 CGCS2000 地理坐标与指定带号的高斯投影带。
 *
 * **带号与中央经线按公式计算、并校验在 75°E–135°E 的合法带号范围内**，不预设全集：
 * 只注册调用方点名要用的带号。SDK 不校验自定义标识与 EPSG 号段的对应关系，
 * 需要 EPSG 号时请先核对中央经线、`x_0` 与单位。
 *
 * ```ts
 * const [gk117] = registerChinaCrs({ zones: [39] }); // 3 度带 39 号 → 中央经线 117°E
 * ```
 *
 * @param options - 带号列表与带参数；`zones` 不可为空。
 * @returns 本次注册（含按需注册的地理坐标）的只读描述列表。
 * @throws `INVALID_CRS_DEFINITION` 带号为空、越界、重复注册或标识冲突。
 */
export function registerChinaCrs(options: RegisterChinaCrsOptions): readonly CrsDescriptor[] {
  const operation = 'registerChinaCrs';
  // 类型上只允许 3 或 6，运行时（JS 调用方）仍可能传入其它值，因此按宽类型校验。
  const requestedWidth: unknown = options.zoneWidth ?? 3;
  if (requestedWidth !== 3 && requestedWidth !== 6) {
    throw spatialError(
      'China Gauss zone width must be 3 or 6 degrees.',
      'INVALID_CRS_DEFINITION',
      operation,
    );
  }
  const zoneWidth: 3 | 6 = requestedWidth;
  const withZonePrefix = options.withZonePrefix ?? false;
  const zones: unknown = options.zones;
  if (!Array.isArray(zones) || zones.length === 0) {
    throw spatialError(
      'registerChinaCrs requires an explicit, non-empty zones list.',
      'INVALID_CRS_DEFINITION',
      operation,
    );
  }

  const registered: CrsDescriptor[] = [];
  if (options.registerGeographic !== false) {
    registered.push(registerGeographicCgcs2000());
  }

  const { min, max } = zoneRange(zoneWidth);
  for (const entry of zones as readonly (number | ChinaGaussZone)[]) {
    const zone = typeof entry === 'number' ? entry : entry.zone;
    if (!Number.isInteger(zone)) {
      throw spatialError(
        'China Gauss zone numbers must be integers.',
        'INVALID_CRS_DEFINITION',
        operation,
      );
    }
    if (zone < min || zone > max) {
      throw spatialError(
        `China Gauss ${String(zoneWidth)}-degree zone ${String(zone)} is outside the supported ${String(min)}-${String(max)} range (central meridian 75E-135E).`,
        'INVALID_CRS_DEFINITION',
        operation,
      );
    }
    const centralMeridian = centralMeridianOf(zone, zoneWidth);
    const preferredCode = typeof entry === 'number' ? undefined : entry.code;
    const code =
      preferredCode ??
      (withZonePrefix
        ? `CGCS2000-GK-${String(zoneWidth)}D-Z${String(zone)}`
        : `CGCS2000-GK-${String(zoneWidth)}D-CM${String(centralMeridian)}E`);
    const x0 = withZonePrefix ? zone * 1_000_000 + 500_000 : 500_000;
    registered.push(
      registerCrs(
        code,
        `+proj=tmerc +lat_0=0 +lon_0=${String(centralMeridian)} +k=1 +x_0=${String(x0)} +y_0=0 +ellps=GRS80 +units=m +no_defs`,
        {
          descriptor: {
            kind: 'projected',
            units: 'm',
            ellipsoid: 'GRS80',
            centralMeridian,
            zone,
            zoneWidth,
            zonePrefix: withZonePrefix,
          },
        },
      ),
    );
  }

  return Object.freeze(registered);
}

function registerGeographicCgcs2000(): CrsDescriptor {
  const code = 'EPSG:4490';
  const existing = registry.get(code);
  if (existing) {
    return existing;
  }
  return registerCrs(code, '+proj=longlat +ellps=GRS80 +no_defs', {
    descriptor: { kind: 'geographic', units: 'degree', ellipsoid: 'GRS80' },
  });
}

/**
 * 列出经本 SDK 注册的 CRS。
 *
 * proj4 自带的内置定义（`WGS84`、`EPSG:4326`、`EPSG:3857` 等）不在列表中，但可直接用于转换。
 */
export function listCrs(): readonly CrsDescriptor[] {
  return Object.freeze([...registry.values()]);
}

/** 返回已注册 CRS 的描述；未注册时返回 `undefined`。 */
export function describeCrs(code: string): CrsDescriptor | undefined {
  return registry.get(requireCode(code, 'describeCrs'));
}

/**
 * 在两组 CRS 之间转换一个点。
 *
 * 输入输出的 `longitude` / `latitude` 按各自 CRS 的含义解释：地理坐标下是经纬度（度），
 * 投影坐标下是东坐标与北坐标（米）。转换结果不做经纬度范围断言——超出 ±180 / ±90
 * 说明输入不在目标 CRS 的适用范围内，由调用方判断。
 *
 * @param point - 待转换点。
 * @param from - 源 CRS 标识。
 * @param to - 目标 CRS 标识。
 * @returns 转换后的点。
 * @throws `UNSUPPORTED_CRS` 源或目标 CRS 未注册；`INVALID_COORDINATES` 坐标非法。
 */
export function transformGeoPoint(point: GeoPoint, from: string, to: string): GeoPoint {
  const operation = 'transformGeoPoint';
  const source = requireSupported(from, operation);
  const target = requireSupported(to, operation);
  const [x, y] = convert(
    readPoint(point, registry.get(source), operation),
    source,
    target,
    operation,
  );
  return { longitude: x, latitude: y };
}

function transformVertices(
  vertices: unknown,
  from: string,
  to: string,
  operation: string,
  name: string,
): GeoPoint[] {
  if (!Array.isArray(vertices)) {
    throw spatialError(`${name} must be an array of points.`, 'INVALID_SPATIAL_INPUT', operation);
  }
  const source = requireSupported(from, operation);
  const target = requireSupported(to, operation);
  const descriptor = registry.get(source);
  return vertices.map((vertex, index) => {
    const [x, y] = convert(
      readPoint(vertex, descriptor, `${operation}[${String(index)}]`),
      source,
      target,
      operation,
    );
    return { longitude: x, latitude: y };
  });
}

/**
 * 批量转换顶点序列（导入预览用）。
 *
 * @param points - 待转换的顶点序列。
 * @param from - 源 CRS 标识。
 * @param to - 目标 CRS 标识。
 * @returns 转换后的顶点序列，顺序与输入一致。
 * @throws `UNSUPPORTED_CRS`、`INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`（非数组）。
 */
export function transformGeoPath(
  points: readonly GeoPoint[],
  from: string,
  to: string,
): GeoPoint[] {
  return transformVertices(points, from, to, 'transformGeoPath', 'Spatial path');
}

/**
 * 转换一个环；与 `transformGeoPath` 的差别只在语义与命名。
 *
 * @param ring - 待转换的顶点环。
 * @param from - 源 CRS 标识。
 * @param to - 目标 CRS 标识。
 * @returns 转换后的顶点环，顺序与输入一致。
 * @throws `UNSUPPORTED_CRS`、`INVALID_COORDINATES`、`INVALID_SPATIAL_INPUT`（非数组）。
 */
export function transformGeoRing(ring: GeoRing, from: string, to: string): GeoPoint[] {
  return transformVertices(ring, from, to, 'transformGeoRing', 'Spatial ring');
}
