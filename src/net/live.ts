import type { Seat } from './protocol';

/** A remote racer with no snapshot for this long (ms) turns ghost. */
export const SILENT_MS = 5000;

export type Life = 'live' | 'ghost' | 'gone';

/**
 * What a remote racer's bus is, from the room's seats and its snapshots: gone when its seat is
 * out of the room (a player's, or for the host's AI the host's), a ghost while that seat is offline
 * (players only), our own link is down, or its snapshots stopped, solid otherwise.
 */
export function remoteLife(i: { seat: Seat | undefined; byFlag: boolean; silentMs: number; linkUp: boolean }): Life {
  if (!i.seat) return 'gone';
  if (!i.linkUp || (i.byFlag && !i.seat.online) || i.silentMs > SILENT_MS) return 'ghost';
  return 'live';
}
