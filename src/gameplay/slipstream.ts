import type { RoadUser } from './raceDriver';

/**
 * Slipstream (rebufo): close behind another racer at speed, the air it pushes aside pulls the one
 * behind along. Pure: works in track coordinates (`RoadUser`: `s` the front axle along the track,
 * `off` across it, `len` the vehicle's length), so bends don't matter. The physics side is
 * `BusPhysics.draft` (a shove past top speed, like a mild nitro).
 */

/** Furthest gap (m) from our nose to the leader's tail that still pulls; it pulls harder closer. */
export const DRAFT_RANGE = 30;
/** Across the road: full pull within this offset (m) of the leader's line, none past `DRAFT_SIDE`. */
const DRAFT_ALIGN = 1.2;
const DRAFT_SIDE = 2.6;
/** Both must be going at least this fast (m/s) to pull at all, fully from `DRAFT_FULL_SPEED`. */
const DRAFT_SPEED = 40 / 3.6;
const DRAFT_FULL_SPEED = 65 / 3.6;
/** The pull builds over about this long (s) and fades faster when we pull out. */
const RISE = 0.8;
const FALL = 0.35;

const ramp = (x: number, lo: number, hi: number) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));

/** How hard `me` is pulled (0..1) by whichever of `others` it sits closest behind. */
export function draftOf(me: RoadUser, others: readonly RoadUser[]): number {
  let best = 0;
  for (const o of others) {
    if (o === me) continue;
    const gap = o.s - o.len - me.s;
    if (gap <= 0 || gap > DRAFT_RANGE) continue;
    const side = 1 - ramp(Math.abs(o.off - me.off), DRAFT_ALIGN, DRAFT_SIDE);
    const speed = Math.min(ramp(me.v, DRAFT_SPEED, DRAFT_FULL_SPEED), ramp(o.v, DRAFT_SPEED, DRAFT_FULL_SPEED));
    best = Math.max(best, (1 - gap / DRAFT_RANGE) ** 0.5 * side * speed);
  }
  return best;
}

/** One racer's pull, eased so it builds up behind a leader and doesn't flicker as the gap wobbles. */
export class Slipstream {
  level = 0;

  step(target: number, dt: number): number {
    this.level = target > this.level ? Math.min(target, this.level + dt / RISE) : Math.max(target, this.level - dt / FALL);
    return this.level;
  }

  reset(): void {
    this.level = 0;
  }
}
