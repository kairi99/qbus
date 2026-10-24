import type { DriveInput } from '../core/input';
import type { BusPreset } from '../vehicle/busPreset';
import { type TrackData, lapOf, locateOnTrack, trackPoint } from '../world/track';
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
  /** Body width and length (m): a street circuit's line keeps this much room to the barriers (the rear swings inside a bend). */
  width?: number;
  length?: number;
}

/** Without measured limits (`BusPreset.race`): a bus's, cautiously. */
const DEFAULT_LIMITS = { corner: 5, brake: 5, wetCorner: 3.5, wetBrake: 3.5 };

/** A vehicle's limits from its preset (`race`, measured with `tools/sim-race.ts`). */
export function vehicleLimits(p: BusPreset): VehicleLimits {
  return { ...DEFAULT_LIMITS, ...p.race, width: p.body.width, length: p.body.length, top: p.topSpeedKmh / 3.6, boostTop: (p.topSpeedKmh + (p.nitro?.topSpeedBonusKmh ?? 0)) / 3.6 };
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
  /** The lap `s` was last on (a circuit: where the search after a rescue starts). */
  lap = 1;
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

  /** A street circuit's racing line (offsets off the centerline every `STEP` m), else null. */
  private line: RacingLine | null;

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
    this.line = track.edges ? racingLine(track, (limits.width ?? DEFAULT_WIDTH) / 2, limits.length ?? DEFAULT_LENGTH) : null;
    // The bends' limits up to the nitro's top speed (`drive` holds it to `cruise` without it).
    this.profile = speedProfile(track, skill.corner * limits.corner, skill.brake * limits.brake, this.boostTop, this.line);
    this.wetProfile = speedProfile(track, skill.corner * limits.wetCorner, skill.brake * limits.wetBrake, this.boostTop, this.line);
  }

  /** Its front axle has been over the finish line: it brakes to a stop (stays set through a rescue). */
  get finished(): boolean {
    return this.over;
  }
  private over = false;

  /** A new race: not finished any more. */
  newRace(): void {
    this.over = false;
    this.lap = 1;
  }

  /** Put back on the road (after a rescue or a fall): the progress check starts over. `at`: where, if known (a circuit's laps overlap, so the search wants it). */
  rescued(at = -1): void {
    this.s = at;
    this.checkS = -1;
    this.checkT = 0;
    this.needsRescue = false;
    this.stuck = 0;
    this.reverse = 0;
  }

  /** Where the racing line runs `s` meters along (m, + right of the centerline; 0 without one). */
  lineAt(s: number): number {
    return this.line ? sampleAt(this.line.off, s) : 0;
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
    const here = locateOnTrack(t, p, this.s, 60, this.lap);
    this.s = here.s;
    this.lap = lapOf(t, here.s);
    if (here.s >= t.finish) this.over = true;
    const v = bus.speed;
    // What the bends allow, and on top of that the top speed (higher with the nitro burning).
    const bends = Math.min(this.plannedAt(here.s + 4) * Math.min(1, pace), limit);
    const top = this.boosting && nitro ? this.boostTop : this.cruise * pace;
    // Over the line it brakes to a stop in its lane (a ghost by then, so it can sit on the runoff).
    const target = this.over ? 0 : Math.min(top, bends);
    // A circuit's corners are short: a shorter look-ahead cuts them less (pure pursuit swings inside the line).
    const look = this.line ? Math.max(LOOK_MIN, Math.abs(v) * LOOK_TIME) : Math.max(8, Math.abs(v) * 0.75);
    const a = trackPoint(t, here.s + look, this.aim);
    // A circuit: the racing line, with the lane (a pass) on top, never nearer a barrier than the line's own clearance.
    const side = this.line ? Math.max(sampleAt(this.line.min, here.s + look), Math.min(sampleAt(this.line.max, here.s + look), this.lane + sampleAt(this.line.off, here.s + look))) : this.lane;
    const ax = a.x - a.dz * side;
    const az = a.z + a.dx * side;
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

/** How far a street circuit's course reaches either side of the centerline (m, both positive), less what a vehicle needs next to a barrier. */
export interface CourseRoom {
  left: number;
  right: number;
  /** The lap's length (m): racers a lap apart share the road. */
  lap: number;
}

/** `out` = the room at `s` meters along a circuit (its barrier offsets less the line's clearance and a typical half width). */
export function courseRoom(t: TrackData, s: number, out: CourseRoom): CourseRoom {
  // The narrowest of here and the next 25 m: a pass started on a wide spot must still fit where the street pinches.
  out.left = Infinity;
  out.right = Infinity;
  for (let ahead = 0; ahead <= ROOM_LOOK; ahead += ROOM_LOOK / 2) {
    edgesAt(t, s + ahead, EDGES);
    out.left = Math.min(out.left, EDGES[0] - BARRIER_GAP - DEFAULT_WIDTH / 2);
    out.right = Math.min(out.right, EDGES[1] - BARRIER_GAP - DEFAULT_WIDTH / 2);
  }
  out.lap = t.circuit?.lap ?? 1e9;
  return out;
}
/** `courseRoom` looks this far ahead (m). */
const ROOM_LOOK = 25;
const EDGES = new Float64Array(3);

/** A traffic car on the track (`s` its middle): going our way (+1) or oncoming (-1). */
export interface TrafficCar extends RoadUser {
  dir: 1 | -1;
}

/** Passing: a racer this close ahead (m) in our lane sends us to the other half of the road, this far off the middle. */
const PASS_AHEAD = 22;
const PASS_LANE = 1.9;
/** A circuit racer ahead going this much faster (m/s) is not passed. */
const FASTER = 1;
/** A circuit pass needs this much room (m) on its side; with less it takes the other, with neither it follows. */
const PASS_ROOM = 1.5;
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
 * On a street circuit (`room`: how far the course reaches either side of the centerline here) everyone
 * drives the same way, so there is no oncoming half to wait for: a pass starts whenever there is room, on
 * the side of the car with more of it (the lane no wider than that room).
 * A landslide ahead (`slide`: its open lane, the speed to arrive at) overrides all that: the open
 * lane, following whoever is ahead in it; if that is the oncoming half it waits short of the
 * debris for an oncoming car to go by.
 */
export function chooseLane(me: RoadUser, racers: readonly RoadUser[], cars: readonly TrafficCar[], home: number, passClear = ONCOMING_CLEAR, slide: SlideAdvice | null = null, tunnels: readonly { s0: number; s1: number }[] | null = null, room: CourseRoom | null = null): { lane: number; limit: number } {
  let gap = Infinity;
  let bOff = 0;
  let bV = 0;
  let beside = false;
  for (const o of racers) {
    // A circuit: a racer a lap (or more) down is just ahead or behind on the same road, so a lapped car is a slower one in the way.
    let ahead = o.s - me.s;
    if (room) ahead -= Math.round(ahead / room.lap) * room.lap;
    // On a circuit a faster racer ahead is just followed home: nobody swings out to pass what is pulling away.
    if (room && ahead > 0 && o.v > me.v + FASTER) continue;
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
    let pass = bOff > (room ? me.off : 0) ? -PASS_LANE : PASS_LANE;
    if (room) {
      // Room each side of us (m) between the barriers' clearance: the side away from the car if it fits, else the other, else follow.
      const away = pass > 0 ? room.right - me.off : room.left + me.off;
      const other = pass > 0 ? room.left + me.off : room.right - me.off;
      if (away < PASS_ROOM && other < PASS_ROOM) return { lane: home, limit: bV + Math.max(0, gap - 14) * 0.4 };
      if (away < PASS_ROOM) pass = -pass;
      return { lane: Math.sign(pass) * Math.min(PASS_LANE, pass > 0 ? room.right - me.off : room.left + me.off), limit: Infinity };
    }
    if (pass > 0 || (oncoming > (beside ? ONCOMING_ABORT : passClear) && (!bore || out))) return { lane: pass, limit: Infinity };
    // Caught alongside: brake to drop back behind it, still in the other half until we have.
    if (beside) return { lane: pass, limit: Math.max(0, bV - 4) };
    return { lane: right, limit: bV + Math.max(0, gap - 14) * 0.4 };
  }
  if (oncoming < MEET || (me.off < 0 && oncoming < (bore ? TUNNEL_BACK : ONCOMING_BACK))) return { lane: right, limit: Infinity };
  return { lane: home, limit: Infinity };
}

/** The fastest speed at each point (never over `cruise`) that the bends ahead allow, cornering at `corner` and braking at `brake` for them. On a circuit the bends are the racing `line`'s, not the centerline's. */
export function speedProfile(t: TrackData, corner: number, brake: number, cruise: number, line: RacingLine | null = null): Float32Array {
  const len = t.cum[t.cum.length - 1];
  const n = Math.floor(len / STEP) + 1;
  const v = new Float32Array(n);
  const a = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const b = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const y = new Float32Array(n);
  const bends = line ? lineCurvature(t, line, n) : null;
  for (let i = 0; i < n; i++) {
    y[i] = trackPoint(t, i * STEP, a).y;
    let k: number;
    if (bends) k = Math.abs(bends[i]);
    else {
      trackPoint(t, i * STEP - CURVE_SPAN / 2, a);
      trackPoint(t, i * STEP + CURVE_SPAN / 2, b);
      k = Math.abs(Math.asin(Math.max(-1, Math.min(1, a.dx * b.dz - a.dz * b.dx)))) / CURVE_SPAN;
    }
    // A hairpin tighter than TIGHT_BEND (the Silante's) takes less than the measured grip: the
    // lane's line round it runs out of steering, and the bus runs wide into the bank.
    const tight = Math.min(1, 1 / (Math.max(k, 1e-4) * TIGHT_BEND)) ** 2;
    v[i] = Math.min(cruise, Math.sqrt((corner * tight) / Math.max(k, 1e-4)));
  }
  // Braking downhill takes longer (gravity pulls on), uphill shorter: the Silante drops 11%.
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * Math.max(1, brake + (G * (y[i + 1] - y[i])) / STEP) * STEP));
  return v;
}

