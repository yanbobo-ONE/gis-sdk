import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SNAP_PIXEL_TOLERANCE,
  MAX_SNAP_PIXEL_TOLERANCE,
  findSnapTarget,
  resolveSnapOptions,
  segmentsOf,
} from '../src/core/drawing-snap.js';
import type { SnapSegment, SnapVertex } from '../src/core/drawing-snap.js';

const vertex = (longitude: number, latitude: number, x: number, y: number): SnapVertex => ({
  position: { longitude, latitude },
  screen: { x, y },
});

describe('resolveSnapOptions', () => {
  it('fills in the documented defaults', () => {
    expect(resolveSnapOptions()).toMatchObject({
      pixelTolerance: DEFAULT_SNAP_PIXEL_TOLERANCE,
      includeEdges: false,
    });
    expect(resolveSnapOptions({ pixelTolerance: 20, includeEdges: true })).toMatchObject({
      pixelTolerance: 20,
      includeEdges: true,
    });
  });

  it('rejects out-of-range tolerances', () => {
    expect(() => resolveSnapOptions({ pixelTolerance: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_DRAWING_INPUT' }),
    );
    expect(() => resolveSnapOptions({ pixelTolerance: MAX_SNAP_PIXEL_TOLERANCE + 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_DRAWING_INPUT' }),
    );
    expect(() => resolveSnapOptions({ pixelTolerance: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_DRAWING_INPUT' }),
    );
  });
});

describe('findSnapTarget', () => {
  const vertices = [vertex(1, 1, 100, 100), vertex(2, 2, 105, 100)];

  it('snaps to the nearest vertex inside the tolerance', () => {
    const hit = findSnapTarget(vertices, [], { x: 103, y: 101 });

    // 光标到 (105,100) 的距离 √5 小于到 (100,100) 的 √10。
    expect(hit).toEqual({
      kind: 'vertex',
      position: { longitude: 2, latitude: 2 },
      distancePixels: Math.hypot(2, 1),
    });
  });

  it('returns nothing outside the tolerance', () => {
    expect(findSnapTarget(vertices, [], { x: 200, y: 200 })).toBeUndefined();
    expect(findSnapTarget([], [], { x: 0, y: 0 })).toBeUndefined();
  });

  it('prefers a vertex even when a segment is closer', () => {
    const segments: SnapSegment[] = [
      {
        from: { longitude: 10, latitude: 10 },
        fromScreen: { x: 0, y: 120 },
        to: { longitude: 20, latitude: 10 },
        toScreen: { x: 200, y: 120 },
      },
    ];

    const hit = findSnapTarget(vertices, segments, { x: 100, y: 104 }, { includeEdges: true });

    expect(hit?.kind).toBe('vertex');
    expect(hit?.position).toEqual({ longitude: 1, latitude: 1 });
  });

  it('snaps to a segment only when edges are enabled', () => {
    const segments: SnapSegment[] = [
      {
        from: { longitude: 10, latitude: 10, height: 0 },
        fromScreen: { x: 0, y: 120 },
        to: { longitude: 20, latitude: 10, height: 100 },
        toScreen: { x: 200, y: 120 },
      },
    ];

    expect(findSnapTarget([], segments, { x: 100, y: 118 })).toBeUndefined();

    const hit = findSnapTarget([], segments, { x: 100, y: 118 }, { includeEdges: true });
    expect(hit?.kind).toBe('edge');
    expect(hit?.position.longitude).toBeCloseTo(15, 9);
    expect(hit?.position.latitude).toBeCloseTo(10, 9);
    // 屏幕中点对应高度中值 50。
    expect(hit?.position.height).toBeCloseTo(50, 9);
    expect(hit?.distancePixels).toBeCloseTo(2, 9);
  });

  it('clamps the projection to the segment ends', () => {
    const segments: SnapSegment[] = [
      {
        from: { longitude: 0, latitude: 0 },
        fromScreen: { x: 0, y: 0 },
        to: { longitude: 1, latitude: 0 },
        toScreen: { x: 100, y: 0 },
      },
    ];

    // 光标在起点外侧：吸附点应落在起点，而不是继续外延。
    const hit = findSnapTarget([], segments, { x: -5, y: 0 }, { includeEdges: true });
    expect(hit?.position).toEqual({ longitude: 0, latitude: 0, height: 0 });
  });

  it('handles the shortest arc when interpolating longitudes', () => {
    const segments: SnapSegment[] = [
      {
        from: { longitude: 179, latitude: 0 },
        fromScreen: { x: 0, y: 0 },
        to: { longitude: -179, latitude: 0 },
        toScreen: { x: 100, y: 0 },
      },
    ];

    const hit = findSnapTarget([], segments, { x: 50, y: 0 }, { includeEdges: true });
    // 中间应该是 180（或 -180），而不是 0。
    expect(Math.abs(hit?.position.longitude ?? 0)).toBeCloseTo(180, 9);
  });

  it('honours a custom distance measure', () => {
    const strict = findSnapTarget(
      vertices,
      [],
      { x: 103, y: 101 },
      { distance: () => 999 },
    );
    expect(strict).toBeUndefined();
  });

  it('validates the cursor coordinates', () => {
    expect(() => findSnapTarget(vertices, [], { x: Number.NaN, y: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_DRAWING_INPUT' }),
    );
  });
});

describe('segmentsOf', () => {
  it('builds adjacent segments from a vertex list', () => {
    const segments = segmentsOf([vertex(0, 0, 0, 0), vertex(1, 0, 10, 0), vertex(2, 0, 20, 0)]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.toScreen).toEqual({ x: 10, y: 0 });
    expect(segments[1]?.from).toEqual({ longitude: 1, latitude: 0 });
    expect(segmentsOf([vertex(0, 0, 0, 0)])).toEqual([]);
  });
});
