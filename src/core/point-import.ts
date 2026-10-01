import { csvLimits, guessCsvPointColumns, parseCoordinateText, parseCsv } from './csv.js';
import type { CsvParseOptions, CsvRejectedRow } from './csv.js';
import { GisError } from './errors.js';
import { transformGeoPoint } from '../spatial/crs.js';

/** 判定"输入已经是 WGS84、不需要换算"的标识；比较时忽略大小写。 */
const WGS84_ALIASES = new Set(['WGS84', 'EPSG:4326']);

/** 投影坐标的量级上限（米）：够覆盖常见带号前缀坐标，又挡得住明显的脏值。 */
const PROJECTED_COORDINATE_LIMIT = 1e9;

function importError(message: string, operation: string): GisError {
  return new GisError(message, {
    code: 'INVALID_CSV_INPUT',
    module: 'import',
    operation,
  });
}

/** 点位表的列映射；经度与纬度必填，其余可选。 */
export interface PointImportColumnMapping {
  /** 经度列（投影坐标下是东坐标）。 */
  readonly longitude: string;
  /** 纬度列（投影坐标下是北坐标）。 */
  readonly latitude: string;
  /** 高程列，单位为米；省略时高程为 `undefined`。 */
  readonly height?: string;
  /** 标签列，用于点位图层的 `label`。 */
  readonly label?: string;
  /** 业务 id 列；省略时 `ImportedPoint.id` 为 `undefined`，由点位图层自行编号。 */
  readonly id?: string;
}

/** 导入计划的输入。 */
export interface PointImportOptions {
  /** CSV 文本；含 BOM 时按 BOM 处理，不当作列名的一部分。 */
  readonly text: string;
  /**
   * 列映射；省略或只给一部分时，缺的部分按列名猜测并标记 `preview.guessed`。
   *
   * 显式给出的列名不存在时**直接抛错**（`INVALID_CSV_INPUT`），不退回猜测——
   * 映射写错却静默换成别的列，比直接失败更难排查。
   */
  readonly columns?: Partial<PointImportColumnMapping>;
  /**
   * 输入坐标系标识，默认 `'WGS84'`（等价 `'EPSG:4326'`）。
   *
   * 其它值走 `transformGeoPoint` 换算到 WGS84，因此需要先 `registerCrs()` /
   * `registerChinaCrs()`（proj4 内置定义可直接用）。标识是否支持在计划阶段一次性判定，
   * 不支持时整体抛 `UNSUPPORTED_CRS`，而不是逐行拒绝。
   */
  readonly crs?: string;
  /** 预览点数上限，默认 50；`commit` 拿到的始终是全量。 */
  readonly previewLimit?: number;
  /** 拒绝行样本上限，默认沿用 CSV 解析的上限。 */
  readonly maxErrorSamples?: number;
  /** 透传给 CSV 解析的行数 / 列数 / 字段长度上限。 */
  readonly parseOptions?: CsvParseOptions;
}

/** 导入后的点位，坐标已换算到 WGS84。 */
export interface ImportedPoint {
  /** 业务 id 列的值；没有该列时为 `undefined`。 */
  readonly id: string | undefined;
  /** 经度，单位为度。 */
  readonly longitude: number;
  /** 纬度，单位为度。 */
  readonly latitude: number;
  /** 高程，单位为米；没有该列或该行为空时为 `undefined`。 */
  readonly height: number | undefined;
  /** 标签列的值；没有该列或该行为空时为 `undefined`。 */
  readonly label: string | undefined;
  /** 来源行号（含表头，从 1 起），便于业务回查原始文件。 */
  readonly line: number;
}

/** 导入预览：够业务展示"将导入什么、跳过了什么"。 */
export interface PointImportPreview {
  /** 实际使用的列映射（显式给出与猜测合并后的结果）。 */
  readonly columns: PointImportColumnMapping;
  /** 映射是否来自猜测（只要有列是猜的就为 `true`）。 */
  readonly guessed: boolean;
  /** 归一化后的输入坐标系标识；已是 WGS84 时原样保留标识。 */
  readonly crs: string;
  /** 数据行总数（不含表头与结构上被拒绝的行）。 */
  readonly totalRows: number;
  /** 成功换算并落在 WGS84 范围内的点数。 */
  readonly acceptedCount: number;
  /** 被拒绝的行数，可能大于 `rejected` 的样本数。 */
  readonly rejectedCount: number;
  /** 预览点位：**前** `previewLimit` 条，顺序与文件一致。 */
  readonly points: readonly ImportedPoint[];
  /** 拒绝行样本（结构与坐标两类），上限见 `maxErrorSamples`。 */
  readonly rejected: readonly CsvRejectedRow[];
  /** 给人看的提示：映射来自猜测、做过坐标换算、有行被拒等。 */
  readonly issues: readonly string[];
}

