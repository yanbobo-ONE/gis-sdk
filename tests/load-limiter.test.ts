import { describe, expect, it, vi } from 'vitest';

import { LoadLimiter } from '../src/cesium/load-limiter.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const idle = new AbortController().signal;

describe('LoadLimiter', () => {
  it('runs up to the concurrency limit and queues the rest in order', async () => {
    const limiter = new LoadLimiter(2);
    const started: string[] = [];
    const gates = new Map<string, Deferred<string>>();
    const load = (key: string) => {
      started.push(key);
      const gate = deferred<string>();
      gates.set(key, gate);
      return gate.promise;
    };

    const first = limiter.run(() => load('a'), idle);
    const second = limiter.run(() => load('b'), idle);
    const third = limiter.run(() => load('c'), idle);

    expect(started).toEqual(['a', 'b']);
    expect(limiter.activeCount).toBe(2);
    expect(limiter.queuedCount).toBe(1);

    gates.get('a')?.resolve('a');
    await expect(first).resolves.toBe('a');
    await vi.waitFor(() => {
      expect(started).toEqual(['a', 'b', 'c']);
    });

    gates.get('b')?.resolve('b');
    gates.get('c')?.resolve('c');
    await expect(second).resolves.toBe('b');
    await expect(third).resolves.toBe('c');
    expect(limiter.activeCount).toBe(0);
    expect(limiter.queuedCount).toBe(0);
  });

  it('fails a queued task on cancellation without starting it', async () => {
    const limiter = new LoadLimiter(1);
    const running = deferred<string>();
    const queuedTask = vi.fn(() => Promise.resolve('queued'));
    const controller = new AbortController();

    const occupied = limiter.run(() => running.promise, idle);
    const queued = limiter.run(queuedTask, controller.signal);
    expect(limiter.queuedCount).toBe(1);

    controller.abort('route changed');

    const error = await queued.then(
      () => undefined,
      (cause: unknown) => cause as Error & { cause?: unknown },
    );
    expect(error?.message).toBe('Operation aborted.');
    expect(error?.cause).toBe('route changed');
    expect(queuedTask).not.toHaveBeenCalled();
    expect(limiter.queuedCount).toBe(0);

    running.resolve('running');
    await expect(occupied).resolves.toBe('running');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const limiter = new LoadLimiter(1);
    const task = vi.fn(() => Promise.resolve('value'));
    const controller = new AbortController();
    controller.abort('already gone');

    const error = await limiter.run(task, controller.signal).then(
      () => undefined,
      (cause: unknown) => cause as Error & { cause?: unknown },
    );
    expect(error?.cause).toBe('already gone');
    expect(task).not.toHaveBeenCalled();
    expect(limiter.activeCount).toBe(0);
    expect(limiter.queuedCount).toBe(0);
  });

  it('releases the slot when a task fails or throws synchronously', async () => {
    const limiter = new LoadLimiter(1);

    await expect(
      limiter.run(() => {
        throw new Error('sync boom');
      }, idle),
    ).rejects.toThrow('sync boom');
    expect(limiter.activeCount).toBe(0);

    await expect(limiter.run(() => Promise.reject(new Error('async boom')), idle)).rejects.toThrow(
      'async boom',
    );
    expect(limiter.activeCount).toBe(0);

    await expect(limiter.run(() => Promise.resolve('recovered'), idle)).resolves.toBe('recovered');
  });

  it('removes the abort listener once a queued task starts', async () => {
    const limiter = new LoadLimiter(1);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const first = limiter.run(() => Promise.resolve('first'), idle);
    const second = limiter.run(() => Promise.resolve('second'), controller.signal);
    await first;
    await second;

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