/** A street circuit's racing line: where to aim, every `STEP` m along the unrolled track. */
export interface RacingLine {
  /** Offset off the centerline (m, + right) of the line. */
  off: Float32Array;
  /** The nearest to each barrier a vehicle's side may come (as offsets, left negative): a pass stays between them. */
  min: Float32Array;
  max: Float32Array;
}

/** A circuit's look-ahead: at least this far (m), this many seconds of speed. */
const LOOK_MIN = 4;
const LOOK_TIME = 0.3;
/** Fallback body width (m) for limits without one. */
const DEFAULT_WIDTH = 2.5;
const DEFAULT_LENGTH = 11;
/** Inside a bend the rear of a vehicle `len` m long swings in about this much (m) per 1/m of curvature, per m² of length: the line keeps that much more off the inner barrier (at most `SWING_MAX`). */
const SWING = 1 / 5;
const SWING_MAX = 4.5;
/** Nearest a vehicle's side comes to a barrier along the line (m): 1 m clearance and half a meter for the pursuit's slack. */
export const BARRIER_GAP = 1.5;
/** A stretch turning more than this (rad) over `CURVE_SPAN` is a corner. */
const CORNER_TURN = 0.12;
/** The course opens up to the barriers this far (m) before and after a corner: where the line may swing out and in. */
const CORNER_REACH = 45;
/** Steps the line gets at most, and the relative drop in cost under which it is settled. */
const LINE_STEPS = 3000;
const LINE_SETTLED = 1e-11;
const lines = new WeakMap<TrackData, Map<number, RacingLine>>();

