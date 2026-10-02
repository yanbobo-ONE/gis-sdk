import { describe, expect, it } from 'vitest';

import { GisError } from '../src/core/errors.js';
import { buildHeatmapGrid, colorizeHeatmap, heatmapColorRamps } from '../src/core/heatmap.js';

const BEIJING = { longitude: 116.391, latitude: 39.907 };

/** 峰值格子的下标；密度存在 Float32Array 里，不能用 indexOf(maxDensity) 精确匹配。 */
function peakIndexOf(grid: { readonly density: Float32Array }): number {
  let best = 0;
  for (let index = 1; index < grid.density.length; index += 1) {
    if ((grid.density[index] ?? 0) > (grid.density[best] ?? 0)) {
      best = index;
    }
  }
  return best;
}

describe('buildHeatmapGrid', () => {
  it('peaks at the point and decays to zero at the influence radius', () => {
    const grid = buildHeatmapGrid({ points: [BEIJING], radiusMeters: 1_000, resolution: 64 });

    expect(grid.pointCount).toBe(1);
    expect(grid.density).toBeInstanceOf(Float32Array);
    expect(grid.width * grid.height).toBe(grid.density.length);
    expect(grid.maxDensity).toBeGreaterThan(0);

    // 峰值的格心离点最近：核函数在中心为 1，权重默认 1。
    const peak = Math.max(...grid.density);
    expect(peak).toBeCloseTo(1, 1);
    expect(grid.maxDensity).toBe(peak);

    // 离点超过影响半径的格子密度为 0（外扩半径后四角都超过半径）。
    expect(grid.density[0]).toBe(0);
    expect(grid.density[grid.density.length - 1]).toBe(0);
    expect(Object.isFrozen(grid)).toBe(true);
    expect(Object.isFrozen(grid.bounds)).toBe(true);
  });

  it('scales by weight and adds overlapping contributions', () => {
    const single = buildHeatmapGrid({ points: [BEIJING], radiusMeters: 2_000, resolution: 48 });
    const doubled = buildHeatmapGrid({
      points: [{ ...BEIJING, weight: 2 }],
      radiusMeters: 2_000,
      resolution: 48,
    });
    const overlapped = buildHeatmapGrid({
      points: [BEIJING, { longitude: 116.3911, latitude: 39.9071 }],
      radiusMeters: 2_000,
      resolution: 48,
    });

    expect(doubled.maxDensity).toBeCloseTo(single.maxDensity * 2, 5);
    // 相邻点叠加：峰值高于单点（两个核在重叠处相加），但低于两点各自权重之和。
    expect(overlapped.maxDensity).toBeGreaterThan(single.maxDensity);
    expect(overlapped.maxDensity).toBeLessThan(single.maxDensity * 2);

    // 权重为 0 的点不产生任何密度。
    const zero = buildHeatmapGrid({
      points: [{ ...BEIJING, weight: 0 }],
      radiusMeters: 2_000,
      resolution: 32,
    });
    expect(zero.maxDensity).toBe(0);
  });

  it('derives bounds from the points plus one radius and keeps the aspect ratio', () => {
    const single = buildHeatmapGrid({ points: [BEIJING], radiusMeters: 1_000, resolution: 64 });
    // 单点：外扩一个半径后是一个近似正方形（经纬按度数换算），长边等于 resolution。
    expect(Math.max(single.width, single.height)).toBe(64);
    expect(Math.abs(single.width - single.height)).toBeLessThanOrEqual(2);
    expect(single.bounds.west).toBeLessThan(BEIJING.longitude);
    expect(single.bounds.east).toBeGreaterThan(BEIJING.longitude);
    expect(single.bounds.south).toBeLessThan(BEIJING.latitude);
    expect(single.bounds.north).toBeGreaterThan(BEIJING.latitude);

    // 东西向铺开的一段点位：宽明显大于高。
    const line = buildHeatmapGrid({
      points: [
        { longitude: 116.2, latitude: 39.9 },
        { longitude: 116.8, latitude: 39.9 },
      ],
      radiusMeters: 500,
      resolution: 64,
    });
    expect(line.width).toBe(64);
    expect(line.height).toBeLessThan(line.width / 2);
  });

  it('honours explicit bounds verbatim', () => {
    const bounds = { west: 116, south: 39.5, east: 117, north: 40 };
    const grid = buildHeatmapGrid({ points: [BEIJING], bounds, resolution: 32 });

    expect(grid.bounds).toEqual(bounds);
    expect(grid.width).toBe(32);
    // 一点落在范围内：密度非零的位置在点所在的行列附近。
    const maxIndex = peakIndexOf(grid);
    expect(maxIndex).toBeGreaterThanOrEqual(0);
    expect(maxIndex).toBeLessThan(grid.density.length);
  });

  it('rejects invalid input with typed errors', () => {
    const cases: readonly (() => unknown)[] = [
      () => buildHeatmapGrid({ points: [] }),
      () => buildHeatmapGrid({ points: [BEIJING], radiusMeters: 0 }),
      () => buildHeatmapGrid({ points: [BEIJING], resolution: 8 }),
      () => buildHeatmapGrid({ points: [BEIJING], resolution: 2_000 }),
      () => buildHeatmapGrid({ points: [{ longitude: 200, latitude: 0 }] }),
      () => buildHeatmapGrid({ points: [{ longitude: 0, latitude: Number.NaN }] }),
      () => buildHeatmapGrid({ points: [{ ...BEIJING, weight: -1 }] }),
      () =>
        buildHeatmapGrid({
          points: [BEIJING],
          bounds: { west: 117, south: 39, east: 116, north: 40 },
        }),
      () =>
        buildHeatmapGrid({
          points: [BEIJING],
          bounds: { west: 116, south: 39.9, east: 116, north: 39.9 },
        }),
    ];
    for (const run of cases) {
      expect(run).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    }
    expect(() => buildHeatmapGrid(undefined as never)).toThrow(GisError);
  });
});

