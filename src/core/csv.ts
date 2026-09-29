import { GisError } from './errors.js';

/** CSV 解析的实验上限；每一项都可以在调用时覆盖。 */
export const csvLimits = Object.freeze({
  /** 文本字节上限。 */
  maxBytes: 10 * 1024 * 1024,
  /** 数据行上限（不含表头）。 */
  maxRows: 50_000,
  /** 列数上限。 */
  maxColumns: 64,
  /** 单字段字节上限。 */
  maxFieldBytes: 16 * 1024,
  /** 拒绝行样本上限。 */
  maxErrorSamples: 200,
});

/** CSV 解析的可覆盖上限。 */
export interface CsvParseOptions {
  /** 数据行上限，默认 50000。 */
  readonly maxRows?: number;
  /** 列数上限，默认 64。 */
  readonly maxColumns?: number;
  /** 单字段字节上限，默认 16KB。 */
  readonly maxFieldBytes?: number;
  /** 拒绝行样本上限，默认 200。 */
  readonly maxErrorSamples?: number;
}

/** 被拒绝的行；行号为 1 起的物理行号。 */
export interface CsvRejectedRow {
  /** 物理行号。 */
  readonly line: number;
  /** 拒绝原因。 */
  readonly reason: string;
}

/** CSV 解析结果。 */
export interface CsvTable {
  /** 表头字段名（去 BOM、去首尾空白后的原文）。 */
  readonly columns: readonly string[];
  /** 数据行（不含表头）；列数与表头一致。 */
  readonly rows: readonly (readonly string[])[];
  /** 拒绝行样本；数量不超过 `maxErrorSamples`。 */
  readonly rejected: readonly CsvRejectedRow[];
  /** 被拒绝的行数，可能大于样本数。 */
  readonly rejectedCount: number;
  /** 是否检测并剥离了 UTF-8 BOM。 */
  readonly hadBom: boolean;
  /** 换行风格，仅用于诊断。 */
  readonly newline: 'crlf' | 'lf';
}

function csvError(message: string, operation = 'parseCsv'): GisError {
  return new GisError(message, { code: 'INVALID_CSV_INPUT', module: 'csv', operation });
}

/**
 * 判断文本是否包含 Unicode 替换字符。
 *
 * 出现替换字符通常意味着文件不是 UTF-8（例如 Excel 默认导出的 GBK），
 * 这时任何解析结果都不可信，应当提示调用方另存为 UTF-8。
 */
export function hasReplacementCharacter(text: string): boolean {
  return text.includes('\uFFFD');
}

/**
 * 解析 CSV 文本。
 *
 * 遵循 RFC4180 的引号、转义引号与引号内换行规则，不使用 `split(',')`；空行跳过；
 * 列数与表头不一致的行进入 `rejected` 样本而不是静默丢弃，避免列错位。
 *
 * @param text - CSV 文本。
 * @param options - 覆盖默认上限。
 * @returns 表头、数据行、拒绝样本与诊断信息。
 * @throws `INVALID_CSV_INPUT` 非文本、疑似非 UTF-8、引号未闭合、超限或没有可用数据行。
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvTable {
  if (typeof text !== 'string') {
    throw csvError('CSV content must be a string.');
  }
  const maxRows = options.maxRows ?? csvLimits.maxRows;
  const maxColumns = options.maxColumns ?? csvLimits.maxColumns;
  const maxFieldBytes = options.maxFieldBytes ?? csvLimits.maxFieldBytes;
  const maxErrorSamples = options.maxErrorSamples ?? csvLimits.maxErrorSamples;

  if (text.length > csvLimits.maxBytes) {
    throw csvError(`CSV content exceeds the ${String(csvLimits.maxBytes)} byte limit.`);
  }
  const hadBom = text.charCodeAt(0) === 0xfeff;
  const body = hadBom ? text.slice(1) : text;
  if (hasReplacementCharacter(body)) {
    throw csvError('CSV content is not valid UTF-8; re-save the file as UTF-8 and retry.');
  }

  const newline: 'crlf' | 'lf' = body.includes('\r\n') ? 'crlf' : 'lf';
  const rows: string[][] = [];
  const rejected: CsvRejectedRow[] = [];
  let rejectedCount = 0;
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let fieldBytes = 0;
  let rowStartLine = 1;

  const endField = () => {
    fields.push(inQuotes ? field : field.trim());
    field = '';
    fieldBytes = 0;
  };

  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char === '"') {
      if (inQuotes && body.charAt(index + 1) === '"') {
        field += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (
      !inQuotes &&
      (char === ',' || char === '\n' || (char === '\r' && body.charAt(index + 1) === '\n'))
    ) {
      endField();
      if (char === ',') {
        continue;
      }
      if (char === '\r') {
        index += 1;
      }
      line += 1;
      const isEmpty = fields.length === 1 && (fields[0] ?? '') === '';
      if (isEmpty) {
        fields = [];
        rowStartLine = line;
        continue;
      }
      if (fields.length > maxColumns) {
        throw csvError(
          `CSV line ${String(rowStartLine)} has ${String(fields.length)} columns, above the ${String(maxColumns)} limit.`,
        );
      }
      rows.push(fields);
      fields = [];
      rowStartLine = line;
      continue;
    }
    if (!inQuotes && char === '\r') {
      continue;
    }
    if (char === '\n') {
      line += 1;
    }
    field += char;
    fieldBytes += char.charCodeAt(0) > 0x7f ? 3 : 1;
    if (fieldBytes > maxFieldBytes) {
      throw csvError(
        `CSV line ${String(line)} has a field above the ${String(maxFieldBytes)} byte limit.`,
      );
    }
  }
  if (inQuotes) {
    throw csvError('CSV content has an unterminated quoted field.');
  }
  endField();
  const lastIsEmpty = fields.length === 1 && (fields[0] ?? '') === '';
  if (!lastIsEmpty) {
    if (fields.length > maxColumns) {
      throw csvError(
        `CSV line ${String(rowStartLine)} has ${String(fields.length)} columns, above the ${String(maxColumns)} limit.`,
      );
    }
    rows.push(fields);
  }

  if (rows.length === 0) {
    throw csvError('CSV content has no usable rows.');
  }
  const header = rows.shift();
  if (!header || header.length === 0) {
    throw csvError('CSV content is missing a header row.');
  }
  if (rows.length === 0) {
    throw csvError('CSV content has a header but no data rows.');
  }
  if (rows.length > maxRows) {
    throw csvError(`CSV data has ${String(rows.length)} rows, above the ${String(maxRows)} limit.`);
  }

  const accepted: string[][] = [];
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      rejectedCount += 1;
      if (rejected.length < maxErrorSamples) {
        rejected.push({
          line: index + 2,
          reason: `Column count ${String(row.length)} does not match the header (${String(header.length)}).`,
        });
      }
      continue;
    }
    accepted.push(row);
  }

  return {
    columns: header.map((column) => column.trim()),
    rows: accepted,
    rejected,
    rejectedCount,
    hadBom,
    newline,
  };
}

/** 字段类型推断结果；只作为预填建议，不参与写入决策。 */
export type CsvFieldKind = 'number' | 'string' | 'empty';