/** Barrier offsets (m) and carriageway half width at `s`: `out` = [left, right, road]. */
function edgesAt(t: TrackData, s: number, out: Float64Array): void {
  const e = t.edges!;
  const { cum } = t;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const u = Math.max(0, Math.min(1, (s - cum[lo]) / (cum[hi] - cum[lo] || 1)));
  out[0] = e.left[lo] + (e.left[hi] - e.left[lo]) * u;
  out[1] = e.right[lo] + (e.right[hi] - e.right[lo]) * u;
  out[2] = e.road ? e.road[lo] + (e.road[hi] - e.road[lo]) * u : Math.min(out[0], out[1]);
}

/**
 * The line a vehicle `half` m wide takes round a street circuit: on the straights inside the carriageway,
 * in the corners anywhere up to `BARRIER_GAP` off the barriers (they open `CORNER_REACH` m before and
 * after the corner, so it swings out, in to the apex and out again). Within those bounds it is the line of
 * least curvature (sum of squared curvature, projected Newton solve, `solveLine`), which is the widest one round each bend.
 * Planned once per track and width.
 */
export function racingLine(t: TrackData, half: number, len = DEFAULT_LENGTH): RacingLine {
  let byWidth = lines.get(t);
  if (!byWidth) lines.set(t, (byWidth = new Map()));
  const key = Math.round(half * 100) * 1000 + Math.round(len * 10);
  const cached = byWidth.get(key);
  if (cached) return cached;
  const total = t.cum[t.cum.length - 1];
  const n = Math.floor(total / STEP) + 1;
  const a = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const b = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const k = new Float64Array(n);
  const corner = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    trackPoint(t, i * STEP - CURVE_SPAN / 2, a);
    trackPoint(t, i * STEP + CURVE_SPAN / 2, b);
    const turn = Math.asin(Math.max(-1, Math.min(1, a.dx * b.dz - a.dz * b.dx)));
    k[i] = turn / CURVE_SPAN;
    corner[i] = Math.abs(turn) > CORNER_TURN ? 1 : 0;
  }
  const reach = Math.ceil(CORNER_REACH / STEP);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  const e = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    // 0 on a straight .. 1 in (and next to) a corner.
    let open = 0;
    for (let j = Math.max(0, i - reach); j <= Math.min(n - 1, i + reach); j++) if (corner[j]) open = Math.max(open, 1 - Math.abs(j - i) / (reach + 1));
    edgesAt(t, i * STEP, e);
    const fullL = e[0] - BARRIER_GAP - half;
    const fullR = e[1] - BARRIER_GAP - half;
    const roadL = Math.min(e[2] - half, fullL);
    const roadR = Math.min(e[2] - half, fullR);
    min[i] = -fullL;
    max[i] = fullR;
    // A gap narrower than the clearances both sides: the middle of what is left.
    if (min[i] > max[i]) min[i] = max[i] = (min[i] + max[i]) / 2;
    // The inner side of a bend gives the swinging rear its room.
    const swing = Math.min(SWING_MAX, Math.abs(k[i]) * len * len * SWING) * open;
    lo[i] = -(roadL + (fullL - roadL) * open) + (k[i] < 0 ? swing : 0);
    hi[i] = roadR + (fullR - roadR) * open - (k[i] > 0 ? swing : 0);
    if (lo[i] > hi[i]) lo[i] = hi[i] = (lo[i] + hi[i]) / 2;
  }
  const x = solveLine(k, lo, hi);
  const line: RacingLine = { off: Float32Array.from(x), min, max };
  byWidth.set(key, line);
  return line;
}

