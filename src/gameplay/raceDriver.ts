import type { DriveInput } from '../core/input';
import { type TrackData, locateOnTrack, trackPoint } from '../world/track';

/** How a driver takes the track: cornering grip it trusts, how hard it brakes, its top pace. */
export interface DriverSkill {
  /** Lateral acceleration it corners at (m/s²). */
  corner: number;
  /** Braking it plans with (m/s²). */
  brake: number;
  /** Never faster than this (m/s). */
  cruise: number;
  /** Fires the nitro on the straights. */
  nitro: boolean;
}

export const SKILLS: Record<'easy' | 'normal' | 'hard', DriverSkill> = {
  easy: { corner: 3.2, brake: 3.5, cruise: 15, nitro: false },
  normal: { corner: 4.2, brake: 4.5, cruise: 18, nitro: true },
  hard: { corner: 5.2, brake: 5.5, cruise: 22, nitro: true },
};

/** What the driver needs to see of its bus: where its front axle is, which way it points, how fast. */
export interface DrivenBus {
  nose(out?: { x: number; y: number; z: number }): { x: number; y: number; z: number };
  readonly heading: number;
  readonly speed: number;
}

/** No more progress than RESCUE_DIST (m) in RESCUE_TIME (s): stuck for good. */
const RESCUE_DIST = 6;
const RESCUE_TIME = 8;
/** Curvature is measured over this stretch (m). */
const CURVE_SPAN = 24;
/** Speed profile sample spacing (m). */
const STEP = 3;

/**
 * Drives a bus down a race track: pure pursuit on a point ahead along the centerline (offset
 * into its `lane`), a speed profile planned once from the bends (as fast as `corner` lets it
 * take them, braking at `brake` ahead of each), nitro on the straights, and backing out when
 * it's stuck. Pure: no three.js; nothing allocated per step.
 */
export class RaceDriver {
  /** Distance along the track (m), updated every `drive`. */
  s = -1;
  /** Offset off the centerline it aims for (m, + right). */
  lane: number;
  private profile: Float32Array;
  private stuck = 0;
  private reverse = 0;
  /** Where it was RESCUE_TIME seconds ago (its progress check). */
  private checkS = -1;
  private checkT = 0;
  /** It hasn't got anywhere for RESCUE_TIME seconds (wedged on a rail, tipped against another bus): put it back on the road. */
  needsRescue = false;
  private nose = { x: 0, y: 0, z: 0 };
  private aim = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  private out: DriveInput = { throttle: 0, steer: 0, handbrake: false, boost: false };

  constructor(
    private track: TrackData,
    readonly skill: DriverSkill,
    lane = 0,
  ) {
    this.lane = lane;
    this.profile = speedProfile(track, skill);
  }

  /** Put back on the road (after a rescue or a fall): the progress check starts over. */
  rescued(): void {
    this.s = -1;
    this.checkS = -1;
    this.checkT = 0;
    this.needsRescue = false;
    this.stuck = 0;
    this.reverse = 0;
  }

  /** The planned speed `s` meters along (m/s). */
  plannedAt(s: number): number {
    const i = Math.max(0, Math.min(this.profile.length - 1, Math.round(s / STEP)));
    return this.profile[i];
  }

  /**
   * `pace` scales the planned speed (rubber band, a launch gone wrong); `nitroReady`: the tank
   * can fire; `limit` (m/s): never faster (following a car it can't pass).
   */
  drive(bus: DrivenBus, dt: number, pace = 1, nitroReady = false, limit = Infinity): DriveInput {
    const t = this.track;
    const p = bus.nose(this.nose);
    const here = locateOnTrack(t, p, this.s, 60);
    this.s = here.s;
    const v = bus.speed;
    // Past the finish it pulls up on the runoff.
    const target = here.s > t.finish + 30 ? 0 : Math.min(this.skill.cruise * pace, this.plannedAt(here.s + 4) * pace, limit);
    const look = Math.max(8, Math.abs(v) * 0.75);
    const a = trackPoint(t, here.s + look, this.aim);
    const ax = a.x - a.dz * this.lane;
    const az = a.z + a.dx * this.lane;
    const err = wrap(Math.atan2(-(az - p.z), ax - p.x) - bus.heading);
    const o = this.out;
    o.throttle = target === 0 ? (v > 0.5 ? -1 : 0) : v < target - 0.6 ? 1 : v > target + 0.8 ? -1 : 0.25;
    o.steer = Math.max(-1, Math.min(1, -err * 2.4));
    o.handbrake = false;
    // Stuck against a rail or a wagon: back up for a moment, steering the other way.
    this.stuck = Math.abs(v) < 0.6 && this.reverse <= 0 && target > 1 ? this.stuck + dt : 0;
    if (this.stuck > 2) (this.reverse = 1.4), (this.stuck = 0);
    if (this.reverse > 0) {
      this.reverse -= dt;
      o.throttle = -1;
      o.steer = -o.steer;
    }
    // Still near where it was RESCUE_TIME seconds ago, while it means to be going: wedged.
    this.checkT += dt;
    if (this.checkS < 0 || here.s - this.checkS > RESCUE_DIST || target < 1) (this.checkS = here.s), (this.checkT = 0);
    this.needsRescue = this.checkT > RESCUE_TIME;
    o.boost = this.skill.nitro && nitroReady && limit === Infinity && this.reverse <= 0 && Math.abs(err) < 0.08 && target > v + 4 && this.plannedAt(here.s + 60) > v + 4;
    return o;
  }
}

