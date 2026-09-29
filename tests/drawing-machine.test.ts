import { describe, expect, it, vi } from 'vitest';

import { DrawingStateMachine } from '../src/core/drawing.js';
import type { DrawRenderValue } from '../src/core/drawing.js';
import type { GeoPosition } from '../src/core/controls.js';

const point = (longitude: number, latitude: number): GeoPosition => ({ longitude, latitude });

function createRenderer() {
  const renders: DrawRenderValue[] = [];
  let previews = 0;
  const completed: DrawRenderValue[] = [];
  return {
    renders,
    previewCount: () => previews,
    completedRenders: completed,
    port: {
      renderPreview: vi.fn((value: DrawRenderValue) => {
        previews += 1;
        renders.push(value);
        return { kind: 'preview' as const, value };
      }),
      renderCompleted: vi.fn((value: DrawRenderValue) => {
        completed.push(value);
        renders.push(value);
        return { kind: 'completed' as const, value };
      }),
      removePreview: vi.fn(),
      removeCompleted: vi.fn(),
    },
  };
}

describe('DrawingStateMachine', () => {
  it('completes point mode on the first vertex', () => {
    const renderer = createRenderer();
    const completed: unknown[] = [];
    const machine = new DrawingStateMachine(renderer.port, (geometry) => completed.push(geometry));

    expect(machine.start('point')).toBe(true);
    expect(machine.mode).toBe('point');

    const geometry = machine.addVertex(point(116.39, 39.9));

    expect(geometry).toEqual({ mode: 'point', positions: [point(116.39, 39.9)] });
    expect(completed).toEqual([geometry]);
    expect(machine.mode).toBeUndefined();
    expect(machine.drawing).toBe(false);
    expect(renderer.completedRenders).toHaveLength(1);
  });

  it('accumulates vertices and previews for polyline and polygon modes', () => {
    const renderer = createRenderer();
    const machine = new DrawingStateMachine(renderer.port);

    machine.start('polyline');
    machine.previewPositions(point(1, 1));
    // 还没有确定顶点时不渲染预览。
    expect(renderer.previewCount()).toBe(0);

    machine.addVertex(point(1, 1));
    machine.addVertex(point(2, 2));
    expect(machine.vertexCount).toBe(2);

    machine.previewPositions(point(3, 3));
    expect(renderer.previewCount()).toBe(1);
    const preview = renderer.renders.at(-1);
    expect(preview).toMatchObject({ mode: 'polyline', preview: true });
    expect(preview?.positions).toHaveLength(3);

    // 再次预览会先移除上一帧。
    machine.previewPositions(point(4, 4));
    expect(renderer.port.removePreview).toHaveBeenCalledTimes(1);
    expect(renderer.renders.at(-1)?.positions.at(-1)).toEqual(point(4, 4));

    // 点模式没有预览。
    machine.start('point');
    machine.previewPositions(point(5, 5));
    expect(renderer.previewCount()).toBe(2);
  });

  it('requires the minimum vertex count before finishing', () => {
    const renderer = createRenderer();
    const machine = new DrawingStateMachine(renderer.port);

    machine.start('polyline');
    machine.addVertex(point(1, 1));
    expect(machine.finish()).toBeUndefined();
    expect(machine.drawing).toBe(true);

    // 收尾位置会并入几何：1 个已确定顶点 + 收尾点 = 2 个。
    const geometry = machine.finish(point(2, 2));
    expect(geometry).toEqual({ mode: 'polyline', positions: [point(1, 1), point(2, 2)] });
    expect(machine.drawing).toBe(false);

    machine.start('polygon');
    machine.addVertex(point(1, 1));
    machine.addVertex(point(2, 2));
    expect(machine.finish()).toBeUndefined();
    expect(machine.finish(point(3, 3))?.positions).toHaveLength(3);
  });

  it('ignores invalid vertices and unsupported modes', () => {
    const renderer = createRenderer();
    const machine = new DrawingStateMachine(renderer.port);

    expect(machine.start('circle' as never)).toBe(false);
    expect(machine.drawing).toBe(false);

    machine.start('polyline');
    expect(machine.addVertex({ longitude: Number.NaN, latitude: 0 })).toBeUndefined();
    expect(machine.addVertex({ longitude: 181, latitude: 0 })).toBeUndefined();
    expect(machine.addVertex({ longitude: 0, latitude: 91 })).toBeUndefined();
    expect(machine.vertexCount).toBe(0);
    // 未开始的绘制不接收顶点。
    machine.cancel();
    expect(machine.addVertex(point(1, 1))).toBeUndefined();
  });

  it('cancels the active drawing, notifies, and keeps completed graphics', () => {
    const renderer = createRenderer();
    const cancels: number[] = [];
    const machine = new DrawingStateMachine(renderer.port, undefined, () => cancels.push(1));

    machine.start('polyline');
    machine.addVertex(point(1, 1));
    machine.previewPositions(point(2, 2));
    machine.cancel();

    expect(machine.drawing).toBe(false);
    expect(renderer.port.removePreview).toHaveBeenCalled();
    expect(cancels).toHaveLength(1);
    // 再次取消不重复通知。
    machine.cancel();
    expect(cancels).toHaveLength(1);

    // 开始新的绘制会先取消旧的。
    machine.start('polyline');
    machine.start('polygon');
    expect(cancels).toHaveLength(2);
    expect(machine.mode).toBe('polygon');
  });

  it('manages completed graphics and disposes its own state', () => {
    const renderer = createRenderer();
    const machine = new DrawingStateMachine(renderer.port);

    machine.start('point');
    machine.addVertex(point(1, 1));
    machine.start('point');
    machine.addVertex(point(2, 2));

    machine.removeLatestCompleted();
    expect(renderer.port.removeCompleted).toHaveBeenCalledTimes(1);
    machine.removeLatestCompleted();
    expect(renderer.port.removeCompleted).toHaveBeenCalledTimes(2);
    // 已经清空后不再调用渲染端口。
    machine.removeLatestCompleted();
    expect(renderer.port.removeCompleted).toHaveBeenCalledTimes(2);

    machine.start('point');
    machine.addVertex(point(3, 3));
    machine.dispose();
    expect(renderer.port.removeCompleted).toHaveBeenCalledTimes(3);
    expect(machine.drawing).toBe(false);
  });
});