/**
 * Offsets `x` (m) within [lo, hi] that minimise the sum of squared line curvature, with the centerline's
 * curvature `k` (1/m, + right): curvature j = k + k^2 x + the second difference of x over `STEP`. A projected
 * Newton method: the samples at a bound stay put, the free ones solve their (pentadiagonal) system exactly,
 * the step is cut until the cost falls. Sweeping sample by sample needed far more than 40000 sweeps.
 */
function solveLine(k: Float64Array, lo: Float64Array, hi: Float64Array): Float64Array {
  const n = k.length;
  const h2 = 1 / (STEP * STEP);
  const x = new Float64Array(n);
  const r = new Float64Array(n);
  const g = new Float64Array(n);
  const c = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    c[i] = k[i] * k[i] - 2 * h2;
    x[i] = Math.max(lo[i], Math.min(hi[i], 0));
  }
  const cost = (v: Float64Array) => {
    let sum = 0;
    for (let j = 1; j < n - 1; j++) {
      const q = k[j] + c[j] * v[j] + (v[j - 1] + v[j + 1]) * h2;
      sum += q * q;
    }
    return sum;
  };
  const trial = new Float64Array(n);
  const d = new Float64Array(n);
  const free = new Uint8Array(n);
  // Band system scratch (one free run at a time): diagonal, first and second off-diagonals, right side.
  const d0 = new Float64Array(n);
  const d1 = new Float64Array(n);
  const d2 = new Float64Array(n);
  const rhs = new Float64Array(n);
  let damp = 1e-3;
  let calm = 0;
  for (let step = 0; step < LINE_STEPS; step++) {
    for (let j = 1; j < n - 1; j++) r[j] = k[j] + c[j] * x[j] + (x[j - 1] + x[j + 1]) * h2;
    for (let i = 2; i < n - 2; i++) {
      g[i] = 2 * (h2 * r[i - 1] + c[i] * r[i] + h2 * r[i + 1]);
      const atLo = x[i] <= lo[i] + 1e-9 && g[i] > 0;
      const atHi = x[i] >= hi[i] - 1e-9 && g[i] < 0;
      free[i] = atLo || atHi || hi[i] - lo[i] < 1e-9 ? 0 : 1;
      d[i] = 0;
    }
    for (let i = 2; i < n - 2; ) {
      if (!free[i]) {
        i++;
        continue;
      }
      let e = i;
      while (e + 1 < n - 2 && free[e + 1]) e++;
      const m = e - i + 1;
      for (let q = 0; q < m; q++) {
        const p = i + q;
        d0[q] = 2 * (2 * h2 * h2 + c[p] * c[p]) + damp;
        d1[q] = 2 * h2 * (c[p] + c[p + 1]);
        d2[q] = 2 * h2 * h2;
        rhs[q] = g[p];
      }
      // Gaussian elimination of the symmetric band matrix (no pivoting: it is positive definite), then back substitution.
      for (let q = 0; q < m; q++) {
        for (let t = 1; t <= 2 && q + t < m; t++) {
          const fq = (t === 1 ? d1[q] : d2[q]) / d0[q];
          rhs[q + t] -= fq * rhs[q];
          for (let u = t; u <= 2; u++) {
            const up = u === 1 ? d1[q] : d2[q];
            const row = q + t;
            if (u === t) d0[row] -= fq * up;
            else if (u - t === 1) d1[row] -= fq * up;
            else d2[row] -= fq * up;
          }
        }
      }
      for (let q = m - 1; q >= 0; q--) {
        const v = rhs[q] - (q + 1 < m ? d1[q] * d[i + q + 1] : 0) - (q + 2 < m ? d2[q] * d[i + q + 2] : 0);
        d[i + q] = v / d0[q];
      }
      i = e + 1;
    }
    // Levenberg-Marquardt: a step that lowers the cost is kept and the damping eased, else dropped and the damping raised.
    const was = cost(x);
    for (let i = 0; i < n; i++) trial[i] = Math.max(lo[i], Math.min(hi[i], x[i] - d[i]));
    const now = cost(trial);
    if (now < was) {
      x.set(trial);
      damp = Math.max(1e-10, damp / 3);
      if (was - now < LINE_SETTLED * was && ++calm >= 3) break;
    } else {
      damp *= 4;
      calm = 0;
    }
  }
  return x;
}

