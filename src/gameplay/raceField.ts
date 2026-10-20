import { type TrackData, trackPose } from '../world/track';
import type { RoadPose } from '../world/roadSnap';

/** A rival crew: an invented company (look-alike names only, see CLAUDE.md) and its livery. */
export interface Crew {
  name: string;
  color: string;
  stripe: string;
  roof: string;
}

/** The rival crews, pole first, and the vehicle each drives when the field is mixed. */
export const CREWS: (Crew & { bus: string })[] = [
  { name: 'Chulla Vida', bus: 'interparroquial', color: '#f5d21c', stripe: '#d0281f', roof: '#f2f2ee' },
  { name: 'Ñaño Veloz', bus: 'buseta', color: '#ef7d1a', stripe: '#1d1a14', roof: '#efefef' },
  { name: 'Trans Guambra', bus: 'popular', color: '#2e9b52', stripe: '#f2f2ee', roof: '#e8e8e8' },
];
export const MAX_RIVALS = CREWS.length;
/**
 * Cars and trucks on a track with traffic on: all in the bubble around the player (going both
 * ways, recycled ahead or behind out of sight as they fall out of it), so there's always some
 * about, and none far off costing time or holding up rivals nobody sees.
 */
export const TRACK_TRAFFIC = 6;
/** Seconds a vehicle put back on the road (the player's R, a rival's rescue) waits before it may go. */
export const RESET_WAIT = 3;

/**
 * What the rivals drive: a mix (each a different vehicle, none the player's while there are
 * enough others), the player's own vehicle, or one vehicle id for all of them.
 */
export type RivalChoice = 'mixed' | 'same' | string;

export function parseRivalChoice(v: unknown, vehicles: readonly string[]): RivalChoice {
  return v === 'same' || (typeof v === 'string' && vehicles.includes(v)) ? v : 'mixed';
}

/**
 * The vehicle id of each of `n` rivals. Mixed: the crews' own vehicles first if none is the
 * player's, otherwise a random draw (`rand` 0..1) of distinct vehicles from `pool` other than
 * the player's.
 */
export function rivalVehicles(choice: RivalChoice, player: string, n: number, pool: readonly string[], rand: () => number = Math.random): string[] {
  n = Math.max(0, Math.min(MAX_RIVALS, n));
  if (choice === 'same') return Array(n).fill(player);
  if (choice !== 'mixed') return Array(n).fill(choice);
  const own = CREWS.slice(0, n).map((c) => c.bus);
  if (!own.includes(player)) return own;
  const others = pool.filter((id) => id !== player);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  // (More rivals than other vehicles: they repeat.)
  return Array.from({ length: n }, (_, i) => others[i % others.length] ?? player);
}

/** Grid slots: fronts this far apart along the road, in alternate lanes (m off the middle, + right). */
const SLOT_GAP = 9.75;
const LANE = 2.1;
/** Room left behind a vehicle in the same lane (m). */
const SLOT_ROOM = 4;

/**
 * The grid for vehicles of these lengths (rivals first, pole first; the player last, at the back
 * to work their way up): staggered across the two lanes behind the start line, each lane's
 * vehicles one behind the other with room between (an articulated bus needs more road).
 * The poses are each vehicle's middle.
 */
export function gridSlots(track: TrackData, lengths: number[]): RoadPose[] {
  const back = [track.start, track.start];
  let front = track.start;
  return lengths.map((len, k) => {
    const lane = k % 2;
    // Never ahead of the slot before (the stagger), nor on the one ahead in this lane.
    front = Math.min(k ? front - SLOT_GAP : front, back[lane]);
    back[lane] = front - len - SLOT_ROOM;
    return trackPose(track, front - len / 2, (lane ? 1 : -1) * LANE);
  });
}
