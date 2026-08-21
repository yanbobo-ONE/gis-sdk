import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataPipeline } from '../src/core/data-pipeline.js';
import {
  DataPipelineFrameScheduler,
  type DataPipelineFrameClock,
} from '../src/core/data-pipeline-frame-scheduler.js';

interface Update {
  readonly id: string;
  readonly value: number;
}

function createPipeline() {
  return new DataPipeline<Update>({
    keyBy: (value) => value.id,
    maxQueueItems: 8,
    coalesce: 'none',
  });
}

function createClock() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  });
  const cancel = vi.fn((handle: number) => {
    callbacks.delete(handle);
  });

  return {
    clock: { request, cancel } satisfies DataPipelineFrameClock,
    request,
    cancel,
    fireNext(timestamp = 16) {
      const next = callbacks.entries().next();
      if (next.done) {
        throw new Error('No animation frame is pending.');
      }
      const [handle, callback] = next.value;
      callbacks.delete(handle);
      callback(timestamp);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DataPipelineFrameScheduler', () => {
  it('coalesces requests and consumes one bounded batch in a frame', () => {
    const clock = createClock();
    const pipeline = createPipeline();
    const render = vi.fn();
    const scheduler = new DataPipelineFrameScheduler({
      pipeline,
      maxItemsPerFrame: 2,
      onBatch: render,
      clock: clock.clock,
    });
    pipeline.push({ id: 'a', value: 1 });
    pipeline.push({ id: 'b', value: 2 });
    pipeline.push({ id: 'c', value: 3 });

    expect(scheduler.request()).toBe(true);
    expect(scheduler.request()).toBe(false);
    expect(clock.request).toHaveBeenCalledOnce();

    clock.fireNext();

    expect(render).toHaveBeenCalledWith([
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ]);
    expect(scheduler.stats).toEqual({
      completed: 1,
      consumed: 2,
      failed: 0,
      requests: 3,
      scheduled: 2,
      coalesced: 1,
      state: 'scheduled',
    });
    expect(pipeline.take()).toEqual([{ id: 'c', value: 3 }]);
  });

  it('continues on later frames while the pipeline retains updates', () => {
    const clock = createClock();
    const pipeline = createPipeline();
    const batches: (readonly Update[])[] = [];
    const scheduler = new DataPipelineFrameScheduler({
      pipeline,
      maxItemsPerFrame: 1,
      onBatch: (values) => batches.push(values),
      clock: clock.clock,
    });
    pipeline.push({ id: 'a', value: 1 });
    pipeline.push({ id: 'b', value: 2 });

    scheduler.request();
    clock.fireNext();
    clock.fireNext();

    expect(batches).toEqual([[{ id: 'a', value: 1 }], [{ id: 'b', value: 2 }]]);
    expect(scheduler.state).toBe('idle');
    expect(scheduler.stats).toMatchObject({ completed: 2, consumed: 2, scheduled: 2 });
  });

  it('cancels a pending frame without consuming caller-owned data', () => {
    const clock = createClock();
    const pipeline = createPipeline();
    const render = vi.fn();
    const scheduler = new DataPipelineFrameScheduler({
      pipeline,
      onBatch: render,
      clock: clock.clock,
    });
    pipeline.push({ id: 'a', value: 1 });

    scheduler.request();
    expect(scheduler.cancel()).toBe(true);
    expect(scheduler.cancel()).toBe(false);

    expect(clock.cancel).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
    expect(pipeline.take()).toEqual([{ id: 'a', value: 1 }]);
  });

  it('reports a consumer failure and leaves follow-up scheduling to the caller', () => {
    const clock = createClock();
    const pipeline = createPipeline();
    const failure = new Error('renderer unavailable');
    const scheduler = new DataPipelineFrameScheduler({
      pipeline,
      maxItemsPerFrame: 1,
      onBatch: () => {
        throw failure;
      },
      clock: clock.clock,
    });
    const frameFailed = vi.fn();
    scheduler.events.on('frame:failed', frameFailed);
    pipeline.push({ id: 'a', value: 1 });
    pipeline.push({ id: 'b', value: 2 });

    scheduler.request();
    clock.fireNext();

    expect(frameFailed).toHaveBeenCalledWith(expect.objectContaining({ cause: failure }));
    expect(scheduler.state).toBe('idle');
    expect(scheduler.stats).toMatchObject({ failed: 1, completed: 0, consumed: 1 });
    expect(clock.request).toHaveBeenCalledOnce();
    expect(pipeline.take()).toEqual([{ id: 'b', value: 2 }]);
  });

  it('disposes by removing its pending callback without closing the pipeline', () => {
    const clock = createClock();
    const pipeline = createPipeline();
    const scheduler = new DataPipelineFrameScheduler({
      pipeline,
      onBatch: vi.fn(),
      clock: clock.clock,
    });
    pipeline.push({ id: 'a', value: 1 });

    scheduler.request();
    scheduler.dispose();
    scheduler.dispose();

    expect(clock.cancel).toHaveBeenCalledOnce();
    expect(scheduler.state).toBe('disposed');
    expect(pipeline.stats.closed).toBe(false);
    expect(() => {
      scheduler.request();
    }).toThrow(expect.objectContaining({ code: 'DATA_PIPELINE_FRAME_SCHEDULER_DISPOSED' }));
  });

  it('rejects invalid configuration and unavailable browser clocks', () => {
    const pipeline = createPipeline();

    expect(
      () =>
        new DataPipelineFrameScheduler({
          pipeline,
          onBatch: undefined as never,
        }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_FRAME_SCHEDULER_CONFIG' }));
    expect(
      () =>
        new DataPipelineFrameScheduler({
          pipeline,
          onBatch: vi.fn(),
          maxItemsPerFrame: 0,
        }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_FRAME_SCHEDULER_CONFIG' }));

    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('cancelAnimationFrame', undefined);
    const scheduler = new DataPipelineFrameScheduler({ pipeline, onBatch: vi.fn() });

    expect(() => {
      scheduler.request();
    }).toThrow(expect.objectContaining({ code: 'DATA_PIPELINE_FRAME_SCHEDULER_UNAVAILABLE' }));
  });
});