/** 导入计划：预览 + 全量点位。 */
export interface PointImportPlan {
  /** 预览与统计。 */
  readonly preview: PointImportPreview;
  /**
   * 全部可用点位，顺序与文件一致。
   *
   * 计划是纯数据：取消导入就是丢弃它，不需要释放资源；落图层由业务决定
   * （通常是 `map.layers.add({ type: 'points', points: plan.points })`）。
   */
  readonly points: readonly ImportedPoint[];
}

function normalizePreviewLimit(value: unknown): number {
  if (value === undefined) {
    return 50;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw importError('Import previewLimit must be a positive safe integer.', 'planPointImport');
  }
  return value;
}

/** 列名定位：显式给出的列必须在表头里，猜测出来的列已经在表头里。 */
function resolveColumn(
  columns: readonly string[],
  explicit: string | undefined,
  guessed: string | undefined,
  role: string,
  guessedAny: { value: boolean },
): string | undefined {
  if (explicit !== undefined) {
    if (!columns.includes(explicit)) {
      throw importError(
        `CSV is missing the ${role} column "${explicit}". Available columns: ${columns.join(', ')}.`,
        'planPointImport',
      );
    }
    return explicit;
  }
  if (guessed !== undefined) {
    guessedAny.value = true;
  }
  return guessed;
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') {
    return undefined;
  }
  return trimmed;
}

/**
 * 生成一份点位导入计划：解析 CSV、确定列映射、按需换算坐标系，并给出预览与拒绝样本。
 *
 * 与 `readPointCsv()` 的分工：`readPointCsv` 是"列映射已知、只要坐标"的最小读取；本函数
 * 面向导入流程，多做三件事——列名猜不出来时给出映射并标记、把投影坐标换算到 WGS84、
 * 汇总成可直接展示的预览。两者都只产出数据，不碰图层。
 *
 * @throws `INVALID_CSV_INPUT` 经纬度列缺失或显式列名不存在、预览上限非法。
 * @throws `UNSUPPORTED_CRS` 输入坐标系未注册且 proj4 也不认识。
 */