/** A line's value `s` meters along (linear between the samples). */
function sampleAt(arr: Float32Array, s: number): number {
  const f = Math.max(0, Math.min(arr.length - 1, s / STEP));
  const i = Math.min(arr.length - 2, Math.floor(f));
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}

/** Signed curvature (1/m, + right) of the racing line's own path at each sample: the heading change over `CURVE_SPAN` m, from chords. */
function lineCurvature(t: TrackData, line: RacingLine, n: number): Float32Array {
  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  const q = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  for (let i = 0; i < n; i++) {
    trackPoint(t, i * STEP, q);
    px[i] = q.x - q.dz * line.off[i];
    pz[i] = q.z + q.dx * line.off[i];
  }
  const out = new Float32Array(n);
  const at = (i: number) => Math.max(0, Math.min(n - 1, i));
  // Chords of 12 m centered 12 m before and after.
  for (let i = 0; i < n; i++) {
    const ax = px[at(i - 2)] - px[at(i - 6)];
    const az = pz[at(i - 2)] - pz[at(i - 6)];
    const bx = px[at(i + 6)] - px[at(i + 2)];
    const bz = pz[at(i + 6)] - pz[at(i + 2)];
    const cross = (ax * bz - az * bx) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
    out[i] = Math.asin(Math.max(-1, Math.min(1, cross))) / CURVE_SPAN;
  }
  return out;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
