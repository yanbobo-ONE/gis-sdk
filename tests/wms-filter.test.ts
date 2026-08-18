import { describe, expect, it } from 'vitest';

import { serializeWmsFilter, wmsFilter } from '../src/cesium/layers/wms-filter.js';

describe('serializeWmsFilter', () => {
  it('serializes comparison values and escapes string literals', () => {
    expect(serializeWmsFilter(wmsFilter.eq('status', "O'Reilly"))).toBe("status = 'O''Reilly'");
    expect(serializeWmsFilter(wmsFilter.gte('priority', 2))).toBe('priority >= 2');
    expect(serializeWmsFilter(wmsFilter.eq('enabled', true))).toBe('enabled = TRUE');
    expect(serializeWmsFilter(wmsFilter.isNull('retired_at'))).toBe('retired_at IS NULL');
  });

  it('serializes nested boolean expressions with explicit grouping', () => {
    const filter = wmsFilter.and(
      wmsFilter.eq('status', 'ACTIVE'),
      wmsFilter.or(wmsFilter.lt('altitude', 1000), wmsFilter.gte('priority', 3)),
      wmsFilter.not(wmsFilter.isNull('owner')),
    );

    expect(serializeWmsFilter(filter)).toBe(
      "(status = 'ACTIVE') AND ((altitude < 1000) OR (priority >= 3)) AND (NOT (owner IS NULL))",
    );
  });

  it('rejects unsafe property names, non-finite numbers, invalid LIKE values, and empty groups', () => {
    const invalidFilters = [
      { op: 'eq', property: 'name); DROP TABLE x', value: 'x' } as const,
      wmsFilter.eq('priority', Number.NaN),
      { op: 'like', property: 'name', value: 42 } as const,
      { op: 'and', filters: [] } as const,
    ];

    for (const filter of invalidFilters) {
      expect(() => serializeWmsFilter(filter)).toThrow(
        expect.objectContaining({
          code: 'INVALID_WMS_FILTER',
          module: 'layer',
          operation: 'serializeFilter',
        }),
      );
    }
  });
});
