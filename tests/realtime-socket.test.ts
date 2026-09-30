import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REALTIME_SOCKET_WILDCARD, RealtimeSocketClient } from '../src/core/realtime-socket.js';
import type { RealtimeSocketLike, RealtimeSocketMessage } from '../src/core/realtime-socket.js';

/** 可控的 socket 替身：测试自己决定什么时候 open/message/error/close。 */
class FakeSocket implements RealtimeSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** 模拟链路丢失：先触发 error 再触发 close。 */
  fail(): void {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.();
  }
}

function createHarness(options: {
  maxRetries?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  heartbeat?: { intervalMs: number; timeoutMs: number; message: unknown };
  decode?: (data: unknown) => RealtimeSocketMessage;
  url?: string | (() => string);
} = {}) {
  const sockets: FakeSocket[] = [];
  const client = new RealtimeSocketClient({
    url: options.url ?? 'wss://example.com/realtime',
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: options.maxRetryDelayMs }),
    ...(options.decode === undefined ? {} : { decode: options.decode }),
    ...(options.heartbeat === undefined
      ? {}
      : { heartbeat: { ...options.heartbeat, isPong: (message) => message.type === 'pong' } }),
    factory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
  });
  return {
    client,
    sockets,
    latest: () => {
      const socket = sockets[sockets.length - 1];
      if (!socket) {
        throw new Error('No socket has been created yet.');
      }
      return socket;
    },
    /** 推进假定时器并执行到期的回调。 */
    tick: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeSocketClient', () => {
  it('connects, routes messages by type, and counts stats', () => {
    const harness = createHarness();
    const telemetry: unknown[] = [];
    const all: string[] = [];
    const states: string[] = [];
    harness.client.subscribe('telemetry', (message) => telemetry.push(message.payload));
    harness.client.subscribe(REALTIME_SOCKET_WILDCARD, (message) => all.push(message.type));
    harness.client.onState((state) => states.push(state));

    harness.client.connect();
    expect(harness.client.state).toBe('connecting');
    harness.latest().open();
    expect(harness.client.state).toBe('open');
    expect(states).toEqual(['idle', 'connecting', 'open']);

    harness.latest().message(JSON.stringify({ type: 'telemetry', payload: { speed: 12 } }));
    harness.latest().message(JSON.stringify({ type: 'alert', payload: 'engine' }));

    expect(telemetry).toEqual([{ speed: 12 }]);
    expect(all).toEqual(['telemetry', 'alert']);
    expect(harness.client.stats).toMatchObject({ messages: 2, decodeFailures: 0, retries: 0 });
    expect(harness.client.stats.lastMessageAt).toBeTypeOf('number');
  });

  it('isolates decode failures instead of dropping the connection', () => {
    const harness = createHarness();
    const errors: string[] = [];
    const seen: string[] = [];
    harness.client.onError((error) => errors.push(error.code));
    harness.client.subscribe(REALTIME_SOCKET_WILDCARD, (message) => seen.push(message.type));
    harness.client.connect();
    harness.latest().open();

    harness.latest().message('not-json');
    harness.latest().message(JSON.stringify({ payload: 'missing type' }));
    harness.latest().message(JSON.stringify({ type: 'ok' }));

    expect(harness.client.state).toBe('open');
    expect(seen).toEqual(['ok']);
    expect(harness.client.stats).toMatchObject({ messages: 1, decodeFailures: 2 });
    expect(errors).toEqual(['INVALID_REALTIME_INPUT', 'INVALID_REALTIME_INPUT']);
  });

  it('isolates subscriber exceptions', () => {
    const harness = createHarness();
    const errors: string[] = [];
    const survivor: string[] = [];
    harness.client.onError((error) => errors.push(error.message));
    harness.client.subscribe('tick', () => {
      throw new Error('subscriber failed');
    });
    harness.client.subscribe('tick', (message) => survivor.push(message.type));
    harness.client.connect();
    harness.latest().open();

    harness.latest().message(JSON.stringify({ type: 'tick' }));

    expect(survivor).toEqual(['tick']);
    expect(errors).toEqual(['subscriber failed']);
    expect(harness.client.state).toBe('open');
  });

  it('reconnects with capped exponential backoff and resets retries after success', async () => {
    const harness = createHarness({ retryDelayMs: 100, maxRetryDelayMs: 400, maxRetries: 3 });
    const states: string[] = [];
    harness.client.onState((state) => states.push(state));
    harness.client.connect();
    harness.latest().open();

    harness.latest().fail();
    expect(harness.client.state).toBe('reconnecting');
    // 抖动源固定 0.5：延迟 = 100 × 1 × (0.8 + 0.2) = 100。
    await harness.tick(99);
    expect(harness.sockets).toHaveLength(1);
    await harness.tick(1);
    expect(harness.sockets).toHaveLength(2);

    harness.latest().fail();
    await harness.tick(200);
    expect(harness.sockets).toHaveLength(3);
    expect(harness.client.stats).toMatchObject({ retries: 2, totalRetries: 2 });

    harness.latest().open();
    expect(harness.client.stats.retries).toBe(0);
    harness.latest().fail();
    await harness.tick(100);
    expect(harness.client.stats).toMatchObject({ retries: 1, totalRetries: 3 });
    expect(states).toContain('reconnecting');
  });

  it('stops reconnecting after maxRetries and reports the failure', async () => {
    const harness = createHarness({ retryDelayMs: 10, maxRetries: 1 });
    const errors: string[] = [];
    harness.client.onError((error) => errors.push(error.code));
    harness.client.connect();
    harness.latest().open();

    harness.latest().fail();
    await harness.tick(20);
    harness.latest().fail();
    await harness.tick(1000);

    expect(harness.sockets).toHaveLength(2);
    expect(harness.client.stats.state).toBe('closed');
    expect(errors.filter((code) => code === 'REALTIME_SOCKET_FAILED')).toHaveLength(2);
  });

  it('sends heartbeats and treats a missing pong as a lost link', async () => {
    const harness = createHarness({
      retryDelayMs: 10,
      heartbeat: { intervalMs: 50, timeoutMs: 30, message: { type: 'ping' } },
    });
    harness.client.connect();
    harness.latest().open();

    await harness.tick(50);
    expect(harness.latest().sent).toEqual(['{"type":"ping"}']);

    // 回应心跳后重新计时，不会因为超过 timeoutMs 而断开。
    harness.latest().message(JSON.stringify({ type: 'pong' }));
    await harness.tick(20);
    expect(harness.client.state).toBe('open');

    await harness.tick(30);
    expect(harness.latest().sent).toHaveLength(2);
    await harness.tick(30);
    expect(harness.client.state).toBe('reconnecting');
    expect(harness.latest().close).toHaveBeenCalled();
  });

  it('does not reconnect after close() or dispose()', async () => {
    const harness = createHarness({ retryDelayMs: 10 });
    harness.client.connect();
    harness.latest().open();

    harness.client.close();
    expect(harness.client.state).toBe('closed');
    await harness.tick(1000);
    expect(harness.sockets).toHaveLength(1);

    harness.client.connect();
    expect(harness.sockets).toHaveLength(2);

    harness.client.dispose();
    await harness.tick(1000);
    expect(harness.sockets).toHaveLength(2);
    expect(() => {
      harness.client.connect();
    }).toThrow(expect.objectContaining({ code: 'REALTIME_SOCKET_DISPOSED' }));
    expect(() => {
      harness.client.send('x');
    }).toThrow(expect.objectContaining({ code: 'REALTIME_SOCKET_DISPOSED' }));
  });

  it('ignores events from a replaced socket', () => {
    const harness = createHarness({ retryDelayMs: 10 });
    harness.client.connect();
    const stale = harness.latest();
    stale.open();
    stale.fail();

    // 旧连接在断开后仍可能抛出迟到的事件。
    stale.message(JSON.stringify({ type: 'late' }));
    const seen: string[] = [];
    harness.client.subscribe(REALTIME_SOCKET_WILDCARD, (message) => seen.push(message.type));

    expect(seen).toEqual([]);
    expect(harness.client.stats.messages).toBe(0);
  });

  it('serialises sends, refuses to queue while closed, and validates configuration', () => {
    const harness = createHarness();
    harness.client.connect();
    expect(() => {
      harness.client.send({ type: 'command' });
    }).toThrow(expect.objectContaining({ code: 'REALTIME_SOCKET_NOT_OPEN', retryable: true }));

    harness.latest().open();
    harness.client.send({ type: 'command' });
    harness.client.send('{"type":"raw"}');
    expect(harness.latest().sent).toEqual(['{"type":"command"}', '{"type":"raw"}']);

    expect(() => new RealtimeSocketClient({ url: 'https://example.com' })).not.toThrow();
    const invalid = new RealtimeSocketClient({ url: 'https://example.com' });
    const errors: string[] = [];
    invalid.onError((error) => errors.push(error.code));
    invalid.connect();
    expect(invalid.state).toBe('closed');
    expect(errors).toEqual(['INVALID_REALTIME_SOCKET_CONFIG']);

    expect(() => new RealtimeSocketClient({ url: 'wss://a', maxRetries: 100 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_SOCKET_CONFIG' }),
    );
    expect(
      () =>
        new RealtimeSocketClient({
          url: 'wss://a',
          retryDelayMs: 1000,
          maxRetryDelayMs: 10,
        }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REALTIME_SOCKET_CONFIG' }));
  });

  it('re-evaluates a url function on every reconnect', async () => {
    let ticket = 0;
    const urls: string[] = [];
    const client = new RealtimeSocketClient({
      url: () => `wss://example.com/realtime?ticket=${String(++ticket)}`,
      retryDelayMs: 10,
      factory: (url) => {
        urls.push(url);
        return new FakeSocket();
      },
      random: () => 0.5,
    });
    client.connect();
    urls.push('');
    await vi.advanceTimersByTimeAsync(0);
    expect(urls[0]).toBe('wss://example.com/realtime?ticket=1');
  });
});
