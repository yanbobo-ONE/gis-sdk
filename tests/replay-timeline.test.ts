import { describe, expect, it } from 'vitest';

import { ReplayTimeline } from '../src/core/replay-timeline.js';

interface Track {
  readonly time: number;
  readonly x: number;
}

const linear = (previous: Track, next: Track, ratio: number): Track => ({
  time: previous.time + (next.time - previous.time) * ratio,
  x: previous.x + (next.x - previous.x) * ratio,
});

describe('ReplayTimeline', () => {
  it('sorts by time and replaces samples written at the same time', () => {
    const timeline = new ReplayTimeline<Track>({ interpolate: linear });

    timeline.addSample('a', { time: 2, x: 20 });
    timeline.addSample('a', { time: 0, x: 0 });
    timeline.addSample('a', { time: 1, x: 10 });
    timeline.addSample('a', { time: 1, x: 11 });

    expect(timeline.count('a')).toBe(3);
    expect(timeline.sampleAt('a', 1)).toEqual({ time: 1, x: 11 });
    expect(timeline.keys).toEqual(['a']);
    expect(timeline.range).toEqual({ startTime: 0, endTime: 2 });
  });

  it('adds batches and drops the oldest samples beyond the capacity', () => {
    const timeline = new ReplayTimeline<Track>({ maxSamplesPerKey: 3 });

    timeline.addSamples('a', [
      { time: 3, x: 3 },
      { time: 1, x: 1 },
      { time: 4, x: 4 },
      { time: 2, x: 2 },
      { time: 5, x: 5 },
    ]);

    expect(timeline.count('a')).toBe(3);
    expect(timeline.range).toEqual({ startTime: 3, endTime: 5 });
    expect(timeline.latest('a', 2)).toBeUndefined();
  });

  it('interpolates between samples and falls back to the previous sample without an interpolator', () => {
    const timeline = new ReplayTimeline<Track>({ interpolate: linear });
    timeline.addSamples('a', [
      { time: 0, x: 0 },
      { time: 10, x: 100 },
    ]);

    expect(timeline.sampleAt('a', 2.5)).toEqual({ time: 2.5, x: 25 });

    const plain = new ReplayTimeline<Track>();
    plain.addSamples('a', [
      { time: 0, x: 0 },
      { time: 10, x: 100 },
    ]);
    expect(plain.sampleAt('a', 2.5)).toEqual({ time: 0, x: 0 });
    expect(plain.latest('a', 0.5)).toEqual({ time: 0, x: 0 });
    expect(plain.latest('a', -1)).toBeUndefined();
  });

  it('does not fabricate samples outside the window unless extrapolation is enabled', () => {
    const timeline = new ReplayTimeline<Track>({ interpolate: linear });
    timeline.addSamples('a', [
      { time: 10, x: 0 },
      { time: 20, x: 10 },
    ]);

    expect(timeline.sampleAt('a', 5)).toBeUndefined();
    expect(timeline.sampleAt('a', 25)).toBeUndefined();

    const extrapolating = new ReplayTimeline<Track>({
      interpolate: linear,
      maxExtrapolationSeconds: 10,
    });
    extrapolating.addSamples('a', [
      { time: 10, x: 0 },
      { time: 20, x: 10 },
    ]);

    expect(extrapolating.sampleAt('a', 25)).toEqual({ time: 25, x: 15 });
    expect(extrapolating.sampleAt('a', 5)).toEqual({ time: 5, x: -5 });
    expect(extrapolating.sampleAt('a', 35)).toBeUndefined();
  });

  it('windows samples inclusively and derives track windows', () => {
    const timeline = new ReplayTimeline<Track>({ trackWindowSeconds: 5 });
    timeline.addSamples('a', [
      { time: 0, x: 0 },
      { time: 1, x: 1 },
      { time: 2, x: 2 },
      { time: 8, x: 8 },
    ]);

    expect(timeline.window('a', 0, 2).map((sample) => sample.time)).toEqual([0, 1, 2]);
    expect(timeline.window('a', 2.5, 2.6)).toEqual([]);
    expect(timeline.window('a', 5, 1)).toEqual([]);
    expect(timeline.trackAt('a', 8).map((sample) => sample.time)).toEqual([8]);
    expect(timeline.trackAt('a', 8, 20).map((sample) => sample.time)).toEqual([0, 1, 2, 8]);
  });

  it('is scoped per key and clears by key or entirely', () => {
    const timeline = new ReplayTimeline<Track>();
    timeline.addSample('a', { time: 0, x: 0 });
    timeline.addSample('b', { time: 5, x: 5 });

    expect(timeline.has('a')).toBe(true);
    expect(timeline.sampleAt('b', 5)).toEqual({ time: 5, x: 5 });
    expect(timeline.size).toBe(2);

    timeline.clear('a');
    expect(timeline.has('a')).toBe(false);
    expect(timeline.range).toEqual({ startTime: 5, endTime: 5 });

    timeline.clear();
    expect(timeline.size).toBe(0);
    expect(timeline.range).toEqual({ startTime: undefined, endTime: undefined });
  });

  it('clones returned samples when a clone function is provided', () => {
    const timeline = new ReplayTimeline<Track>({ clone: (sample) => ({ ...sample }) });
    const stored = { time: 1, x: 1 };
    timeline.addSample('a', stored);

    const returned = timeline.sampleAt('a', 1);
    expect(returned).toEqual(stored);
    expect(returned).not.toBe(stored);
  });

  it('validates configuration, samples, and query times', () => {
    expect(() => new ReplayTimeline({ maxSamplesPerKey: 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REPLAY_INPUT' }),
    );
    expect(() => new ReplayTimeline({ maxExtrapolationSeconds: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REPLAY_INPUT' }),
    );

    const timeline = new ReplayTimeline<Track>();
    expect(() => {
      timeline.addSample('a', { time: Number.NaN, x: 1 });
    }).toThrow(expect.objectContaining({ code: 'INVALID_REPLAY_INPUT', operation: 'addSample' }));
    expect(() => {
      timeline.addSample('a', undefined as unknown as Track);
    }).toThrow(expect.objectContaining({ code: 'INVALID_REPLAY_INPUT' }));
    expect(() => timeline.sampleAt('a', Number.POSITIVE_INFINITY)).toThrow(
      expect.objectContaining({ code: 'INVALID_REPLAY_INPUT' }),
    );
    expect(timeline.count('missing')).toBe(0);
    expect(timeline.sampleAt('missing', 0)).toBeUndefined();
    expect(timeline.latest('missing', 0)).toBeUndefined();
  });
});