/** 单列的描述。 */
export interface CsvColumnDescription {
  /** 列名。 */
  readonly column: string;
  /** 取值类型推断。 */
  readonly kind: CsvFieldKind;
  /** 少量样本值，便于人工确认列语义。 */
  readonly samples: readonly string[];
}

/** 经纬度列的猜测结果。 */
export interface CsvPointColumnGuess {
  /** 建议的经度列；未命中时为 `undefined`。 */
  readonly longitude: string | undefined;
  /** 建议的纬度列；未命中时为 `undefined`。 */
  readonly latitude: string | undefined;
}

/** 严格十进制数；带前导零的编号（如 `001`）与科学计数法都不算数字。 */
const STRICT_DECIMAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/u;
const LEADING_ZERO = /^[+-]?0\d/u;

/**
 * 读取某一列的取值分布，用于预填经纬度候选列。
 *
 * @param table - {@link parseCsv} 的结果。
 * @param column - 列名。
 * @returns 列名、类型推断与少量样本值。
 */
export function describeCsvColumn(table: CsvTable, column: string): CsvColumnDescription {
  const index = table.columns.indexOf(column);
  if (index < 0) {
    return { column, kind: 'empty', samples: [] };
  }
  let numbers = 0;
  let texts = 0;
  const samples: string[] = [];
  for (const row of table.rows) {
    const value = (row[index] ?? '').trim();
    if (value === '') {
      continue;
    }
    if (STRICT_DECIMAL.test(value) && !LEADING_ZERO.test(value)) {
      numbers += 1;
    } else {
      texts += 1;
    }
    if (samples.length < 5) {
      samples.push(value);
    }
  }
  const kind: CsvFieldKind = numbers > 0 && texts === 0 ? 'number' : 'string';
  return { column, kind: numbers === 0 && texts === 0 ? 'empty' : kind, samples };
}

/**
 * 猜测经纬度列名。
 *
 * 只匹配明确的经纬度列名，**不会**把 `x` / `y` 当作经纬度——投影坐标需要先做 CRS 转换。
 *
 * @param columns - 表头列名。
 * @returns 建议的经度列与纬度列，未命中时为 `undefined`。
 */
export function guessCsvPointColumns(columns: readonly string[]): CsvPointColumnGuess {
  const match = (keywords: readonly string[]) =>
    columns.find((column) => keywords.some((keyword) => column.toLowerCase().includes(keyword)));
  return {
    longitude: match(['longitude', 'lon', 'lng', '经度']),
    latitude: match(['latitude', 'lat', '纬度']),
  };
}

