import { describe, expect, it } from 'vitest';

import {
  curvatureDropMeters,
  evaluateHorizon,
  evaluateLineOfSight,
  normalizeBearing,
  slopeAspectFromPlane,
  surfacePathLength,
} from '../src/spatial/terrain-profile.js';

const profile = (points: readonly (readonly [number, number])[]) =>
  points.map(([distanceMeters, heightMeters]) => ({ distanceMeters, heightMeters }));

describe('evaluateLineOfSight', () => {
  it('reports visibility and the minimum clearance over the profile', () => {
    const evaluation = evaluateLineOfSight({
      fromHeightMeters: 100,
      toHeightMeters: 100,
      distanceMeters: 1_000,
      profile: profile([
        [250, 20],
        [500, 40],
        [750, 20],
      ]),
    });

    expect(evaluation.visible).toBe(true);
    // 中点处直线高 100、地面 40，余隙 60 是最小值。
    expect(evaluation.minClearanceMeters).toBeCloseTo(60, 9);
    expect(evaluation.blockedAtIndex).toBeUndefined();
    expect(evaluation.sampleCount).toBe(3);
  });

  it('blocks when a ridge cuts the line and points at the first blocker', () => {
    const evaluation = evaluateLineOfSight({
      fromHeightMeters: 100,
      toHeightMeters: 100,
      distanceMeters: 1_000,
      profile: profile([
        [250, 20],
        [500, 260],
        [750, 20],
      ]),
    });

    expect(evaluation.visible).toBe(false);
    expect(evaluation.blockedAtIndex).toBe(1);
    expect(evaluation.minClearanceMeters).toBeCloseTo(-160, 9);
  });

  it('honours the clearance tolerance and skips samples without terrain data', () => {
    const borderline = {
      fromHeightMeters: 100,
      toHeightMeters: 100,
      distanceMeters: 1_000,
      profile: profile([[500, 105]]),
    };

    expect(evaluateLineOfSight(borderline).visible).toBe(false);
    expect(evaluateLineOfSight({ ...borderline, clearanceToleranceMeters: 10 }).visible).toBe(true);

    const withGaps = evaluateLineOfSight({
      ...borderline,
      profile: [
        { distanceMeters: 250, heightMeters: Number.NaN },
        { distanceMeters: 500, heightMeters: 20 },
        { distanceMeters: 750, heightMeters: 20 },
      ],
    });
    expect(withGaps.sampleCount).toBe(2);
    expect(withGaps.visible).toBe(true);
  });

  it('drops the line below the ground when curvature is enabled', () => {
    const input = {
      fromHeightMeters: 30,
      toHeightMeters: 30,
      distanceMeters: 20_000,
      profile: profile([[10_000, 0]]),
    };

    expect(evaluateLineOfSight(input).visible).toBe(true);
    // 10 km 处的采样点：曲率把地面压低约 10000²/(2R) ≈ 7.8 米，余隙因此变大。
    const curved = evaluateLineOfSight({
      ...input,
      fromHeightMeters: 10,
      toHeightMeters: 10,
      applyEarthCurvature: true,
    });
    expect(curved.minClearanceMeters).toBeCloseTo(10 + curvatureDropMeters(10_000), 6);
    expect(curvatureDropMeters(10_000)).toBeGreaterThan(7);
  });

  it('falls back to endpoint comparison for an empty or zero-length profile', () => {
    expect(
      evaluateLineOfSight({
        fromHeightMeters: 10,
        toHeightMeters: 20,
        distanceMeters: 100,
        profile: [],
      }),
    ).toEqual({
      visible: true,
      minClearanceMeters: 10,
      blockedAtIndex: undefined,
      sampleCount: 0,
    });
    expect(
      evaluateLineOfSight({
        fromHeightMeters: 20,
        toHeightMeters: 10,
        distanceMeters: 0,
        profile: [],
      }),
    ).toMatchObject({ visible: false, sampleCount: 0, blockedAtIndex: 0 });
  });

  it('rejects non-finite inputs', () => {
    expect(() =>
      evaluateLineOfSight({
        fromHeightMeters: Number.NaN,
        toHeightMeters: 0,
        distanceMeters: 1,
        profile: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
  });
});

describe('evaluateHorizon', () => {
  it('keeps the running elevation envelope and reports the first occluded distance', () => {
    const evaluation = evaluateHorizon({
      observerHeightMeters: 1_000,
      profile: profile([
        [500, 900],
        [1_000, 1_100],
        [1_500, 1_050],
        [2_000, 1_080],
      ]),
    });

    // 第二个点在包络之上（可见），第三个点掉到包络之下（首个遮挡）；
    // 第四个点虽然更高，但仰角仍低于第二个点形成的包络，同样被遮挡。
    expect(evaluation.visibleDistanceMeters).toBe(1_000);
    expect(evaluation.blockedDistanceMeters).toBe(1_500);
  });

  it('sees the whole profile when terrain rises away from the observer', () => {
    const evaluation = evaluateHorizon({
      observerHeightMeters: 0,
      profile: profile([
        [100, 10],
        [200, 30],
        [300, 60],
      ]),
    });

    expect(evaluation.visibleDistanceMeters).toBe(300);
    expect(evaluation.blockedDistanceMeters).toBeUndefined();
  });

  it('validates that distances increase and are positive', () => {
    expect(() =>
      evaluateHorizon({
        observerHeightMeters: 0,
        profile: profile([
          [100, 0],
          [100, 5],
        ]),
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
  });
});

describe('slopeAspectFromPlane', () => {
  const ring = (a: number, b: number, c = 0) =>
    [0, 45, 90, 135, 180, 225, 270, 315].map((bearing) => {
      const radians = (bearing * Math.PI) / 180;
      const east = 100 * Math.sin(radians);
      const north = 100 * Math.cos(radians);
      return { eastMeters: east, northMeters: north, heightMeters: a * east + b * north + c };
    });

  it('fits a plane rising to the east and points the aspect downhill', () => {
    const result = slopeAspectFromPlane(ring(1, 0));

    expect(result.slopeDegrees).toBeCloseTo(45, 6);
    expect(result.aspectDegrees).toBeCloseTo(270, 6);
  });

  it('handles a slope rising to the north and an oblique slope', () => {
    expect(slopeAspectFromPlane(ring(0, 1)).aspectDegrees).toBeCloseTo(180, 6);

    const oblique = slopeAspectFromPlane(ring(0.5, 0.25));
    expect(oblique.slopeDegrees).toBeCloseTo((Math.atan(Math.hypot(0.5, 0.25)) * 180) / Math.PI, 6);
    expect(oblique.aspectDegrees).toBeCloseTo(243.4349, 3);
  });

  it('returns zero aspect for flat ground and rejects degenerate input', () => {
    expect(slopeAspectFromPlane(ring(0, 0, 7))).toEqual({ slopeDegrees: 0, aspectDegrees: 0 });

    expect(() => slopeAspectFromPlane(ring(1, 0).slice(0, 2))).toThrow(
      expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }),
    );
    expect(() =>
      slopeAspectFromPlane([
        { eastMeters: 0, northMeters: 0, heightMeters: 0 },
        { eastMeters: 10, northMeters: 0, heightMeters: 1 },
        { eastMeters: 20, northMeters: 0, heightMeters: 2 },
      ]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
  });
});

describe('surfacePathLength and normalizeBearing', () => {
  it('adds three-dimensional segment lengths', () => {
    expect(
      surfacePathLength([
        { horizontalDistanceMeters: 3, fromHeightMeters: 0, toHeightMeters: 4 },
        { horizontalDistanceMeters: 0, fromHeightMeters: 4, toHeightMeters: 4 },
      ]),
    ).toBeCloseTo(5, 9);
  });

  it('rejects negative horizontal distances', () => {
    expect(() =>
      surfacePathLength([{ horizontalDistanceMeters: -1, fromHeightMeters: 0, toHeightMeters: 0 }]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_SPATIAL_INPUT' }));
  });

  it('wraps bearings into [0, 360)', () => {
    expect(normalizeBearing(-90)).toBe(270);
    expect(normalizeBearing(450)).toBeCloseTo(90, 9);
    expect(curvatureDropMeters(0)).toBe(0);
  });
});
