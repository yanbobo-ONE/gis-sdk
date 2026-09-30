import { describe, expect, it } from 'vitest';

import { tracksFromCzml } from '../src/core/czml.js';
import { createTrackTimeline, sampleTrackPose } from '../src/core/czml-track.js';
import { headingPitchRollDegreesFromQuaternion } from '../src/spatial/attitude.js';

const epoch = '2026-09-30T00:00:00Z';

const document = [
  { id: 'document', version: '1.0' },
  {
    id: 'sat-1',
    position: { epoch, cartographicDegrees: [0, 10, 20, 30, 10, 20, 30, 40] },
    orientation: {
      epoch,
      // 0s：正北下方；10s：航向 90°
      unitQuaternion: [0, 0, 0, 0, 1, 10, 0, 0, -Math.SQRT1_2, Math.SQRT1_2],
    },
  },
];

describe('createTrackTimeline', () => {
  it('interpolates positions along the shortest arc and slerps attitudes', () => {
    const track = tracksFromCzml(document)[0];
    if (!track) {
      throw new Error('track missing');
    }
    const timeline = createTrackTimeline(track);

    const start = sampleTrackPose(timeline, 'sat-1', 0);
    expect(start?.position).toEqual({ longitude: 10, latitude: 20, height: 30 });

    const middle = sampleTrackPose(timeline, 'sat-1', 5);
    expect(middle?.position.longitude).toBeCloseTo(15, 9);
    expect(middle?.position.latitude).toBeCloseTo(25, 9);
    expect(middle?.position.height).toBeCloseTo(35, 9);
    // 姿态是两端之间的插值：航向应该落在 0 与 90 之间。
    const heading = middle ? headingPitchRollDegreesFromQuaternion(middle.attitude ?? { x: 0, y: 0, z: 0, w: 1 }).heading : 0;
    expect(heading).toBeGreaterThan(1);
    expect(heading).toBeLessThan(89);

    const end = sampleTrackPose(timeline, 'sat-1', 10);
    expect(end?.position).toEqual({ longitude: 20, latitude: 30, height: 40 });
  });

  it('returns undefined outside the sample range by default', () => {
    const track = tracksFromCzml(document)[0];
    if (!track) {
      throw new Error('track missing');
    }
    const timeline = createTrackTimeline(track);

    expect(sampleTrackPose(timeline, 'sat-1', -1)).toBeUndefined();
    expect(sampleTrackPose(timeline, 'sat-1', 11)).toBeUndefined();
    expect(sampleTrackPose(timeline, 'missing', 0)).toBeUndefined();
  });

  it('extrapolates linearly when configured and handles longitudes across the dateline', () => {
    const track = tracksFromCzml([
      { id: 'doc', version: '1.0' },
      { id: 'a', position: { cartographicDegrees: [0, 179, 0, 0, 10, -179, 0, 0] } },
    ])[0];
    if (!track) {
      throw new Error('track missing');
    }

    const bounded = createTrackTimeline(track);
    expect(sampleTrackPose(bounded, 'a', 20)).toBeUndefined();

    const extrapolating = createTrackTimeline(track, { maxExtrapolationSeconds: 20 });
    // 跨 180° 经线：中点应当是 ±180 而不是 0。
    const middle = sampleTrackPose(extrapolating, 'a', 5);
    expect(Math.abs(middle?.position.longitude ?? 0)).toBeCloseTo(180, 6);
    // 继续外推一个步长：179 + 2 × 2 = 183，归一化后是 -177。
    expect(sampleTrackPose(extrapolating, 'a', 20)?.position.longitude).toBeCloseTo(-177, 6);
  });

  it('keeps the single-sided attitude instead of faking a quaternion', () => {
    const track = tracksFromCzml([
      { id: 'doc', version: '1.0' },
      {
        id: 'a',
        position: { cartographicDegrees: [0, 1, 2, 3, 10, 4, 5, 6] },
        orientation: { unitQuaternion: [0, 0, 0, 0, 1] },
      },
    ])[0];
    if (!track) {
      throw new Error('track missing');
    }
    const timeline = createTrackTimeline(track);

    // 只有 0s 有姿态：采样时刻返回各自的真实姿态，中间取更近的一端。
    expect(sampleTrackPose(timeline, 'a', 0)?.attitude).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(sampleTrackPose(timeline, 'a', 10)?.attitude).toBeUndefined();
    expect(sampleTrackPose(timeline, 'a', 4)?.attitude).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(sampleTrackPose(timeline, 'a', 6)?.attitude).toBeUndefined();
    const middle = sampleTrackPose(timeline, 'a', 5);
    expect(middle?.position.longitude).toBeCloseTo(2.5, 9);
  });

  it('rejects an empty track', () => {
    expect(() =>
      createTrackTimeline({ id: 'a', name: undefined, epoch, modelUrl: undefined, samples: [], availability: [] }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_CZML' }));
  });
});