/** A racer on the road: its front axle's meters along the track, offset off the middle (m, + right), speed (m/s), length (m). */
export interface RoadUser {
  s: number;
  off: number;
  v: number;
  len: number;
}

/** A traffic car on the track (`s` its middle): going our way (+1) or oncoming (-1). */
export interface TrafficCar extends RoadUser {
  dir: 1 | -1;
}

/** Passing: a racer this close ahead (m) in our lane sends us to the other half of the road, this far off the middle. */
const PASS_AHEAD = 22;
const PASS_LANE = 1.9;
/** A slower car this close ahead (m) in our lane is passed (or followed). */
const CAR_AHEAD = 45;
/** The other half of the road must be clear of oncoming cars this far ahead (m) to pass on it. */
const ONCOMING_CLEAR = 140;
/** Already alongside the car being passed: finish the pass unless an oncoming car is this close (m). */
const ONCOMING_ABORT = 45;
/** In the other half with an oncoming car closer than this (m): back to our own. */
const ONCOMING_BACK = 90;
/** With traffic on the road, rivals keep to the right half, this far off the middle (m). */
export const KEEP_RIGHT = 1.2;
/** An oncoming car this close (m): squeeze over this far right to meet it. */
const MEET = 70;
const MEET_RIGHT = 1.8;

/**
 * The lane a racer aims for and the speed it must keep under (m/s): its `home` lane, unless
 * something slower is close ahead in it (another racer, a car going our way). Then the other
 * half of the road, to pass instead of ramming it or squeezing between it and the rail, if that
 * half is clear of oncoming cars far enough ahead (passing on the right never meets one); else
 * it follows. A car stays "in the way" until it's behind our tail, so a pass is never cut back
 * in on it; caught alongside with an oncoming car close, it drops back behind it. Out in the
 * other half with an oncoming car near, it goes back to the right.
 */
export function chooseLane(me: RoadUser, racers: readonly RoadUser[], cars: readonly TrafficCar[], home: number): { lane: number; limit: number } {
  let gap = Infinity;
  let bOff = 0;
  let bV = 0;
  let beside = false;
  for (const o of racers) {
    const ahead = o.s - me.s;
    if (ahead > -4 && ahead < PASS_AHEAD && ahead < gap && Math.abs(o.off - me.off) < 2.8) (gap = ahead), (bOff = o.off), (bV = o.v);
  }
  let oncoming = Infinity;
  for (const c of cars) {
    const ahead = c.s - me.s;
    if (c.dir < 0) {
      if (ahead > -6 && ahead < oncoming) oncoming = ahead;
      continue;
    }
    // Its back past our nose (ahead), or its front still past our tail (alongside).
    const back = ahead - c.len / 2;
    const front = ahead + c.len / 2;
    if (front < -me.len - 2 || back > CAR_AHEAD || back > gap) continue;
    const alongside = back < 0;
    // In our lane (or the one we'd go back to), and slower: something to get past.
    if (Math.abs(c.off - me.off) > 2.6 && Math.abs(c.off - home) > 2.6) continue;
    if (!alongside && c.v > me.v + 2) continue;
    gap = Math.max(0, back);
    bOff = c.off;
    bV = c.v;
    beside = alongside;
  }
  // Our own half, well over to the right when meeting someone.
  const right = Math.max(home, oncoming < MEET ? MEET_RIGHT : KEEP_RIGHT);
  if (gap < Infinity) {
    const pass = bOff > 0 ? -PASS_LANE : PASS_LANE;
    if (pass > 0 || oncoming > (beside ? ONCOMING_ABORT : ONCOMING_CLEAR)) return { lane: pass, limit: Infinity };
    // Caught alongside: brake to drop back behind it, still in the other half until we have.
    if (beside) return { lane: pass, limit: Math.max(0, bV - 4) };
    return { lane: right, limit: bV + Math.max(0, gap - 14) * 0.4 };
  }
  if (oncoming < MEET || (me.off < 0 && oncoming < ONCOMING_BACK)) return { lane: right, limit: Infinity };
  return { lane: home, limit: Infinity };
}

/** The fastest speed at each point that the bends ahead allow, braking at `brake` for them. */
export function speedProfile(t: TrackData, skill: DriverSkill): Float32Array {
  const len = t.cum[t.cum.length - 1];
  const n = Math.floor(len / STEP) + 1;
  const v = new Float32Array(n);
  const a = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const b = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  for (let i = 0; i < n; i++) {
    trackPoint(t, i * STEP - CURVE_SPAN / 2, a);
    trackPoint(t, i * STEP + CURVE_SPAN / 2, b);
    const k = Math.abs(Math.asin(Math.max(-1, Math.min(1, a.dx * b.dz - a.dz * b.dx)))) / CURVE_SPAN;
    v[i] = Math.min(skill.cruise, Math.sqrt(skill.corner / Math.max(k, 1e-4)));
  }
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * skill.brake * STEP));
  return v;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
