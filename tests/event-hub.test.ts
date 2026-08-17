import { describe, expect, it, vi } from 'vitest';

import { EventHub } from '../src/core/event-hub.js';

interface Events {
  ready: { id: string };
  destroyed: { id: string };
}

describe('EventHub', () => {
  it('subscribes and returns an idempotent unsubscribe function', () => {
    const events = new EventHub<Events>();
    const received: string[] = [];
    const off = events.on('ready', (event) => received.push(event.id));

    events.emit('ready', { id: 'map-1' });
    off();
    off();
    events.emit('ready', { id: 'map-2' });

    expect(received).toEqual(['map-1']);
  });

  it('runs a once listener only once', () => {
    const events = new EventHub<Events>();
    const listener = vi.fn();

    events.once('destroyed', listener);
    events.emit('destroyed', { id: 'map-1' });
    events.emit('destroyed', { id: 'map-1' });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ id: 'map-1' });
  });

  it('can unsubscribe a once listener before it runs', () => {
    const events = new EventHub<Events>();
    const listener = vi.fn();

    const off = events.once('ready', listener);
    off();
    events.emit('ready', { id: 'map-1' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('clears all listeners', () => {
    const events = new EventHub<Events>();
    const readyListener = vi.fn();
    const destroyedListener = vi.fn();

    events.on('ready', readyListener);
    events.on('destroyed', destroyedListener);
    events.clear();
    events.emit('ready', { id: 'map-1' });
    events.emit('destroyed', { id: 'map-1' });

    expect(readyListener).not.toHaveBeenCalled();
    expect(destroyedListener).not.toHaveBeenCalled();
  });
});
