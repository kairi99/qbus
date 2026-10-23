import type { DriveInput } from '../core/input';
import type { BusPreset } from '../vehicle/busPreset';
import { type TrackData, locateOnTrack, trackPoint } from '../world/track';
import type { SlideAdvice } from './landslides';

/**
 * What a vehicle can do, for a driver to plan with: cornering and braking (m/s²) on a dry road
 * and on a soaked one, top speed (m/s).
 */
export interface VehicleLimits {
  corner: number;
  brake: number;
  wetCorner: number;
  wetBrake: number;
  top: number;
  /** Top speed with the nitro burning (m/s). */
  boostTop: number;
}

/** Without measured limits (`BusPreset.race`): a bus's, cautiously. */
const DEFAULT_LIMITS = { corner: 5, brake: 5, wetCorner: 3.5, wetBrake: 3.5 };

/** A vehicle's limits from its preset (`race`, measured with `tools/sim-race.ts`). */
export function vehicleLimits(p: BusPreset): VehicleLimits {
  return { ...DEFAULT_LIMITS, ...p.race, top: p.topSpeedKmh / 3.6, boostTop: (p.topSpeedKmh + (p.nitro?.topSpeedBonusKmh ?? 0)) / 3.6 };
}

/**
 * How a driver takes the track, as shares of what its vehicle can do: cornering, braking, top
 * speed; how much speed it must have to gain before it fires the nitro (m/s, Infinity: never);
 * how much it eases off when ahead of the player (`ease`, 0..1 of the rubber band); and how
 * much clear road it wants to pass on the oncoming half (m).
 */
export interface DriverSkill {
  corner: number;
  brake: number;
  cruise: number;
  nitroGap: number;
  ease: number;
  passClear: number;
}

