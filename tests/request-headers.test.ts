import { describe, expect, it, vi } from 'vitest';

const cesium = vi.hoisted(() => {
  class FakeResource {
    constructor(
      readonly options: { readonly url: string; readonly headers?: Record<string, string> },
    ) {}
    get url(): string {
      return this.options.url;
    }
    get headers(): Record<string, string> | undefined {
      return this.options.headers;
    }
  }
  return { FakeResource };
});

vi.mock('cesium', () => ({ Resource: cesium.FakeResource }));

import {
  normalizeRequestHeaders,
  withRequestHeaders,
} from '../src/cesium/layers/request-headers.js';

describe('normalizeRequestHeaders', () => {
  it('keeps valid headers and freezes the result', () => {
    const headers = normalizeRequestHeaders(
      { Authorization: 'Bearer token', 'X-Tenant-Id': 'tenant-1' },
      'layer-1',
    );

    expect(headers).toEqual({ Authorization: 'Bearer token', 'X-Tenant-Id': 'tenant-1' });
    expect(Object.isFrozen(headers)).toBe(true);
  });

  it('treats undefined and an empty object as no headers', () => {
    expect(normalizeRequestHeaders(undefined, 'layer-1')).toBeUndefined();
    expect(normalizeRequestHeaders({}, 'layer-1')).toBeUndefined();
  });

  it('rejects invalid names, non-string values, and non-objects', () => {
    expect(() => normalizeRequestHeaders({ 'Bad Header': 'x' }, 'layer-1')).toThrow(
      expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }),
    );
    expect(() => normalizeRequestHeaders({ Authorization: 42 }, 'layer-1')).toThrow(
      expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }),
    );
    expect(() => normalizeRequestHeaders(['a'], 'layer-1')).toThrow(
      expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }),
    );
    expect(() => normalizeRequestHeaders('Authorization: x', 'layer-1')).toThrow(
      expect.objectContaining({ code: 'INVALID_LAYER_CONFIG' }),
    );
  });

  it('allows an empty header value (legal HTTP, useful for flag-style headers)', () => {
    expect(normalizeRequestHeaders({ 'X-Flag': '' }, 'layer-1')).toEqual({ 'X-Flag': '' });
  });
});

describe('withRequestHeaders', () => {
  it('returns the plain url when there are no headers', () => {
    expect(withRequestHeaders('https://example.com/tiles/{z}/{x}/{y}.png', undefined)).toBe(
      'https://example.com/tiles/{z}/{x}/{y}.png',
    );
  });

  it('wraps the url in a Resource carrying the headers', () => {
    const resource = withRequestHeaders('https://example.com/wms', { Authorization: 'Bearer t' });

    expect(resource).toBeInstanceOf(cesium.FakeResource);
    // 运行期是 mock 的 Resource，类型来自真实 Cesium 声明，因此经 unknown 收窄。
    const options = (
      resource as unknown as { options: { url: string; headers?: Record<string, string> } }
    ).options;
    expect(options.url).toBe('https://example.com/wms');
    expect(options.headers).toEqual({ Authorization: 'Bearer t' });
  });
});