/**
 * 解析坐标文本。
 *
 * 只接受严格十进制数：带前导零的编号与科学计数法都返回 `undefined`，
 * 避免把对象编号误当成坐标。
 *
 * @param value - 原始文本。
 * @param minimum - 允许的最小值。
 * @param maximum - 允许的最大值。
 * @returns 数值，或 `undefined` 表示不是合法坐标。
 */
export function parseCoordinateText(
  value: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !STRICT_DECIMAL.test(text) || LEADING_ZERO.test(text)) {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return undefined;
  }
  return parsed;
}

/** 点位表的一行。 */
export interface CsvPointRow {
  /** 经度，单位为度。 */
  readonly longitude: number;
  /** 纬度，单位为度。 */
  readonly latitude: number;
  /** 高度，单位为米；没有该列或该列为空时为 `undefined`。 */
  readonly height: number | undefined;
  /** 数据行号（含表头行，从 2 开始）。 */
  readonly line: number;
}

/** `readPointCsv` 的配置。 */
export interface CsvPointReadOptions {
  /** 经度列名，必须存在于表头。 */
  readonly longitudeColumn: string;
  /** 纬度列名，必须存在于表头。 */
  readonly latitudeColumn: string;
  /** 高度列名；省略时不读高度。 */
  readonly heightColumn?: string;
  /** 拒绝行样本上限，默认 200。 */
  readonly maxErrorSamples?: number;
  /** 透传给 {@link parseCsv} 的上限。 */
  readonly parseOptions?: CsvParseOptions;
}

/** `readPointCsv` 的结果。 */
export interface CsvPointReadResult {
  /** 解析出的点位，顺序与数据行一致。 */
  readonly points: readonly CsvPointRow[];
  /** 拒绝行样本，包含 CSV 结构化拒绝与坐标非法两类。 */
  readonly rejected: readonly CsvRejectedRow[];
  /** 被拒绝的行数，可能大于样本数。 */
  readonly rejectedCount: number;
  /** 表头列名。 */
  readonly columns: readonly string[];
}

/**
 * 从 CSV 文本读取点位表。
 *
 * 列名必须显式给出：不做"猜中的列就是经纬度"的隐式决策。经纬度范围按 WGS84 校验；
 * 高度只要求有限数。投影坐标请先用 `transformGeoPath` 转换，再交给本函数或点图层。
 *
 * @param text - CSV 文本。
 * @param options - 列映射与上限。
 * @returns 点位、拒绝样本与表头。
 * @throws `INVALID_CSV_INPUT` 解析失败或列名不存在。
 */
export function readPointCsv(text: string, options: CsvPointReadOptions): CsvPointReadResult {
  const table = parseCsv(text, options.parseOptions ?? {});
  const longitudeIndex = table.columns.indexOf(options.longitudeColumn);
  const latitudeIndex = table.columns.indexOf(options.latitudeColumn);
  if (longitudeIndex < 0) {
    throw csvError(
      `CSV is missing the longitude column "${options.longitudeColumn}".`,
      'readPointCsv',
    );
  }
  if (latitudeIndex < 0) {
    throw csvError(
      `CSV is missing the latitude column "${options.latitudeColumn}".`,
      'readPointCsv',
    );
  }
  const heightIndex =
    options.heightColumn === undefined ? -1 : table.columns.indexOf(options.heightColumn);
  if (options.heightColumn !== undefined && heightIndex < 0) {
    throw csvError(`CSV is missing the height column "${options.heightColumn}".`, 'readPointCsv');
  }

  const maxErrorSamples = options.maxErrorSamples ?? csvLimits.maxErrorSamples;
  const rejected: CsvRejectedRow[] = [...table.rejected];
  let rejectedCount = table.rejectedCount;
  const points: CsvPointRow[] = [];

  table.rows.forEach((row, index) => {
    const line = index + 2;
    const longitude = parseCoordinateText(row[longitudeIndex] ?? '', -180, 180);
    const latitude = parseCoordinateText(row[latitudeIndex] ?? '', -90, 90);
    if (longitude === undefined || latitude === undefined) {
      rejectedCount += 1;
      if (rejected.length < maxErrorSamples) {
        rejected.push({ line, reason: 'Longitude or latitude is not a valid WGS84 degree value.' });
      }
      return;
    }
    let height: number | undefined;
    if (heightIndex >= 0) {
      const rawHeight = (row[heightIndex] ?? '').trim();
      if (rawHeight !== '') {
        const parsedHeight = Number(rawHeight);
        if (!Number.isFinite(parsedHeight)) {
          rejectedCount += 1;
          if (rejected.length < maxErrorSamples) {
            rejected.push({ line, reason: 'Height is not a finite number.' });
          }
          return;
        }
        height = parsedHeight;
      }
    }
    points.push(
      height === undefined
        ? { longitude, latitude, height: undefined, line }
        : { longitude, latitude, height, line },
    );
  });

  return { points, rejected, rejectedCount, columns: table.columns };
}
