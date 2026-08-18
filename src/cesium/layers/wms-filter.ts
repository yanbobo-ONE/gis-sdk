import { GisError } from '../../core/errors.js';
import type { WmsFilter, WmsParameterValue } from '../../layers/contracts.js';

const propertyPattern = /^[A-Za-z_][A-Za-z0-9_.]*$/u;

function invalidFilter(message: string): GisError {
  return new GisError(message, {
    code: 'INVALID_WMS_FILTER',
    module: 'layer',
    operation: 'serializeFilter',
  });
}

function propertyName(value: string): string {
  if (!propertyPattern.test(value)) {
    throw invalidFilter(`Invalid WMS filter property: "${value}".`);
  }
  return value;
}

function literal(value: WmsParameterValue): string {
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalidFilter('WMS filter numbers must be finite.');
    }
    return String(value);
  }
  return value ? 'TRUE' : 'FALSE';
}

/** @internal */
export function serializeWmsFilter(filter: WmsFilter): string {
  switch (filter.op) {
    case 'eq':
      return `${propertyName(filter.property)} = ${literal(filter.value)}`;
    case 'ne':
      return `${propertyName(filter.property)} <> ${literal(filter.value)}`;
    case 'lt':
      return `${propertyName(filter.property)} < ${literal(filter.value)}`;
    case 'lte':
      return `${propertyName(filter.property)} <= ${literal(filter.value)}`;
    case 'gt':
      return `${propertyName(filter.property)} > ${literal(filter.value)}`;
    case 'gte':
      return `${propertyName(filter.property)} >= ${literal(filter.value)}`;
    case 'like':
      if (typeof filter.value !== 'string') {
        throw invalidFilter('WMS LIKE filters require a string value.');
      }
      return `${propertyName(filter.property)} LIKE ${literal(filter.value)}`;
    case 'is-null':
      return `${propertyName(filter.property)} IS NULL`;
    case 'not':
      return `NOT (${serializeWmsFilter(filter.filter)})`;
    case 'and':
    case 'or': {
      if (filter.filters.length < 2) {
        throw invalidFilter(`WMS ${filter.op.toUpperCase()} filters require at least two entries.`);
      }
      const separator = filter.op === 'and' ? ' AND ' : ' OR ';
      return filter.filters.map((item) => `(${serializeWmsFilter(item)})`).join(separator);
    }
  }
}

/** 类型化创建 WMS CQL 过滤表达式。 */
export const wmsFilter = Object.freeze({
  /** 创建等于比较。 */
  eq: (property: string, value: WmsParameterValue): WmsFilter => ({
    op: 'eq',
    property,
    value,
  }),
  /** 创建不等于比较。 */
  ne: (property: string, value: WmsParameterValue): WmsFilter => ({
    op: 'ne',
    property,
    value,
  }),
  /** 创建小于比较。 */
  lt: (property: string, value: WmsParameterValue): WmsFilter => ({
    op: 'lt',
    property,
    value,
  }),
  /** 创建小于等于比较。 */
  lte: (property: string, value: WmsParameterValue): WmsFilter => ({
    op: 'lte',
    property,
    value,
  }),
  /** 创建大于比较。 */
  gt: (property: string, value: WmsParameterValue): WmsFilter => ({
    op: 'gt',
    property,
    value,
  }),
  /** 创建大于等于比较。 */
  gte: (property: string, value: WmsParameterValue): WmsFilter => ({
    op: 'gte',
    property,
    value,
  }),
  /** 创建字符串 LIKE 比较。 */
  like: (property: string, value: string): WmsFilter => ({ op: 'like', property, value }),
  /** 创建空值判断。 */
  isNull: (property: string): WmsFilter => ({ op: 'is-null', property }),
  /** 对表达式取反。 */
  not: (filter: WmsFilter): WmsFilter => ({ op: 'not', filter }),
  /** 使用 AND 组合至少两个表达式。 */
  and: (...filters: readonly WmsFilter[]): WmsFilter => ({ op: 'and', filters }),
  /** 使用 OR 组合至少两个表达式。 */
  or: (...filters: readonly WmsFilter[]): WmsFilter => ({ op: 'or', filters }),
});
