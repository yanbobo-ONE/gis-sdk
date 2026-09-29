import { describe, expect, it } from 'vitest';

import {
  describeCsvColumn,
  guessCsvPointColumns,
  hasReplacementCharacter,
  parseCoordinateText,
  parseCsv,
  readPointCsv,
} from '../src/core/csv.js';

describe('parseCsv', () => {
  it('parses headers, quoted fields, escaping, and embedded newlines', () => {
    const table = parseCsv(
      'name,longitude,latitude,note\r\n"站点,一号",116.39,39.9,"第一行\r\n第二行"\r\n二号,121.47,31.23,"含""引号"""\r\n',
    );

    expect(table.columns).toEqual(['name', 'longitude', 'latitude', 'note']);
    expect(table.newline).toBe('crlf');
    expect(table.hadBom).toBe(false);
    expect(table.rejectedCount).toBe(0);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(['站点,一号', '116.39', '39.9', '第一行\r\n第二行']);
    expect(table.rows[1]?.[3]).toBe('含"引号"');
  });

  it('strips the BOM, skips blank lines, and trims unquoted fields', () => {
    const table = parseCsv('\uFEFFname,lon\n  站点 , 116.39 \n\n');
    expect(table.hadBom).toBe(true);
    expect(table.columns).toEqual(['name', 'lon']);
    expect(table.rows).toEqual([['站点', '116.39']]);
    expect(table.newline).toBe('lf');
  });

  it('collects rows whose column count differs from the header', () => {
    const table = parseCsv('a,b\n1,2\n3\n4,5,6\n7,8\n');
    expect(table.rows).toEqual([
      ['1', '2'],
      ['7', '8'],
    ]);
    expect(table.rejectedCount).toBe(2);
    expect(table.rejected).toEqual([
      { line: 3, reason: 'Column count 1 does not match the header (2).' },
      { line: 4, reason: 'Column count 3 does not match the header (2).' },
    ]);
  });

  it('rejects malformed or oversized input with INVALID_CSV_INPUT', () => {
    const cases: readonly [string, string][] = [
      ['', 'no usable rows'],
      ['a,b\n', 'header but no data rows'],
      ['a,b\n"未闭合,1\n', 'unterminated quoted field'],
      ['a\uFFFDb\n1,2\n', 'not valid UTF-8'],
    ];
    for (const [text, fragment] of cases) {
      expect(() => parseCsv(text), fragment).toThrow(
        expect.objectContaining({ code: 'INVALID_CSV_INPUT', module: 'csv' }),
      );
      expect(() => parseCsv(text), fragment).toThrow(new RegExp(fragment, 'iu'));
    }

    expect(() => parseCsv('a,b\n1,2\n3,4\n', { maxRows: 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV_INPUT' }),
    );
    expect(() => parseCsv('a,b,c\n1,2,3\n', { maxColumns: 2 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV_INPUT' }),
    );
    expect(() => parseCsv(`a\n${'x'.repeat(32)}\n`, { maxFieldBytes: 8 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV_INPUT' }),
    );
    expect(hasReplacementCharacter('正常文本')).toBe(false);
    expect(hasReplacementCharacter('乱码\uFFFD')).toBe(true);
  });
});

describe('CSV column helpers', () => {
  it('describes column kinds without treating leading-zero ids as numbers', () => {
    const table = parseCsv('id,longitude,note\n001,116.39,\n002,121.47,x\n');
    expect(describeCsvColumn(table, 'longitude').kind).toBe('number');
    expect(describeCsvColumn(table, 'id').kind).toBe('string');
    expect(describeCsvColumn(table, 'note').kind).toBe('string');
    expect(describeCsvColumn(table, 'missing').kind).toBe('empty');
    expect(describeCsvColumn(table, 'longitude').samples).toEqual(['116.39', '121.47']);
  });

  it('guesses longitude and latitude columns but never x/y', () => {
    expect(guessCsvPointColumns(['name', 'Longitude', 'lat'])).toEqual({
      longitude: 'Longitude',
      latitude: 'lat',
    });
    expect(guessCsvPointColumns(['经度', '纬度'])).toEqual({ longitude: '经度', latitude: '纬度' });
    expect(guessCsvPointColumns(['x', 'y'])).toEqual({ longitude: undefined, latitude: undefined });
    expect(guessCsvPointColumns(['lon', 'lat'])).toEqual({ longitude: 'lon', latitude: 'lat' });
  });

  it('parses strict decimal coordinates only', () => {
    expect(parseCoordinateText(' 116.39 ', -180, 180)).toBeCloseTo(116.39, 6);
    expect(parseCoordinateText('-39.9', -90, 90)).toBeCloseTo(-39.9, 6);
    expect(parseCoordinateText('001', -180, 180)).toBeUndefined();
    expect(parseCoordinateText('1e3', -180, 180)).toBeUndefined();
    expect(parseCoordinateText('', -180, 180)).toBeUndefined();
    expect(parseCoordinateText('181', -180, 180)).toBeUndefined();
    expect(parseCoordinateText('abc', -180, 180)).toBeUndefined();
  });
});

describe('readPointCsv', () => {
  const text = [
    'name,经度,纬度,海拔',
    '甲,116.39,39.9,12',
    '乙,121.47,31.23,',
    '丙,,39.9,3',
    '丁,999,39.9,3',
    '戊,116.4,39.95,abc',
  ].join('\n');

  it('reads points with explicit column mapping and reports rejected rows', () => {
    const result = readPointCsv(text, {
      longitudeColumn: '经度',
      latitudeColumn: '纬度',
      heightColumn: '海拔',
    });

    expect(result.columns).toEqual(['name', '经度', '纬度', '海拔']);
    expect(result.points).toEqual([
      { longitude: 116.39, latitude: 39.9, height: 12, line: 2 },
      { longitude: 121.47, latitude: 31.23, height: undefined, line: 3 },
    ]);
    expect(result.rejectedCount).toBe(3);
    expect(result.rejected.map((row) => row.line)).toEqual([4, 5, 6]);
    expect(result.rejected[0]?.reason).toContain('Longitude or latitude');
    expect(result.rejected[2]?.reason).toContain('Height');
  });

  it('requires existing columns and honours the sample limit', () => {
    expect(() => readPointCsv(text, { longitudeColumn: 'lon', latitudeColumn: '纬度' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV_INPUT' }),
    );
    expect(() =>
      readPointCsv(text, { longitudeColumn: '经度', latitudeColumn: '纬度', heightColumn: '高程' }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CSV_INPUT' }));

    const limited = readPointCsv(text, {
      longitudeColumn: '经度',
      latitudeColumn: '纬度',
      maxErrorSamples: 1,
    });
    // 未指定高度列时，`戊` 行的 `abc` 不参与校验，因此只有两个坏行。
    expect(limited.rejected).toHaveLength(1);
    expect(limited.rejectedCount).toBe(2);
  });

  it('keeps rows without a height column', () => {
    const result = readPointCsv('lon,lat\n116.39,39.9\n', {
      longitudeColumn: 'lon',
      latitudeColumn: 'lat',
    });
    expect(result.points).toEqual([
      { longitude: 116.39, latitude: 39.9, height: undefined, line: 2 },
    ]);
  });
});
