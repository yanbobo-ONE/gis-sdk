import { describe, expect, it } from 'vitest';

import { planPointImport } from '../src/core/point-import.js';
import { registerCrs } from '../src/spatial/crs.js';

const wgs84Csv = [
  'lon,lat,name,code,alt',
  '116.391,39.907,天安门,pt-1,44',
  '121.473,31.230,外滩,pt-2,',
  'bad,31.3,脏数据,pt-3,8',
  '200.1,40.5,超范围,pt-4,9',
].join('\n');

describe('planPointImport', () => {
  it('guesses the mapping, previews the head of the file, and rejects bad rows', () => {
    const plan = planPointImport({ text: wgs84Csv, columns: { label: 'name', id: 'code' } });

    expect(plan.preview.guessed).toBe(true);
    expect(plan.preview.columns).toEqual({
      longitude: 'lon',
      latitude: 'lat',
      label: 'name',
      id: 'code',
    });
    expect(plan.preview.crs).toBe('WGS84');
    expect(plan.preview.totalRows).toBe(4);
    expect(plan.preview.acceptedCount).toBe(2);
    expect(plan.preview.rejectedCount).toBe(2);
    expect(plan.preview.issues.join('\n')).toContain('列映射来自猜测');
    expect(plan.preview.issues.join('\n')).toContain('有 2 行被拒绝');

    expect(plan.points.map((point) => point.id)).toEqual(['pt-1', 'pt-2']);
    expect(plan.points[0]).toEqual({
      id: 'pt-1',
      longitude: 116.391,
      latitude: 39.907,
      height: undefined,
      label: '天安门',
      line: 2,
    });
    // 高程列没映射时保持 undefined，不做猜测。
    expect(plan.points[1]?.height).toBeUndefined();
    expect(plan.preview.rejected.map((row) => row.line)).toEqual([4, 5]);
  });

  it('maps the height column on request and treats empty cells as no data', () => {
    const plan = planPointImport({
      text: wgs84Csv,
      columns: { longitude: 'lon', latitude: 'lat', height: 'alt' },
    });

    expect(plan.preview.guessed).toBe(false);
    expect(plan.points[0]?.height).toBe(44);
    expect(plan.points[1]?.height).toBeUndefined();
  });

  it('caps the preview but commits every accepted point', () => {
    const rows = ['lon,lat'];
    for (let index = 0; index < 10; index += 1) {
      rows.push(`${String(116 + index * 0.01)},39.9`);
    }
    const plan = planPointImport({ text: rows.join('\n'), previewLimit: 3 });

    expect(plan.preview.points).toHaveLength(3);
    expect(plan.preview.acceptedCount).toBe(10);
    expect(plan.points).toHaveLength(10);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.points)).toBe(true);
    expect(Object.isFrozen(plan.preview.columns)).toBe(true);
  });

  it('converts projected input to WGS84 and says so in the issues', () => {
    // Web 墨卡托下的两点：原点与东经约 1 度处的 (111319.49, 0)。
    const plan = planPointImport({
      text: ['x,y', '0,0', '111319.49,0'].join('\n'),
      columns: { longitude: 'x', latitude: 'y' },
      crs: 'EPSG:3857',
    });

    expect(plan.preview.crs).toBe('EPSG:3857');
    expect(plan.preview.acceptedCount).toBe(2);
    expect(plan.points[0]?.longitude).toBeCloseTo(0, 6);
    expect(plan.points[1]?.longitude).toBeCloseTo(1, 4);
    expect(plan.points[1]?.latitude).toBeCloseTo(0, 6);
    expect(plan.preview.issues.join('\n')).toContain('换算到 WGS84');
    expect(plan.preview.issues.join('\n')).toContain('高程不参与投影换算');
  });

  it('rejects rows whose converted coordinate leaves the WGS84 range', () => {
    // 单位/椭球配错（把米当成"单位球上的米"）是导入失败的真实形态：换算结果会飞出 ±180 / ±90。
    registerCrs(
      'TEST-UNIT-SPHERE',
      '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +a=1 +b=1 +units=m +no_defs',
      { descriptor: { kind: 'projected', units: 'm' } },
    );
    const plan = planPointImport({
      text: ['x,y', '10,0', '1000,0'].join('\n'),
      columns: { longitude: 'x', latitude: 'y' },
      crs: 'TEST-UNIT-SPHERE',
    });

    expect(plan.preview.acceptedCount).toBe(0);
    expect(plan.preview.rejectedCount).toBe(2);
    // 逐行拒绝，整单不失败；原因写清是换算结果越界。
    for (const row of plan.preview.rejected) {
      expect(row.reason).toContain('outside the WGS84 range');
    }
  });

  it('treats scientific notation as an invalid coordinate, not a number', () => {
    const plan = planPointImport({
      text: ['x,y', '1e8,0'].join('\n'),
      columns: { longitude: 'x', latitude: 'y' },
      crs: 'EPSG:3857',
    });

    // 坐标解析沿用 CSV 的严格十进制口径：'1e8' 这类写法按脏数据拒绝，不做隐式转换。
    expect(plan.preview.acceptedCount).toBe(0);
    expect(plan.preview.rejected[0]?.reason).toContain('finite projected coordinate');
  });

  it('fails the whole plan for unsupported CRS instead of rejecting every row', () => {
    expect(() =>
      planPointImport({
        text: ['lon,lat', '0,0'].join('\n'),
        crs: 'EPSG:9999',
      }),
    ).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CRS' }));
  });

  it('rejects explicit columns that are missing from the header', () => {
    expect(() =>
      planPointImport({
        text: ['lon,lat', '0,0'].join('\n'),
        columns: { longitude: 'lon', latitude: 'latitude' },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CSV_INPUT' }));

    expect(() => planPointImport({ text: ['a,b', '1,2'].join('\n') })).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV_INPUT' }),
    );
    expect(() => planPointImport({ text: wgs84Csv, previewLimit: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV_INPUT' }),
    );
  });

  it('keeps structural rejects from the CSV parser in the totals', () => {
    // 第二行列数多于表头，属于结构性问题：解析阶段就被拒绝。
    const plan = planPointImport({
      text: ['lon,lat', '116.391,39.907', '121.473,31.23,extra'].join('\n'),
    });

    expect(plan.preview.acceptedCount).toBe(1);
    expect(plan.preview.rejectedCount).toBe(1);
    expect(plan.preview.rejected).toHaveLength(1);
  });

  it('accepts a Chinese header through the built-in keyword guess', () => {
    const plan = planPointImport({ text: ['经度,纬度', '116.391,39.907'].join('\n') });

    expect(plan.preview.guessed).toBe(true);
    expect(plan.preview.columns).toMatchObject({ longitude: '经度', latitude: '纬度' });
    expect(plan.points).toHaveLength(1);
  });
});