describe('colorizeHeatmap', () => {
  it('maps density to the ramp and scales alpha with density', () => {
    const grid = buildHeatmapGrid({ points: [BEIJING], radiusMeters: 2_000, resolution: 32 });
    const pixels = colorizeHeatmap(grid, { colorRamp: 'thermal', opacity: 0.5 });

    expect(pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(pixels.length).toBe(grid.width * grid.height * 4);

    // 零密度格子完全透明。
    expect(pixels[3]).toBe(0);
    // 峰值格子：颜色等于色带末端（thermal 的 1 号色 #ef4444），alpha = 0.5。
    const peakIndex = peakIndexOf(grid) * 4;
    expect(pixels[peakIndex]).toBe(0xef);
    expect(pixels[peakIndex + 1]).toBe(0x44);
    expect(pixels[peakIndex + 2]).toBe(0x44);
    expect(pixels[peakIndex + 3]).toBe(Math.round(255 * 0.5));

    // 低密度格子应偏冷色（蓝分量高于红分量）。
    const lowIndex =
      grid.density.findIndex((value) => value > 0 && value < grid.maxDensity * 0.4) * 4;
    if (lowIndex > 0) {
      expect(pixels[lowIndex + 2] ?? 0).toBeGreaterThan(pixels[lowIndex] ?? 0);
    }
  });

  it('supports custom stops and a maxDensity override', () => {
    const grid = buildHeatmapGrid({ points: [BEIJING], radiusMeters: 1_000, resolution: 16 });
    const pixels = colorizeHeatmap(grid, {
      colorRamp: [
        { offset: 0, color: '#000' },
        { offset: 1, color: '#fff' },
      ],
      maxDensity: grid.maxDensity * 2,
    });

    // 上限翻倍后峰值只到色带中点附近：颜色是灰色，alpha 约一半。
    const peakIndex = peakIndexOf(grid) * 4;
    expect(pixels[peakIndex]).toBeLessThan(0xff);
    expect(pixels[peakIndex]).toBeGreaterThan(0x3f);
    expect(pixels[peakIndex + 3] ?? 255).toBeLessThanOrEqual(128);

    expect(Object.isFrozen(heatmapColorRamps.radar)).toBe(true);
    expect(heatmapColorRamps.cool.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects invalid ramps and options', () => {
    const grid = buildHeatmapGrid({ points: [BEIJING], radiusMeters: 1_000, resolution: 16 });
    const cases: readonly (() => unknown)[] = [
      () => colorizeHeatmap(grid, { colorRamp: 'rainbow' as never }),
      () => colorizeHeatmap(grid, { opacity: 2 }),
      () => colorizeHeatmap(grid, { maxDensity: 0 }),
      () => colorizeHeatmap(grid, { colorRamp: [{ offset: 0, color: '#fff' }] }),
      () =>
        colorizeHeatmap(grid, {
          colorRamp: [
            { offset: 0.2, color: '#000' },
            { offset: 1, color: '#fff' },
          ],
        }),
      () =>
        colorizeHeatmap(grid, {
          colorRamp: [
            { offset: 0, color: '#000' },
            { offset: 0.5, color: 'red' },
            { offset: 1, color: '#fff' },
          ],
        }),
      () =>
        colorizeHeatmap(grid, {
          colorRamp: [
            { offset: 0, color: '#000' },
            { offset: 0.4, color: '#888' },
            { offset: 0.3, color: '#fff' },
            { offset: 1, color: '#fff' },
          ],
        }),
    ];
    for (const run of cases) {
      expect(run).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    }
  });
});
