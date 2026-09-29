import { describe, expect, it } from 'vitest';

import { RealtimeResyncController } from '../src/core/realtime-resync.js';
import { RealtimeSessionGate } from '../src/core/realtime-session-gate.js';

interface Message {
  readonly type?: string;
  readonly sessionId?: string;
  readonly payload?: { readonly sessionId?: string };
}

const gateFor = () =>
  new RealtimeSessionGate<Message>({
    sessionOf: (message) => message.sessionId ?? message.payload?.sessionId,
    isBegin: (message) => message.type === 'gis.session.begin',
  });

describe('RealtimeSessionGate', () => {
  it('adopts the first session and rejects messages from other sessions', () => {
    const gate = gateFor();

    // 不带会话信息的消息一律放行。
    expect(gate.evaluate({})).toEqual({ accept: true, switched: false, sessionId: undefined });

    // 首条带会话 id 的消息建立会话。
    expect(gate.evaluate({ sessionId: 'a' })).toEqual({
      accept: true,
      switched: true,
      sessionId: 'a',
    });
    expect(gate.sessionId).toBe('a');

    // 同会话继续放行；其它会话（旧连接迟到包）被拒绝且不改变当前会话。
    expect(gate.evaluate({ sessionId: 'a' }).accept).toBe(true);
    expect(gate.evaluate({ sessionId: 'b' })).toEqual({
      accept: false,
      switched: false,
      sessionId: 'a',
    });
    expect(gate.sessionId).toBe('a');
  });

  it('switches sessions only through the explicit control message', () => {
    const gate = gateFor();
    gate.evaluate({ sessionId: 'a' });

    // 控制消息自身不进管线，只切换会话。
    expect(gate.evaluate({ type: 'gis.session.begin', sessionId: 'b' })).toEqual({
      accept: false,
      switched: true,
      sessionId: 'b',
    });
    expect(gate.evaluate({ sessionId: 'b' }).accept).toBe(true);
    expect(gate.evaluate({ sessionId: 'a' }).accept).toBe(false);

    // 重复同会话的控制消息不算切换。
    expect(gate.evaluate({ type: 'gis.session.begin', sessionId: 'b' }).switched).toBe(false);

    // 缺少会话 id 的控制消息被忽略。
    expect(gate.evaluate({ type: 'gis.session.begin' })).toEqual({
      accept: false,
      switched: false,
      sessionId: 'b',
    });

    gate.reset();
    expect(gate.sessionId).toBeUndefined();
  });

  it('reads the session id from nested payloads and rejects invalid configuration', () => {
    const gate = gateFor();
    expect(gate.evaluate({ payload: { sessionId: 'nested' } })).toMatchObject({
      accept: true,
      sessionId: 'nested',
    });

    expect(() => new RealtimeSessionGate<Message>({ sessionOf: undefined as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_CONFIG' }),
    );
  });
});

describe('RealtimeResyncController', () => {
  it('requests a snapshot on a gap and suppresses repeats of the same gap', () => {
    const resync = new RealtimeResyncController();

    const first = resync.onGap(5);
    expect(first).toMatchObject({
      state: 'waiting-snapshot',
      expectedSequence: 5,
      requests: 1,
      suppressedRequests: 0,
    });

    // 同一断档重复上报只计抑制。
    const repeated = resync.onGap(5);
    expect(repeated).toMatchObject({ requests: 1, suppressedRequests: 1 });

    // 不同断档会再发一次请求。
    expect(resync.onGap(9)).toMatchObject({ requests: 2, suppressedRequests: 1 });
  });

  it('caps the number of snapshot requests', () => {
    const resync = new RealtimeResyncController({ maxRequests: 2 });
    resync.onGap(1);
    resync.onGap(2);
    expect(resync.snapshot.requests).toBe(2);

    resync.onGap(3);
    expect(resync.snapshot).toMatchObject({ requests: 2, suppressedRequests: 1 });

    expect(resync.requestSnapshot('cursor-1')).toMatchObject({
      cursor: 'cursor-1',
      requests: 2,
      suppressedRequests: 2,
    });
  });

  it('accepts a snapshot, catches up, and returns to synchronized', () => {
    const resync = new RealtimeResyncController();
    resync.onGap(5);

    expect(resync.acceptSnapshot(10)).toMatchObject({
      state: 'catching-up',
      acceptedSequence: 10,
      expectedSequence: 11,
    });

    // 迟到的增量被丢弃，不改变状态。
    expect(resync.acceptDelta(9)).toMatchObject({ state: 'catching-up', acceptedSequence: 10 });

    // 连续增量推进基线。
    expect(resync.acceptDelta(11)).toMatchObject({
      state: 'synchronized',
      acceptedSequence: 11,
      expectedSequence: 12,
    });

    // 新的断档重新进入等待快照。
    expect(resync.acceptDelta(14)).toMatchObject({
      state: 'waiting-snapshot',
      expectedSequence: 14,
      requests: 2,
    });

    // 等待窗口内到达的增量被抑制。
    expect(resync.acceptDelta(15)).toMatchObject({ state: 'waiting-snapshot' });
    expect(resync.snapshot.suppressedRequests).toBeGreaterThan(0);
  });

  it('supports explicit snapshot requests and resets its counters', () => {
    const resync = new RealtimeResyncController();
    expect(resync.requestSnapshot()).toMatchObject({ state: 'waiting-snapshot', requests: 1 });
    expect(resync.requestSnapshot('cursor')).toMatchObject({
      cursor: 'cursor',
      suppressedRequests: 1,
    });

    resync.reset();
    expect(resync.snapshot).toEqual({
      state: 'synchronized',
      expectedSequence: undefined,
      acceptedSequence: undefined,
      requests: 0,
      suppressedRequests: 0,
    });
  });

  it('rejects invalid configuration and sequence values', () => {
    expect(() => new RealtimeResyncController({ maxRequests: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_CONFIG' }),
    );

    const resync = new RealtimeResyncController();
    expect(() => resync.onGap(Number.NaN)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => resync.acceptSnapshot(Number.POSITIVE_INFINITY)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
    expect(() => resync.acceptDelta(Number.NaN)).toThrow(
      expect.objectContaining({ code: 'INVALID_REALTIME_INPUT' }),
    );
  });
});
