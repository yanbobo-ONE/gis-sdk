import { describe, expect, it } from 'vitest';

import { findClosestApproaches } from '../src/spatial/closest-approach.js';
import type { ApproachTrack } from '../src/spatial/closest-approach.js';

const track = (
  id: string,
  position: [number, number, number],
  velocity: [number, number, number],
  radiusMeters?: number,
): ApproachTrack => ({
  id,
  position: { x: position[0], y: position[1], z: position[2] },
  velocity: { x: velocity[0], y: velocity[1], z: velocity[2] },
  ...(radiusMeters === undefined ? {} : { radiusMeters }),
});

describe('findClosestApproaches', () => {
  it('reports a head-on approach at the right time and distance', () => {
    // 两物体沿 X 轴相向而行，各 1000 m/s，初始相距 20000 m：10 秒后在原点相遇。
    const warnings = findClosestApproaches(
      [track('a', [-10_000, 0, 0], [1_000, 0, 0]), track('b', [10_000, 0, 0], [-1_000, 0, 0])],
      { horizonSeconds: 60, thresholdMeters: 100 },
    );

    expect(warnings).toEqual([{ firstId: 'a', secondId: 'b', timeSeconds: 10, distanceMeters: 0 }]);
  });

  it('uses the larger of threshold and combined radius', () => {
    // 20 秒后最近距离 1000 m；阈值 100 不告警，但两者半径之和 1200 会告警。
    const left = track('a', [-20_000, 0, 0], [1_000, 0, 0], 600);
    const right = track('b', [0, 1_000, 0], [0, 0, 0], 600);

    expect(
      findClosestApproaches([left, right], { horizonSeconds: 60, thresholdMeters: 100 }),
    ).toEqual([{ firstId: 'a', secondId: 'b', timeSeconds: 20, distanceMeters: 1_000 }]);
    // 半径不足以覆盖时也不应告警。
    expect(
      findClosestApproaches([left, { ...right, radiusMeters: 100 }], {
        horizonSeconds: 60,
        thresholdMeters: 100,
      }),
    ).toEqual([]);
  });

  it('clamps the approach time into the analysis window and sorts by time', () => {
    // a 与 b 将在 10 秒接近；c 一直贴近 a（t = 0）。结果按时间升序。
    const warnings = findClosestApproaches(
      [
        track('a', [0, 0, 0], [0, 0, 0]),
        track('b', [30_000, 0, 0], [-1_000, 0, 0]),
        track('c', [50, 0, 0], [0, 0, 0]),
      ],
      { horizonSeconds: 60, thresholdMeters: 100 },
    );

    // 三对都会告警：a-c 立刻贴近、b-c 在 29.95 秒交会、a-b 在 30 秒交会。
    expect(warnings).toEqual([
      { firstId: 'a', secondId: 'c', timeSeconds: 0, distanceMeters: 50 },
      { firstId: 'b', secondId: 'c', timeSeconds: 29.95, distanceMeters: 0 },
      { firstId: 'a', secondId: 'b', timeSeconds: 30, distanceMeters: 0 },
    ]);
    // 30 秒窗口内 b 只走到一半，因此最近点在窗口端点而不是真正的交会时刻。
    const withinWindow = findClosestApproaches(
      [track('a', [0, 0, 0], [0, 0, 0]), track('b', [30_000, 0, 0], [-1_000, 0, 0])],
      { horizonSeconds: 10, thresholdMeters: 100_000 },
    );
    expect(withinWindow[0]?.timeSeconds).toBe(10);
    expect(withinWindow[0]?.distanceMeters).toBeCloseTo(20_000, 6);
  });

  it('returns an empty list when nothing comes close', () => {
    const warnings = findClosestApproaches(
      [track('a', [0, 0, 0], [0, 0, 0]), track('b', [100_000, 0, 0], [0, 0, 0])],
      { horizonSeconds: 60, thresholdMeters: 1_000 },
    );
    expect(warnings).toEqual([]);
    expect(findClosestApproaches([], { horizonSeconds: 60 })).toEqual([]);
    expect(
      findClosestApproaches([track('solo', [0, 0, 0], [0, 0, 0])], { horizonSeconds: 60 }),
    ).toEqual([]);
  });

  it('handles identical velocities and default thresholds', () => {
    // 相对速度为零：最近时刻按 0 处理，距离取初始距离。
    const warnings = findClosestApproaches(
      [track('a', [0, 0, 0], [1_000, 0, 0]), track('b', [500, 0, 0], [1_000, 0, 0])],
      { horizonSeconds: 60 },
    );
    expect(warnings).toEqual([
      { firstId: 'a', secondId: 'b', timeSeconds: 0, distanceMeters: 500 },
    ]);
  });

  it('rejects invalid tracks, duplicate ids, and out-of-range options', () => {
    const valid = track('a', [0, 0, 0], [0, 0, 0]);

    expect(() => findClosestApproaches([valid, { ...valid }], { horizonSeconds: 60 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => findClosestApproaches([{ ...valid, id: '  ' }], { horizonSeconds: 60 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() =>
      findClosestApproaches([{ ...valid, position: { x: Number.NaN, y: 0, z: 0 } }], {
        horizonSeconds: 60,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() =>
      findClosestApproaches([{ ...valid, radiusMeters: -1 }], { horizonSeconds: 60 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() => findClosestApproaches([valid], { horizonSeconds: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() =>
      findClosestApproaches([valid], { horizonSeconds: 60, thresholdMeters: Number.NaN }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
    expect(() => findClosestApproaches('nope' as never, { horizonSeconds: 60 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});
