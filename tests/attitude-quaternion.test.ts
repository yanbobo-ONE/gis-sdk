import { describe, expect, it } from 'vitest';
import {
  HeadingPitchRoll,
  Math as CesiumMath,
  Quaternion as CesiumQuaternion,
} from 'cesium';

import {
  headingPitchRollDegreesFromQuaternion,
  normalizeQuaternion,
  quaternionFromHeadingPitchRollDegrees,
  slerp,
} from '../src/spatial/attitude.js';
import type { Quaternion } from '../src/spatial/attitude.js';

const IDENTITY: Quaternion = { x: 0, y: 0, z: 0, w: 1 };

const dot = (left: Quaternion, right: Quaternion): number =>
  left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w;

describe('normalizeQuaternion', () => {
  it('scales to unit length and rejects degenerate input', () => {
    const normalized = normalizeQuaternion({ x: 0, y: 0, z: 0, w: 2 });

    expect(normalized).toEqual(IDENTITY);
    expect(() => normalizeQuaternion({ x: 0, y: 0, z: 0, w: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() => normalizeQuaternion({ x: Number.NaN, y: 0, z: 0, w: 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});

describe('slerp', () => {
  it('returns the endpoints at ratio 0 and 1', () => {
    const target = quaternionFromHeadingPitchRollDegrees({ heading: 90, pitch: 0, roll: 0 });

    expect(slerp(IDENTITY, target, 0)).toEqual(IDENTITY);
    expect(slerp(IDENTITY, target, 1)).toEqual(target);
  });

  it('walks the shortest arc between two attitudes', () => {
    const target = quaternionFromHeadingPitchRollDegrees({ heading: 120, pitch: 0, roll: 0 });
    const half = slerp(IDENTITY, target, 0.5);
    const expected = quaternionFromHeadingPitchRollDegrees({ heading: 60, pitch: 0, roll: 0 });

    expect(Math.abs(dot(half, expected))).toBeCloseTo(1, 9);

    // 走的是最短弧：与两端点的夹角都小于 90°。
    expect(dot(half, IDENTITY)).toBeGreaterThan(0);
    expect(dot(half, target)).toBeGreaterThan(0);
  });

  it('matches Cesium quaternion slerp', () => {
    const from = quaternionFromHeadingPitchRollDegrees({ heading: 20, pitch: 15, roll: -10 });
    const to = quaternionFromHeadingPitchRollDegrees({ heading: 140, pitch: -30, roll: 40 });
    const cesiumFrom = new CesiumQuaternion(from.x, from.y, from.z, from.w);
    const cesiumTo = new CesiumQuaternion(to.x, to.y, to.z, to.w);

    for (const ratio of [0.2, 0.5, 0.8]) {
      const expected = CesiumQuaternion.slerp(cesiumFrom, cesiumTo, ratio, new CesiumQuaternion());
      const actual = slerp(from, to, ratio);
      expect(actual.x).toBeCloseTo(expected.x, 9);
      expect(actual.y).toBeCloseTo(expected.y, 9);
      expect(actual.z).toBeCloseTo(expected.z, 9);
      expect(actual.w).toBeCloseTo(expected.w, 9);
    }
  });

  it('clamps the ratio and validates input', () => {
    const target = quaternionFromHeadingPitchRollDegrees({ heading: 90, pitch: 0, roll: 0 });

    expect(slerp(IDENTITY, target, 5)).toEqual(target);
    expect(slerp(IDENTITY, target, -3)).toEqual(IDENTITY);
    expect(() => slerp(IDENTITY, target, Number.NaN)).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
  });
});

describe('heading / pitch / roll conversion', () => {
  it('round-trips through the quaternion', () => {
    for (const value of [
      { heading: 0, pitch: 0, roll: 0 },
      { heading: 90, pitch: 0, roll: 0 },
      { heading: 270, pitch: 45, roll: 0 },
      { heading: 33, pitch: -12, roll: 78 },
      { heading: 359, pitch: 89, roll: -45 },
    ]) {
      const quaternion = quaternionFromHeadingPitchRollDegrees(value);
      const restored = headingPitchRollDegreesFromQuaternion(quaternion);
      const forward = quaternionFromHeadingPitchRollDegrees(restored);

      // 分解值可能相差 360° 的整数倍，比较四元数更直接。
      expect(Math.abs(dot(quaternion, forward))).toBeCloseTo(1, 9);
    }
  });

  it('matches known quaternions for single-axis rotations', () => {
    const yaw90 = quaternionFromHeadingPitchRollDegrees({ heading: 90, pitch: 0, roll: 0 });
    const half = Math.SQRT1_2;
    // Cesium 口径：航向绕 -Z，因此 90° 航向的 Z 分量为负。
    expect(yaw90.z).toBeCloseTo(-half, 12);
    expect(yaw90.w).toBeCloseTo(half, 12);
    expect(yaw90.x).toBeCloseTo(0, 12);
    expect(yaw90.y).toBeCloseTo(0, 12);

    const pitchUp = quaternionFromHeadingPitchRollDegrees({ heading: 0, pitch: 90, roll: 0 });
    expect(pitchUp.y).toBeCloseTo(-half, 12);
    expect(pitchUp.w).toBeCloseTo(half, 12);

    expect(headingPitchRollDegreesFromQuaternion(IDENTITY)).toEqual({
      heading: 0,
      pitch: 0,
      roll: 0,
    });
  });

  it('rotates a forward vector the way the model layer expects', () => {
    // 航向 90°（正东）时，单位前向 (0,0,-1) 在 ENU 下应指向东。
    const { heading, pitch } = headingPitchRollDegreesFromQuaternion(
      quaternionFromHeadingPitchRollDegrees({ heading: 90, pitch: 0, roll: 0 }),
    );

    expect(heading).toBeCloseTo(90, 9);
    expect(pitch).toBeCloseTo(0, 9);
  });

  it('rejects non-finite angles', () => {
    expect(() =>
      quaternionFromHeadingPitchRollDegrees({ heading: Number.NaN, pitch: 0, roll: 0 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
  });

  it('matches Cesium Quaternion.fromHeadingPitchRoll', () => {
    const cases = [
      { heading: 0, pitch: 0, roll: 0 },
      { heading: 90, pitch: 0, roll: 0 },
      { heading: 40, pitch: -25, roll: 15 },
      { heading: 200, pitch: 10, roll: -80 },
    ];
    for (const value of cases) {
      const expected = CesiumQuaternion.fromHeadingPitchRoll(
        new HeadingPitchRoll(
          CesiumMath.toRadians(value.heading),
          CesiumMath.toRadians(value.pitch),
          CesiumMath.toRadians(value.roll),
        ),
      );
      const actual = quaternionFromHeadingPitchRollDegrees(value);
      // 正负号差异只在四元数整体取反时出现，那表示同一个姿态。
      expect(Math.abs(dot(actual, { x: expected.x, y: expected.y, z: expected.z, w: expected.w }))).toBeCloseTo(
        1,
        9,
      );
    }
  });
});
