import { describe, expect, it } from 'vitest';

import type { EnvironmentEffectKind } from '../src/core/environment.js';
import {
  DEPTH_FOG_DEFAULTS,
  EnvironmentTimeline,
  PRECIPITATION_DEFAULTS,
  PRECIPITATION_INTENSITY_DENSITY,
  resolveDepthFogOptions,
  resolveEnvironmentOptions,
  resolveHazeOptions,
  resolvePrecipitationOptions,
} from '../src/core/environment.js';
import { FieldGuard } from '../src/core/field-guard.js';

describe('resolveDepthFogOptions', () => {
  it('fills in the ported defaults', () => {
    expect(resolveDepthFogOptions()).toEqual(DEPTH_FOG_DEFAULTS);
  });

  it('keeps declared values and merges them over the defaults', () => {
    expect(resolveDepthFogOptions({ density: 0.8, color: '#112233' })).toMatchObject({
      density: 0.8,
      color: '#112233',
      endDistanceMeters: DEPTH_FOG_DEFAULTS.endDistanceMeters,
    });
  });

  it('rejects invalid ranges and an inverted distance window', () => {
    expect(() => resolveDepthFogOptions({ density: 1.5 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
    expect(() => resolveDepthFogOptions({ color: '   ' })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
    expect(() =>
      resolveDepthFogOptions({ startDistanceMeters: 5_000, endDistanceMeters: 5_000 }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }));
    expect(() => resolveDepthFogOptions({ brightness: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
  });
});

describe('resolveHazeOptions', () => {
  it('keeps only the declared fields', () => {
    expect(resolveHazeOptions({ density: 0.001 })).toEqual({ density: 0.001 });
    expect(resolveHazeOptions()).toEqual({});
  });

  it('rejects out-of-range fields', () => {
    expect(() => resolveHazeOptions({ heightFalloff: 5 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
    expect(() => resolveHazeOptions({ screenSpaceErrorFactor: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
  });
});

describe('resolvePrecipitationOptions', () => {
  it('fills in the ported defaults', () => {
    expect(resolvePrecipitationOptions()).toEqual(PRECIPITATION_DEFAULTS);
    expect(PRECIPITATION_INTENSITY_DENSITY.heavy).toBeGreaterThan(
      PRECIPITATION_INTENSITY_DENSITY.light,
    );
  });

  it('rejects an unknown intensity and out-of-range fields', () => {
    expect(() => resolvePrecipitationOptions({ intensity: 'storm' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
    expect(() => resolvePrecipitationOptions({ speed: 9 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
    expect(() => resolvePrecipitationOptions({ flakeSize: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
  });
});

describe('resolveEnvironmentOptions', () => {
  it('dispatches by kind', () => {
    expect(resolveEnvironmentOptions('depthFog', { density: 0.5 }).density).toBe(0.5);
    expect(resolveEnvironmentOptions('haze', { maxHeight: 800 }).maxHeight).toBe(800);
    expect(resolveEnvironmentOptions('snow', { intensity: 'heavy' }).intensity).toBe('heavy');
    expect(() => resolveEnvironmentOptions('rain', { windStrength: 2 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
  });

  it('rejects unknown kinds at runtime', () => {
    const kind = 'freeze' as EnvironmentEffectKind;

    expect(() => resolveEnvironmentOptions(kind, {})).toThrow(
      expect.objectContaining({ code: 'INVALID_ENVIRONMENT_CONFIG' }),
    );
  });
});

describe('EnvironmentTimeline', () => {
  it('accumulates bounded real-time deltas', () => {
    const timeline = new EnvironmentTimeline(1_000);

    expect(timeline.advance(1_050)).toBeCloseTo(0.05, 9);
    expect(timeline.advance(1_080)).toBeCloseTo(0.08, 9);
    expect(timeline.seconds).toBeCloseTo(0.08, 9);
  });

  it('caps a single step and ignores backwards or non-finite samples', () => {
    const timeline = new EnvironmentTimeline(0);

    timeline.advance(10_000);
    expect(timeline.seconds).toBe(EnvironmentTimeline.MAX_STEP_SECONDS);
    const after = timeline.seconds;
    expect(timeline.advance(5_000)).toBe(after);
    expect(timeline.advance(Number.NaN)).toBe(after);
  });

  it('starts from the first sample when constructed without one', () => {
    const timeline = new EnvironmentTimeline();

    expect(timeline.advance(500)).toBe(0);
    expect(timeline.advance(600)).toBeCloseTo(0.1, 9);
    timeline.reset();
    expect(timeline.seconds).toBe(0);
    expect(timeline.advance(9_000)).toBe(0);
  });
});

describe('FieldGuard', () => {
  it('writes fields, records originals, and restores them', () => {
    const fog = { density: 1, enabled: true };
    const guard = new FieldGuard(fog);

    expect(guard.set('density', 2)).toBe(true);
    expect(guard.set('density', 2)).toBe(false);
    expect(guard.set('maxHeight', 500)).toBe(true);
    expect(guard.size).toBe(2);
    expect(guard.has('density')).toBe(true);
    expect(guard.get('density')).toBe(2);
    expect(guard.describe()).toEqual([
      { key: 'density', original: 1, last: 2 },
      { key: 'maxHeight', original: undefined, last: 500 },
    ]);

    expect(guard.restore()).toBe(2);
    expect(fog).toEqual({ density: 1, enabled: true });
    expect(guard.size).toBe(0);
  });

  it('does not clobber a value written by someone else after our last write', () => {
    const fog: Record<string, unknown> = { density: 1 };
    const guard = new FieldGuard(fog);
    guard.set('density', 2);
    // 业务在 SDK 生效期间改了同一个字段：恢复时不动它。
    fog.density = 9;

    expect(guard.restore()).toBe(0);
    expect(fog.density).toBe(9);
  });

  it('is a no-op without a target', () => {
    const guard = new FieldGuard(undefined);

    expect(guard.set('density', 1)).toBe(false);
    expect(guard.get('density')).toBeUndefined();
    expect(guard.restore()).toBe(0);
  });

  it('restores only once and reports the count', () => {
    const target: Record<string, unknown> = { density: 1 };
    const guard = new FieldGuard(target);
    guard.set('density', 2);

    expect(guard.restore()).toBe(1);
    expect(guard.restore()).toBe(0);
    expect(target.density).toBe(1);
  });
});
