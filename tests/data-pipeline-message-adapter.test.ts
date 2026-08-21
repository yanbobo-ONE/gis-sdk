import { describe, expect, it, vi } from 'vitest';

import { DataPipeline } from '../src/core/data-pipeline.js';
import { DataPipelineMessageAdapter } from '../src/core/data-pipeline-message-adapter.js';

interface PositionUpdate {
  readonly id: string;
  readonly position: number;
}

function createPipeline(maxQueueItems = 3) {
  return new DataPipeline<PositionUpdate>({
    keyBy: (value) => value.id,
    maxQueueItems,
    coalesce: 'none',
    overflow: 'drop-newest',
  });
}

function createSource() {
  const listeners = new Set<EventListener>();
  const addEventListener = vi.fn((_type: 'message', listener: EventListener) => {
    listeners.add(listener);
  });
  const removeEventListener = vi.fn((_type: 'message', listener: EventListener) => {
    listeners.delete(listener);
  });
  const start = vi.fn();

  return {
    source: { addEventListener, removeEventListener, start },
    addEventListener,
    removeEventListener,
    start,
    emit(data: unknown) {
      for (const listener of listeners) {
        listener({ data } as unknown as Event);
      }
    },
  };
}

function decodePosition(value: unknown): PositionUpdate {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { readonly id?: unknown }).id !== 'string' ||
    typeof (value as { readonly position?: unknown }).position !== 'number'
  ) {
    throw new Error('Invalid position update.');
  }
  return value as PositionUpdate;
}

describe('DataPipelineMessageAdapter', () => {
  it('starts a MessagePort-like source once and forwards decoded updates to the pipeline', () => {
    const port = createSource();
    const pipeline = createPipeline();
    const adapter = new DataPipelineMessageAdapter({
      source: port.source,
      pipeline,
      decode: decodePosition,
    });

    adapter.start();
    adapter.start();
    port.emit({ id: 'aircraft-1', position: 1 });

    expect(port.start).toHaveBeenCalledOnce();
    expect(port.addEventListener).toHaveBeenCalledOnce();
    expect(adapter.state).toBe('running');
    expect(adapter.stats).toEqual({
      accepted: 1,
      dropped: 0,
      received: 1,
      rejected: 0,
      state: 'running',
    });
    expect(pipeline.take()).toEqual([{ id: 'aircraft-1', position: 1 }]);
  });

  it('stops receiving messages and detaches without closing a caller-owned source', () => {
    const port = createSource();
    const pipeline = createPipeline();
    const adapter = new DataPipelineMessageAdapter({
      source: port.source,
      pipeline,
      decode: decodePosition,
    });

    adapter.start();
    adapter.stop();
    port.emit({ id: 'aircraft-1', position: 1 });

    expect(adapter.state).toBe('idle');
    expect(port.removeEventListener).toHaveBeenCalledOnce();
    expect(pipeline.take()).toEqual([]);

    adapter.dispose();
    adapter.dispose();
    expect(adapter.state).toBe('disposed');
    expect(() => {
      adapter.start();
    }).toThrow(expect.objectContaining({ code: 'DATA_PIPELINE_MESSAGE_ADAPTER_DISPOSED' }));
  });

  it('reports rejected messages without stopping later valid messages', () => {
    const port = createSource();
    const pipeline = createPipeline();
    const adapter = new DataPipelineMessageAdapter({
      source: port.source,
      pipeline,
      decode: decodePosition,
    });
    const rejected = vi.fn();
    adapter.events.on('message:rejected', rejected);

    adapter.start();
    port.emit({ id: 42, position: 'bad' });
    port.emit({ id: 'aircraft-1', position: 1 });

    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ data: { id: 42, position: 'bad' } }),
    );
    expect(adapter.stats).toMatchObject({ received: 2, rejected: 1, accepted: 1 });
    expect(pipeline.take()).toEqual([{ id: 'aircraft-1', position: 1 }]);
  });

  it('counts inputs rejected by the pipeline overflow policy', () => {
    const port = createSource();
    const pipeline = createPipeline(1);
    const adapter = new DataPipelineMessageAdapter({
      source: port.source,
      pipeline,
      decode: decodePosition,
    });

    adapter.start();
    port.emit({ id: 'a', position: 1 });
    port.emit({ id: 'b', position: 2 });

    expect(adapter.stats).toMatchObject({ received: 2, accepted: 1, dropped: 1, rejected: 0 });
    expect(pipeline.take()).toEqual([{ id: 'a', position: 1 }]);
  });

  it('rejects invalid runtime configuration before registering listeners', () => {
    const pipeline = createPipeline();

    expect(
      () =>
        new DataPipelineMessageAdapter({
          source: undefined as never,
          pipeline,
          decode: decodePosition,
        }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_MESSAGE_ADAPTER_CONFIG' }));
    expect(
      () =>
        new DataPipelineMessageAdapter({
          source: createSource().source,
          pipeline,
          decode: undefined as never,
        }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_MESSAGE_ADAPTER_CONFIG' }));
  });
});