/** Hard drives the vehicle at its limits, burns nitro on every straight, never lets up when ahead, and passes on less road. */
export const SKILLS: Record<'easy' | 'normal' | 'hard', DriverSkill> = {
  easy: { corner: 0.6, brake: 0.7, cruise: 0.72, nitroGap: Infinity, ease: 1, passClear: 170 },
  normal: { corner: 0.8, brake: 0.85, cruise: 0.9, nitroGap: 4, ease: 0.5, passClear: 140 },
  hard: { corner: 1, brake: 1, cruise: 1, nitroGap: 1.5, ease: 0, passClear: 110 },
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
const G = 9.81;
/** Bends tighter than this radius (m) are planned with less than the measured grip (by the square of how much tighter). */
const TIGHT_BEND = 30;
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
  /** The same on a soaked road. */
  private wetProfile: Float32Array;
  /** How wet the road is (0 dry .. 1 soaked): the plan blends from the dry profile to the wet one. */
  wet = 0;
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

  /** Never faster than this (m/s): the skill's share of the top speed; and with the nitro burning. */
  private cruise: number;
  private boostTop: number;
  /** Asked for the nitro last step. */
  private boosting = false;

  constructor(
    private track: TrackData,
    readonly skill: DriverSkill,
    limits: VehicleLimits,
    lane = 0,
  ) {
    this.lane = lane;
    this.cruise = skill.cruise * limits.top;
    this.boostTop = skill.nitroGap < Infinity ? Math.max(this.cruise, limits.boostTop) : this.cruise;
    // The bends' limits up to the nitro's top speed (`drive` holds it to `cruise` without it).
    this.profile = speedProfile(track, skill.corner * limits.corner, skill.brake * limits.brake, this.boostTop);
    this.wetProfile = speedProfile(track, skill.corner * limits.wetCorner, skill.brake * limits.wetBrake, this.boostTop);
  }

  /** Its front axle has been over the finish line: it brakes to a stop (stays set through a rescue). */
  get finished(): boolean {
    return this.over;
  }
  private over = false;

  /** A new race: not finished any more. */
  newRace(): void {
    this.over = false;
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
    return this.profile[i] + (this.wetProfile[i] - this.profile[i]) * this.wet;
  }

  /**
   * `pace` scales the planned speed (rubber band, a launch gone wrong; over 1 only on the
   * straights: the bends are planned at the grip's limit); `nitro`: the tank can fire (or is
   * burning); `limit` (m/s): never faster (following a car it can't pass).
   */
  drive(bus: DrivenBus, dt: number, pace = 1, nitro = false, limit = Infinity): DriveInput {
    const t = this.track;
    const p = bus.nose(this.nose);
    const here = locateOnTrack(t, p, this.s, 60);
    this.s = here.s;
    if (here.s >= t.finish) this.over = true;
    const v = bus.speed;
    // What the bends allow, and on top of that the top speed (higher with the nitro burning).
    const bends = Math.min(this.plannedAt(here.s + 4) * Math.min(1, pace), limit);
    const top = this.boosting && nitro ? this.boostTop : this.cruise * pace;
    // Over the line it brakes to a stop in its lane (a ghost by then, so it can sit on the runoff).
    const target = this.over ? 0 : Math.min(top, bends);
    const look = Math.max(8, Math.abs(v) * 0.75);
    const a = trackPoint(t, here.s + look, this.aim);
    const ax = a.x - a.dz * this.lane;
    const az = a.z + a.dx * this.lane;
    const err = wrap(Math.atan2(-(az - p.z), ax - p.x) - bus.heading);
    const o = this.out;
    // Over the target: brakes for a bend (or a car ahead), but only lifts off past its top speed (after a burst of nitro).
    o.throttle = target === 0 ? (v > 0.5 ? -1 : 0) : v < target - 0.6 ? 1 : v > bends + 0.8 ? -1 : v > target + 0.8 ? 0 : 0.25;
    o.steer = Math.max(-1, Math.min(1, -err * 2.4));
    // Stopped past the line: the handbrake holds it (a downhill runoff would let it roll).
    o.handbrake = this.over && Math.abs(v) < 2;
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
    // Nitro where the road ahead lets it go faster for a while (and a burst runs on while it does).
    const gap = this.skill.nitroGap;
    o.boost = nitro && limit === Infinity && this.reverse <= 0 && Math.abs(err) < 0.1 && here.s < t.finish && bends > v + gap && this.plannedAt(here.s + 60) > v + gap;
    this.boosting = o.boost;
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
/** The other half of the road must be clear of oncoming cars this far ahead (m) to pass on it (by default: `DriverSkill.passClear`). */
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
/** Waiting for an oncoming car to pass before it takes the oncoming half past a slide: braking at this (m/s²). */
const HOLD_BRAKE = 4;
/** No pass starts inside a tunnel or this close (m) before its portal: about what a pass takes. */
export const TUNNEL_NO_PASS = 70;
/** Inside a tunnel (or this close before one) with traffic about: stay in the right half; back to it for an oncoming car this close (m). */
const TUNNEL_BACK = 180;

/**
 * The lane a racer aims for and the speed it must keep under (m/s): its `home` lane, unless
 * something slower is close ahead in it (another racer, a car going our way). Then the other
 * half of the road, to pass instead of ramming it or squeezing between it and the rail, if that
 * half is clear of oncoming cars far enough ahead (passing on the right never meets one); else
 * it follows. A car stays "in the way" until it's behind our tail, so a pass is never cut back
 * in on it; caught alongside with an oncoming car close, it drops back behind it. Out in the
 * other half with an oncoming car near, it goes back to the right.
 * In a tunnel (`tunnels`) it
 * never starts a pass (one already alongside is finished) and goes back right for an oncoming
 * car from further off.
 * A landslide ahead (`slide`: its open lane, the speed to arrive at) overrides all that: the open
 * lane, following whoever is ahead in it; if that is the oncoming half it waits short of the
 * debris for an oncoming car to go by.
 */
export function chooseLane(me: RoadUser, racers: readonly RoadUser[], cars: readonly TrafficCar[], home: number, passClear = ONCOMING_CLEAR, slide: SlideAdvice | null = null, tunnels: readonly { s0: number; s1: number }[] | null = null): { lane: number; limit: number } {
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
  if (slide && !Number.isNaN(slide.lane)) {
    let limit = slide.limit;
    if (gap < Infinity) limit = Math.min(limit, bV + Math.max(0, gap - 14) * 0.4);
    // The open half is the oncoming one: not in it with a car coming (unless already in the debris).
    if (slide.lane < 0 && oncoming < passClear && me.s < slide.s0 + 4) limit = Math.min(limit, Math.sqrt(2 * HOLD_BRAKE * Math.max(0, slide.s0 - me.s - 8)));
    const lane = slide.lane < 0 && oncoming < passClear && me.s < slide.s0 + 4 ? Math.max(home, KEEP_RIGHT) : slide.lane;
    return { lane: home + (lane - home) * slide.ramp, limit };
  }
  // In a bore (or about to enter one) no pass starts, and with traffic about we stay right.
  const bore = !!tunnels && tunnels.some((u) => me.s >= u.s0 - TUNNEL_NO_PASS && me.s <= u.s1);
  const out = me.off < -0.8;
  // Our own half, well over to the right when meeting someone.
  const right = Math.max(home, oncoming < MEET || (bore && oncoming < TUNNEL_BACK) ? MEET_RIGHT : KEEP_RIGHT);
  if (gap < Infinity) {
    const pass = bOff > 0 ? -PASS_LANE : PASS_LANE;
    if (pass > 0 || (oncoming > (beside ? ONCOMING_ABORT : passClear) && (!bore || out))) return { lane: pass, limit: Infinity };
    // Caught alongside: brake to drop back behind it, still in the other half until we have.
    if (beside) return { lane: pass, limit: Math.max(0, bV - 4) };
    return { lane: right, limit: bV + Math.max(0, gap - 14) * 0.4 };
  }
  if (oncoming < MEET || (me.off < 0 && oncoming < (bore ? TUNNEL_BACK : ONCOMING_BACK))) return { lane: right, limit: Infinity };
  return { lane: home, limit: Infinity };
}

/** The fastest speed at each point (never over `cruise`) that the bends ahead allow, cornering at `corner` and braking at `brake` for them. */
export function speedProfile(t: TrackData, corner: number, brake: number, cruise: number): Float32Array {
  const len = t.cum[t.cum.length - 1];
  const n = Math.floor(len / STEP) + 1;
  const v = new Float32Array(n);
  const a = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const b = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = trackPoint(t, i * STEP, a).y;
    trackPoint(t, i * STEP - CURVE_SPAN / 2, a);
    trackPoint(t, i * STEP + CURVE_SPAN / 2, b);
    const k = Math.abs(Math.asin(Math.max(-1, Math.min(1, a.dx * b.dz - a.dz * b.dx)))) / CURVE_SPAN;
    // A hairpin tighter than TIGHT_BEND (the Silante's) takes less than the measured grip: the
    // lane's line round it runs out of steering, and the bus runs wide into the bank.
    const tight = Math.min(1, 1 / (Math.max(k, 1e-4) * TIGHT_BEND)) ** 2;
    v[i] = Math.min(cruise, Math.sqrt((corner * tight) / Math.max(k, 1e-4)));
  }
  // Braking downhill takes longer (gravity pulls on), uphill shorter: the Silante drops 11%.
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * Math.max(1, brake + (G * (y[i + 1] - y[i])) / STEP) * STEP));
  return v;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