export function planPointImport(options: PointImportOptions): PointImportPlan {
  const requested =
    (options as
      | {
          readonly text?: unknown;
          readonly columns?: Partial<PointImportColumnMapping>;
          readonly crs?: unknown;
          readonly previewLimit?: unknown;
          readonly maxErrorSamples?: unknown;
          readonly parseOptions?: CsvParseOptions;
        }
      | undefined) ?? {};
  const rawText = requested.text;
  const table = parseCsv(typeof rawText === 'string' ? rawText : '', requested.parseOptions ?? {});
  const previewLimit = normalizePreviewLimit(requested.previewLimit);
  const rawMaxErrorSamples = requested.maxErrorSamples;
  const maxErrorSamples =
    typeof rawMaxErrorSamples === 'number' &&
    Number.isSafeInteger(rawMaxErrorSamples) &&
    rawMaxErrorSamples >= 0
      ? rawMaxErrorSamples
      : csvLimits.maxErrorSamples;

  const guess = guessCsvPointColumns(table.columns);
  const guessedAny = { value: false };
  const columns = requested.columns ?? {};
  const longitudeColumn = resolveColumn(
    table.columns,
    columns.longitude,
    guess.longitude,
    'longitude',
    guessedAny,
  );
  const latitudeColumn = resolveColumn(
    table.columns,
    columns.latitude,
    guess.latitude,
    'latitude',
    guessedAny,
  );
  if (longitudeColumn === undefined || latitudeColumn === undefined) {
    throw importError(
      `CSV needs longitude and latitude columns. Available columns: ${table.columns.join(', ')}.`,
      'planPointImport',
    );
  }
  const heightColumn = resolveColumn(
    table.columns,
    columns.height,
    undefined,
    'height',
    guessedAny,
  );
  const labelColumn = resolveColumn(table.columns, columns.label, undefined, 'label', guessedAny);
  const idColumn = resolveColumn(table.columns, columns.id, undefined, 'id', guessedAny);

  const crs = (typeof requested.crs === 'string' ? text(requested.crs) : undefined) ?? 'WGS84';
  const geographic = WGS84_ALIASES.has(crs.toUpperCase());
  if (!geographic) {
    // 坐标系是否支持是配置问题：在这里一次性判定，避免逐行拒绝。
    transformGeoPoint({ longitude: 0, latitude: 0 }, crs, 'WGS84');
  }

  const indexOf = (column: string | undefined): number =>
    column === undefined ? -1 : table.columns.indexOf(column);
  const longitudeIndex = indexOf(longitudeColumn);
  const latitudeIndex = indexOf(latitudeColumn);
  const heightIndex = indexOf(heightColumn);
  const labelIndex = indexOf(labelColumn);
  const idIndex = indexOf(idColumn);

  const totalRows = table.rows.length;
  const rejected: CsvRejectedRow[] = [...table.rejected];
  let rejectedCount = table.rejectedCount;
  const points: ImportedPoint[] = [];

  const reject = (line: number, reason: string): void => {
    rejectedCount += 1;
    if (rejected.length < maxErrorSamples) {
      rejected.push({ line, reason });
    }
  };

  table.rows.forEach((row, index) => {
    const line = index + 2;
    const read = (columnIndex: number): string | undefined =>
      columnIndex < 0 ? undefined : row[columnIndex];
    const rawLongitude = read(longitudeIndex);
    const rawLatitude = read(latitudeIndex);
    const inputLimit = geographic ? 180 : PROJECTED_COORDINATE_LIMIT;
    const inputLatitudeLimit = geographic ? 90 : PROJECTED_COORDINATE_LIMIT;
    const longitude = parseCoordinateText(rawLongitude ?? '', -inputLimit, inputLimit);
    const latitude = parseCoordinateText(
      rawLatitude ?? '',
      -inputLatitudeLimit,
      inputLatitudeLimit,
    );
    if (longitude === undefined || latitude === undefined) {
      reject(
        line,
        geographic
          ? 'Longitude or latitude is not a valid WGS84 degree value.'
          : 'Longitude or latitude is not a finite projected coordinate.',
      );
      return;
    }

    let converted: { readonly longitude: number; readonly latitude: number };
    if (geographic) {
      converted = { longitude, latitude };
    } else {
      try {
        converted = transformGeoPoint({ longitude, latitude }, crs, 'WGS84');
      } catch {
        reject(line, `Coordinate could not be converted from ${crs} to WGS84.`);
        return;
      }
    }
    if (
      converted.longitude < -180 ||
      converted.longitude > 180 ||
      converted.latitude < -90 ||
      converted.latitude > 90
    ) {
      reject(line, 'Converted coordinate falls outside the WGS84 range.');
      return;
    }

    let height: number | undefined;
    const rawHeight = read(heightIndex);
    if (rawHeight !== undefined) {
      const trimmedHeight = rawHeight.trim();
      if (trimmedHeight !== '') {
        const parsedHeight = Number(trimmedHeight);
        if (!Number.isFinite(parsedHeight)) {
          reject(line, 'Height is not a finite number.');
          return;
        }
        height = parsedHeight;
      }
    }

    points.push({
      id: text(read(idIndex)),
      longitude: converted.longitude,
      latitude: converted.latitude,
      height,
      label: text(read(labelIndex)),
      line,
    });
  });

  const issues: string[] = [];
  if (guessedAny.value) {
    issues.push(
      `列映射来自猜测：经度 → "${longitudeColumn}"、纬度 → "${latitudeColumn}"${
        heightColumn === undefined ? '' : `、高程 → "${heightColumn}"`
      }。确认无误后再提交，或显式传 columns 覆盖。`,
    );
  }
  if (!geographic) {
    issues.push(`坐标已从 ${crs} 换算到 WGS84；高程不参与投影换算，按原值保留。`);
  }
  if (rejectedCount > 0) {
    issues.push(`有 ${String(rejectedCount)} 行被拒绝，样本见 rejected。`);
  }

  const preview: PointImportPreview = Object.freeze({
    columns: Object.freeze({
      longitude: longitudeColumn,
      latitude: latitudeColumn,
      ...(heightColumn === undefined ? {} : { height: heightColumn }),
      ...(labelColumn === undefined ? {} : { label: labelColumn }),
      ...(idColumn === undefined ? {} : { id: idColumn }),
    }),
    guessed: guessedAny.value,
    crs,
    totalRows,
    acceptedCount: points.length,
    rejectedCount,
    points: Object.freeze(points.slice(0, previewLimit)),
    rejected: Object.freeze(rejected),
    issues: Object.freeze(issues),
  });

  return Object.freeze({ preview, points: Object.freeze(points) });
}
