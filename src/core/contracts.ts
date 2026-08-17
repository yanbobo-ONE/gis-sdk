import type { GisError } from './errors.js';
import type { EventHub } from './event-hub.js';

export type MapState = 'ready' | 'destroying' | 'destroyed';

export interface MapEventMap {
  'map:destroy': { id: string };
  'map:error': { id: string; error: GisError };
}

export interface GisMap<TRaw = unknown> {
  readonly id: string;
  readonly state: MapState;
  readonly events: EventHub<MapEventMap>;
  readonly raw: Readonly<TRaw>;
  resize(): void;
  destroy(): Promise<void>;
}

export interface MapEngineAdapter<TRaw> {
  readonly raw: Readonly<TRaw>;
  resize(): void;
  destroy(): void | Promise<void>;
}
