import { describe, expect, it, vi } from 'vitest';

import type { DrawGeometry } from '../src/core/drawing.js';
import {
  DrawingEditMachine,
  isEditableGeometry,
  isValidDrawPosition,
} from '../src/core/drawing-edit.js';

function createPort(geometry?: DrawGeometry) {
  let stored = geometry;
  const store = {
    get: vi.fn((id: string) => (id === 'target' ? stored : undefined)),
    update: vi.fn((next: DrawGeometry) => {
      stored = next;
    }),
  };
  return {
    store,
    read: () => stored,
    write: (next: DrawGeometry) => {
      stored = next;
    },
  };
}

const polyline = (): DrawGeometry => ({
  mode: 'polyline',
  positions: [
    { longitude: 10, latitude: 20 },
    { longitude: 11, latitude: 21 },
    { longitude: 12, latitude: 22 },
  ],
});

const point = (): DrawGeometry => ({ mode: 'point', positions: [{ longitude: 1, latitude: 2 }] });

describe('DrawingEditMachine', () => {
  it('requires a valid vertex index for multi-vertex geometry', () => {
    const port = createPort(polyline());
    const machine = new DrawingEditMachine(port.store);

    expect(machine.begin({ id: 'target' })).toBe(false);
    expect(machine.begin({ id: 'target', vertexIndex: 3 })).toBe(false);
    expect(machine.begin({ id: 'target', vertexIndex: -1 })).toBe(false);
    expect(machine.begin({ id: 'target', vertexIndex: 1.5 })).toBe(false);
    expect(machine.begin({ id: 'missing', vertexIndex: 0 })).toBe(false);
    expect(machine.begin({ id: 'target', vertexIndex: 1 })).toBe(true);
    expect(machine.snapshot).toEqual({
      id: 'target',
      vertexIndex: 1,
      geometry: polyline(),
    });
  });

  it('rejects a vertex index on single-vertex geometry', () => {
    const port = createPort(point());
    const machine = new DrawingEditMachine(port.store);

    expect(machine.begin({ id: 'target', vertexIndex: 0 })).toBe(false);
    expect(machine.begin({ id: 'target' })).toBe(true);
    expect(machine.snapshot?.vertexIndex).toBeUndefined();
  });

  it('moves a single vertex and reports the change', () => {
    const port = createPort(polyline());
    const onChange = vi.fn<(geometry: DrawGeometry) => void>();
    const machine = new DrawingEditMachine(port.store, onChange);
    machine.begin({ id: 'target', vertexIndex: 1 });

    const moved = machine.move({ longitude: 100, latitude: 30, height: 500 });

    expect(moved?.positions).toEqual([
      { longitude: 10, latitude: 20 },
      { longitude: 100, latitude: 30, height: 500 },
      { longitude: 12, latitude: 22 },
    ]);
    expect(port.read()?.positions[1]).toEqual({ longitude: 100, latitude: 30, height: 500 });
    expect(onChange).toHaveBeenCalledTimes(1);

    // 回调拿到的是副本：调用方改动不会污染端口里的几何。
    const reported = onChange.mock.calls[0]?.[0];
    expect(reported).not.toBe(port.read());
  });

  it('moves the whole point geometry', () => {
    const port = createPort(point());
    const machine = new DrawingEditMachine(port.store);
    machine.begin({ id: 'target' });

    const moved = machine.move({ longitude: 8, latitude: 9 });

    expect(moved).toEqual({ mode: 'point', positions: [{ longitude: 8, latitude: 9 }] });
  });

  it('ignores invalid drop positions instead of aborting the session', () => {
    const port = createPort(polyline());
    const onChange = vi.fn<(geometry: DrawGeometry) => void>();
    const machine = new DrawingEditMachine(port.store, onChange);
    machine.begin({ id: 'target', vertexIndex: 0 });

    expect(machine.move({ longitude: Number.NaN, latitude: 0 })).toBeUndefined();
    expect(machine.move({ longitude: 0, latitude: 91 })).toBeUndefined();
    expect(machine.move({ longitude: 181, latitude: 0 })).toBeUndefined();
    expect(machine.move({ longitude: 1, latitude: 2, height: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
    expect(port.read()).toEqual(polyline());
    expect(machine.snapshot?.vertexIndex).toBe(0);
  });

  it('ignores move and end without an active session', () => {
    const port = createPort(polyline());
    const onCommit = vi.fn<(geometry: DrawGeometry) => void>();
    const machine = new DrawingEditMachine(port.store, undefined, onCommit);

    expect(machine.snapshot).toBeUndefined();
    expect(machine.move({ longitude: 1, latitude: 2 })).toBeUndefined();
    expect(machine.end()).toBeUndefined();
    expect(machine.cancel()).toBeUndefined();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits the edited geometry and clears the session', () => {
    const port = createPort(polyline());
    const onCommit = vi.fn<(geometry: DrawGeometry) => void>();
    const machine = new DrawingEditMachine(port.store, undefined, onCommit);
    machine.begin({ id: 'target', vertexIndex: 2 });
    machine.move({ longitude: 30, latitude: 40 });

    const committed = machine.end();

    expect(committed?.positions[2]).toEqual({ longitude: 30, latitude: 40 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(machine.snapshot).toBeUndefined();
    expect(machine.move({ longitude: 1, latitude: 1 })).toBeUndefined();
  });

  it('restores the snapshot on cancel', () => {
    const port = createPort(polyline());
    const onCancel = vi.fn<(geometry: DrawGeometry) => void>();
    const machine = new DrawingEditMachine(port.store, undefined, undefined, onCancel);
    machine.begin({ id: 'target', vertexIndex: 0 });
    machine.move({ longitude: 90, latitude: 45 });

    const restored = machine.cancel();

    expect(restored).toEqual(polyline());
    expect(port.read()).toEqual(polyline());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(machine.snapshot).toBeUndefined();
  });

  it('drops the session on dispose and refuses further edits', () => {
    const port = createPort(polyline());
    const machine = new DrawingEditMachine(port.store);
    machine.begin({ id: 'target', vertexIndex: 0 });

    machine.dispose();
    machine.dispose();

    expect(machine.begin({ id: 'target', vertexIndex: 0 })).toBe(false);
    expect(machine.move({ longitude: 1, latitude: 2 })).toBeUndefined();
    expect(machine.cancel()).toBeUndefined();
    // dispose 不回滚几何，保留最后一次拖动结果。
    expect(() => {
      machine.assertActive();
    }).toThrow(expect.objectContaining({ code: 'INVALID_DRAWING_INPUT' }));
  });
});

describe('isValidDrawPosition', () => {
  it('accepts finite in-range positions and rejects everything else', () => {
    expect(isValidDrawPosition({ longitude: -180, latitude: 90 })).toBe(true);
    expect(isValidDrawPosition({ longitude: 180, latitude: -90, height: -100 })).toBe(true);
    expect(isValidDrawPosition({ longitude: 181, latitude: 0 })).toBe(false);
    expect(isValidDrawPosition({ longitude: 0, latitude: 90.5 })).toBe(false);
    expect(isValidDrawPosition({ longitude: Number.NaN, latitude: 0 })).toBe(false);
    expect(isValidDrawPosition({ longitude: 0, latitude: 0, height: Number.NaN })).toBe(false);
    expect(isValidDrawPosition({ longitude: 0 })).toBe(false);
    expect(isValidDrawPosition(undefined)).toBe(false);
    expect(isValidDrawPosition(null)).toBe(false);
    expect(isValidDrawPosition('1,2')).toBe(false);
  });
});

describe('isEditableGeometry', () => {
  it('accepts every mode with at least one valid vertex', () => {
    expect(isEditableGeometry(point())).toBe(true);
    expect(isEditableGeometry(polyline())).toBe(true);
    expect(isEditableGeometry({ mode: 'polygon', positions: polyline().positions })).toBe(true);
  });

  it('rejects unknown modes, empty vertex lists, and invalid vertices', () => {
    expect(isEditableGeometry({ mode: 'circle', positions: [{ longitude: 1, latitude: 2 }] })).toBe(
      false,
    );
    expect(isEditableGeometry({ mode: 'point', positions: [] })).toBe(false);
    expect(
      isEditableGeometry({ mode: 'polyline', positions: [{ longitude: Number.NaN, latitude: 0 }] }),
    ).toBe(false);
    expect(isEditableGeometry({ mode: 'point' })).toBe(false);
    expect(isEditableGeometry(undefined)).toBe(false);
    expect(isEditableGeometry({})).toBe(false);
  });
});
