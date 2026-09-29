import { describe, expect, it, vi } from 'vitest';

import { disposeResources, rethrowAfterCleanup } from '../src/core/dispose-resources.js';

describe('disposeResources', () => {
  it('runs every cleanup once and skips missing entries', () => {
    const first = vi.fn();
    const third = vi.fn();

    expect(() => {
      disposeResources({ first, second: undefined, third });
    }).not.toThrow();
    expect(first).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
  });

  it('keeps releasing after a failure and aggregates every error', () => {
    const released = vi.fn();

    expect(() => {
      disposeResources({
        broken: () => {
          throw new Error('boom');
        },
        released,
      });
    }).toThrow(AggregateError);
    expect(released).toHaveBeenCalledOnce();
  });
});

describe('rethrowAfterCleanup', () => {
  it('always surfaces the original initialization error', () => {
    const released = vi.fn();
    const original = new Error('initialization failed');

    expect(() =>
      rethrowAfterCleanup(original, {
        released: () => {
          released();
        },
      }),
    ).toThrow(original);
    expect(released).toHaveBeenCalledOnce();
  });

  it('aggregates the original error with cleanup failures', () => {
    const original = new Error('initialization failed');

    try {
      rethrowAfterCleanup(original, {
        broken: () => {
          throw new Error('cleanup failed');
        },
      });
      expect.unreachable('rethrowAfterCleanup must throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
      expect((error as Error).cause).toBe(original);
    }
  });
});
