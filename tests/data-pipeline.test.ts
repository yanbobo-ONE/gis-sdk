import { describe, expect, it } from 'vitest';

import { DataPipeline } from '../src/core/data-pipeline.js';

interface PositionUpdate {
  readonly id: string;
  readonly position: number;
}

function createPipeline(
  options: Partial<ConstructorParameters<typeof DataPipeline<PositionUpdate>>[0]> = {},
) {
  return new DataPipeline<PositionUpdate>({
    keyBy: (update) => update.id,
    maxQueueItems: 2,
    ...options,
  });
}

describe('DataPipeline', () => {
  it('coalesces queued updates by key and reports a snapshot', () => {
    const pipeline = createPipeline({ coalesce: 'latest' });

    expect(pipeline.push({ id: 'aircraft-1', position: 1 })).toBe(true);
    expect(pipeline.push({ id: 'aircraft-1', position: 2 })).toBe(true);

    expect(pipeline.take()).toEqual([{ id: 'aircraft-1', position: 2 }]);
    expect(pipeline.stats).toEqual({
      accepted: 2,
      closed: false,
      coalesced: 1,
      dropped: 0,
      queued: 0,
      taken: 1,
    });
    expect(Object.isFrozen(pipeline.stats)).toBe(true);
  });

  it('keeps the newest bounded queue contents for drop-oldest overflow', () => {
    const pipeline = createPipeline({ coalesce: 'none', overflow: 'drop-oldest' });

    pipeline.push({ id: 'a', position: 1 });
    pipeline.push({ id: 'b', position: 2 });
    expect(pipeline.push({ id: 'c', position: 3 })).toBe(true);

    expect(pipeline.take()).toEqual([
      { id: 'b', position: 2 },
      { id: 'c', position: 3 },
    ]);
    expect(pipeline.stats).toMatchObject({ accepted: 3, dropped: 1, taken: 2 });
  });

  it('rejects the incoming update for drop-newest overflow', () => {
    const pipeline = createPipeline({ coalesce: 'none', overflow: 'drop-newest' });

    pipeline.push({ id: 'a', position: 1 });
    pipeline.push({ id: 'b', position: 2 });

    expect(pipeline.push({ id: 'c', position: 3 })).toBe(false);
    expect(pipeline.take()).toEqual([
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
    ]);
    expect(pipeline.stats).toMatchObject({ accepted: 2, dropped: 1, taken: 2 });
  });

  it('keeps the latest update for an existing key under keep-latest overflow', () => {
    const pipeline = createPipeline({ coalesce: 'latest', overflow: 'keep-latest' });

    pipeline.push({ id: 'a', position: 1 });
    pipeline.push({ id: 'b', position: 2 });
    expect(pipeline.push({ id: 'a', position: 3 })).toBe(true);

    expect(pipeline.take()).toEqual([
      { id: 'a', position: 3 },
      { id: 'b', position: 2 },
    ]);
    expect(pipeline.stats).toMatchObject({ accepted: 3, coalesced: 1, dropped: 0 });
  });

  it('takes FIFO batches and closes without retaining buffered values', () => {
    const pipeline = createPipeline({ coalesce: 'none' });

    expect(pipeline.take()).toEqual([]);
    pipeline.push({ id: 'a', position: 1 });
    pipeline.push({ id: 'b', position: 2 });
    expect(pipeline.take(1)).toEqual([{ id: 'a', position: 1 }]);
    expect(pipeline.take()).toEqual([{ id: 'b', position: 2 }]);

    pipeline.push({ id: 'c', position: 3 });
    pipeline.close();

    expect(pipeline.stats).toMatchObject({ closed: true, queued: 0 });
    expect(() => pipeline.push({ id: 'd', position: 4 })).toThrow(
      expect.objectContaining({ code: 'DATA_PIPELINE_CLOSED' }),
    );
    expect(() => pipeline.take()).toThrow(
      expect.objectContaining({ code: 'DATA_PIPELINE_CLOSED' }),
    );
    expect(() => {
      pipeline.clear();
    }).toThrow(expect.objectContaining({ code: 'DATA_PIPELINE_CLOSED', operation: 'clear' }));
  });

  it('rejects invalid options, keys, and batch limits', () => {
    expect(() => new DataPipeline<PositionUpdate>(undefined as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_CONFIG' }),
    );
    expect(() => createPipeline({ maxQueueItems: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_CONFIG' }),
    );
    expect(() => createPipeline({ coalesce: 'none', overflow: 'keep-latest' })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_CONFIG' }),
    );
    expect(() => createPipeline({ coalesce: 'invalid' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_CONFIG' }),
    );
    expect(() => createPipeline({ overflow: 'invalid' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_CONFIG' }),
    );

    const pipeline = createPipeline();
    expect(() => pipeline.push({ id: ' ', position: 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_KEY' }),
    );
    expect(() => pipeline.take(0)).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_TAKE_LIMIT' }),
    );

    const invalidKeyPipeline = new DataPipeline<PositionUpdate>({
      keyBy: () => 42 as unknown as string,
    });
    expect(() => invalidKeyPipeline.push({ id: 'a', position: 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_KEY' }),
    );

    const throwingKeyPipeline = new DataPipeline<PositionUpdate>({
      keyBy: () => {
        throw new Error('adapter failed');
      },
    });
    expect(() => throwingKeyPipeline.push({ id: 'a', position: 1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_DATA_PIPELINE_KEY' }),
    );
  });
});
