import { Resource } from 'cesium';

import { GisError } from '../../core/errors.js';

/** 自定义请求头：随每次瓦片 / 图片请求发出的 HTTP 头。 */
export type RequestHeaders = Readonly<Record<string, string>>;

/** RFC 7230 的字段名 token 规则；用它挡住把 token 误填到头名称里的情况。 */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * 校验自定义请求头。
 *
 * 名称必须是合法 HTTP 字段名（否则请求会被浏览器直接拒绝，错误信息也难懂），值必须是字符串；
 * 传 `undefined` 表示不带自定义头。空对象按"没有自定义头"处理，不报错。
 *
 * @param value - 调用方传入的请求头。
 * @param id - 图层 id，用于错误信息。
 * @param operation - 操作名，用于错误信息。
 * @returns 冻结的请求头；没有自定义头时返回 `undefined`。
 * @throws `INVALID_LAYER_CONFIG` 名称或值非法。
 */
export function normalizeRequestHeaders(
  value: unknown,
  id: string,
  operation = 'add',
): RequestHeaders | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GisError(`Layer "${id}" headers must be an object of string values.`, {
      code: 'INVALID_LAYER_CONFIG',
      module: 'layer',
      operation,
    });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new GisError(`Layer "${id}" header name "${name}" is not a valid HTTP field name.`, {
        code: 'INVALID_LAYER_CONFIG',
        module: 'layer',
        operation,
      });
    }
    if (typeof headerValue !== 'string') {
      throw new GisError(`Layer "${id}" header "${name}" must be a string.`, {
        code: 'INVALID_LAYER_CONFIG',
        module: 'layer',
        operation,
      });
    }
    headers[name] = headerValue;
  }
  return Object.freeze(headers);
}

/**
 * 把请求头应用到 URL 上。
 *
 * 没有自定义头时原样返回字符串（保持 Cesium 的默认行为）；有自定义头时包成
 * `Resource`，Cesium 会用它发请求。四个影像 Provider 与底图的 URL 模板都接受
 * `Resource | string`，因此调用方无需分支。
 *
 * 凭证**刷新策略**不在 SDK 范围内：token 过期后由业务重建图层或更新 spec，
 * SDK 不提供自动续期。
 *
 * @param url - 已校验的地址。
 * @param headers - {@link normalizeRequestHeaders} 的结果。
 * @returns 可直接交给 Cesium 的地址或资源。
 */
export function withRequestHeaders(url: string, headers: RequestHeaders | undefined): string | Resource {
  if (!headers) {
    return url;
  }
  return new Resource({ url, headers });
}
