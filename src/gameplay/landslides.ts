import { Rng } from '../core/rng';
import type { Vec2 } from '../world/cityData';
import { type TrackData, trackPoint } from '../world/track';

/**
 * Landslides on a race track (pure: no three.js, no Rapier). Everything is a function of the
 * track, a seed and the race time since GO, so every client of an online race computes the same
 * slides at the same moment with nothing sent: a warning (rumble, dust, pebbles off the cut),
 * boulders rolling down the uphill slope onto the road, then they stay with a mud tongue over
 * the uphill lane. The downhill half of the road always stays open.
 */

/** Seconds of warning, then of falling; the debris stays from `trigger + WARN + FALL` on. */
export const WARN = 4;
export const FALL = 2;

export type SlidePhase = 'idle' | 'warning' | 'falling' | 'settled';

/** A boulder's pose: position of its center, rotation as a quaternion. */
export interface BoulderPose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface Boulder {
  /** Radius (m): the mesh never reaches past it. */
  r: number;
  /** Where it rests, and where it hangs on the slope until it falls (centers). */
  rest: { x: number; y: number; z: number };
  start: { x: number; y: number; z: number };
  /** Horizontal unit axis it rolls about. */
  axis: { x: number; z: number };
  /** Its place in the road's own terms: meters along and offset toward the uphill side (m, + = uphill) at rest and at the start. */
  restAt: { s: number; u: number };
  startAt: { s: number; u: number };
  /** Seconds after the fall begins that it lets go. */
  delay: number;
  /** Bounces on the way down. */
  bounces: number;
  /** Height of the center along the way, from the ground under the path (N samples, start to rest). */
  profile: number[];
  /** Total rolling angle (rad). */
  spin: number;
}

export interface SlideSite {
  /** Middle of the debris (m along the track), and the mud tongue's length. */
  s: number;
  len: number;
  /** Which side the slope is on: 1 = right of the way to the finish, -1 = left (`TrackData.rails`' convention). */
  side: 1 | -1;
  /** Where its middle is in the world (x, z). */
  at: Vec2;
  /** Race time (s since GO) the warning starts. */
  trigger: number;
  boulders: Boulder[];
  /** Phases of the tongue's ragged edge (seeded). */
  shape: [number, number, number];
}

/** A stretch of mud that is always there: a stream crossing under the road. */
export interface MudPatch {
  s: number;
  len: number;
  level: number;
}

export interface SlideField {
  sites: SlideSite[];
  patches: MudPatch[];
}

/** Which tracks have landslides (RaceSession's default for its `slides` option). */
export const SLIDE_TRACKS: ReadonlySet<string> = new Set(['silante']);

/** A quick leader's pace (m/s) the schedule aims the falls ahead of, jittered per site. */
const LEAD_PACE = 25;
/** The earliest a warning starts (s after GO). */
const MIN_TRIGGER = 8;
/** No slide within this of the start line, the finish, or a nitro pickup (m). */
const FROM_START = 400;
const BEFORE_FINISH = 300;
const FROM_PICKUP = 60;
/** The AI must be able to swerve: radius (m) of the tightest bend within the site. */
const MIN_RADIUS = 40;
/** The slope must climb this much (m) within this far (m) past the road edge. */
const RISE = 4;
const RISE_WITHIN = 12;
/** Boulders stay this far (m) from the centerline: the downhill half is theirs never. */
export const OPEN_MARGIN = 0.4;
const SAMPLES = 14;
/** Mud: grip multiplier at full depth and extra drag are the vehicle's business; here only the tongue. */
const PATCH_LEN = 15;
const PATCH_LEVEL = 0.5;
/** The mud spills this far (m) over the centerline, fading out. */
const SPILL = 1.5;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smooth = (a: number, b: number, x: number) => {
  const k = clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};

/** World position `u` meters toward `side` of the centerline at `s`. */
function place(track: TrackData, s: number, u: number, side: number): { x: number; z: number; y: number } {
  const q = trackPoint(track, s);
  const off = u * side;
  return { x: q.x - q.dz * off, z: q.z + q.dx * off, y: q.y };
}

/** Radius of the bend at `s` (m), over `span` either side. */
function bendRadius(track: TrackData, s: number, span: number): number {
  const a = trackPoint(track, s - span);
  const b = trackPoint(track, s);
  const c = trackPoint(track, s + span);
  const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return (Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(a.x - c.x, a.z - c.z)) / (2 * cross || 1e-9);
}

/** How much higher the ground is `RISE_WITHIN` m past the edge than the road, at `s`, on `side`. */
function rise(track: TrackData, s: number, side: number, ground: (p: Vec2) => number): number {
  const p = place(track, s, track.width / 2 + RISE_WITHIN, side);
  return ground(p) - p.y;
}

/** A site's boulders: rest poses on the uphill half, start poses up the slope at the ground's height. */
function makeBoulders(track: TrackData, s: number, len: number, side: 1 | -1, count: number, rng: Rng, ground: (p: Vec2) => number): Boulder[] {
  const hw = track.width / 2;
  const out: Boulder[] = [];
  const placed: { s: number; u: number; r: number }[] = [];
  for (let k = 0; k < count; k++) {
    let r = rng.range(0.8, 1.7);
    let at = { s: s, u: hw };
    for (let tries = 0; tries < 40; tries++) {
      // Smaller after every few failed tries so a crowded tongue still fits them all.
      if (tries && tries % 10 === 0) r = Math.max(0.7, r * 0.85);
      const cs = s + rng.range(-(len / 2 - 6), len / 2 - 6);
      const cu = rng.range(OPEN_MARGIN + r + 0.1, hw + 0.4);
      if (placed.every((o) => Math.hypot(o.s - cs, o.u - cu) > o.r + r + 0.3)) {
        at = { s: cs, u: cu };
        break;
      }
    }
    placed.push({ ...at, r });
    const startAt = { s: at.s + rng.range(-3, 3), u: hw + rng.range(10, 18) };
    const pr = place(track, at.s, at.u, side);
    const ps = place(track, startAt.s, startAt.u, side);
    // The center rides 0.9 r over the ground: the mesh bulges a little into it.
    const lift = 0.9 * r;
    const profile: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const f = i / (SAMPLES - 1);
      const sp = place(track, startAt.s + (at.s - startAt.s) * f, startAt.u + (at.u - startAt.u) * f, side);
      profile.push(Math.max(ground(sp), sp.y) + lift);
    }
    profile[SAMPLES - 1] = pr.y + lift;
    const dx = pr.x - ps.x;
    const dz = pr.z - ps.z;
    const d = Math.hypot(dx, dz) || 1;
    const dist = Math.hypot(d, profile[0] - profile[SAMPLES - 1]);
    out.push({
      r,
      rest: { x: pr.x, y: pr.y + lift, z: pr.z },
      start: { x: ps.x, y: profile[0], z: ps.z },
      axis: { x: dz / d, z: -dx / d },
      restAt: at,
      startAt,
      delay: rng.range(0, 0.7),
      bounces: rng.int(2, 4),
      profile,
      spin: dist / r,
    });
  }
  return out;
}

/**
 * The landslides of a race: 3 sites (4 on a track raced over 4.5 km) on the uphill side of the
 * road, one per equal segment of the race, each a seeded pick among the places that qualify
 * (`ground` gives the terrain's height). Away from the start, the finish, the nitro pickups and
 * from any bend a bus could not swerve in; the schedule has each one fall ahead of a quick leader.
 */
export function slideSites(track: TrackData, seed: number, ground: (p: Vec2) => number): SlideSite[] {
  const rng = new Rng((seed ^ 0x5a17de) >>> 0);
  const raced = track.finish - track.start;
  const n = raced > 4500 ? 4 : 3;
  const from = track.start + FROM_START;
  const to = track.finish - BEFORE_FINISH;
  const seg = (to - from) / n;
  const sites: SlideSite[] = [];
  for (let i = 0; i < n; i++) {
    // The middle 70% of the segment: neighbors stay a good way apart.
    const lo = from + (i + 0.15) * seg;
    const hi = from + (i + 0.85) * seg;
    const found: { s: number; side: 1 | -1 }[] = [];
    for (let s = lo; s <= hi; s += 10) {
      if (track.pickups.some((p) => Math.abs(p.s - s) < FROM_PICKUP + 30)) continue;
      let ok = true;
      for (let d = -30; d <= 30 && ok; d += 15) ok = bendRadius(track, s + d, 15) >= MIN_RADIUS;
      if (!ok) continue;
      const right = Math.min(rise(track, s - 20, 1, ground), rise(track, s, 1, ground), rise(track, s + 20, 1, ground));
      const left = Math.min(rise(track, s - 20, -1, ground), rise(track, s, -1, ground), rise(track, s + 20, -1, ground));
      const side = right >= left ? 1 : -1;
      if (Math.max(right, left) >= RISE) found.push({ s, side });
    }
    // Draw everything for a segment even when it has no candidate, so the others don't shift.
    const pick = found.length ? found[rng.int(0, found.length - 1)] : null;
    const len = Math.round(rng.range(30, 60));
    const count = rng.int(4, 7);
    const early = rng.range(2, 6);
    const jitter = rng.range(0.9, 1.1);
    const shape: [number, number, number] = [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)];
    if (!pick) continue;
    const arrival = (pick.s - track.start) / (LEAD_PACE * jitter);
    const site: SlideSite = { s: pick.s, len, side: pick.side, at: place(track, pick.s, 0, 1), trigger: Math.max(MIN_TRIGGER, arrival - WARN - FALL - early), boulders: [], shape };
    site.boulders = makeBoulders(track, pick.s, len, pick.side, count, rng, ground);
    sites.push(site);
  }
  return sites;
}

/** The always-there mud: where a river of the track's scenery runs under the road (`PATCH_LEN` m, half strength). */
export function mudPatches(track: TrackData): MudPatch[] {
  const out: MudPatch[] = [];
  const P = track.points;
  for (const river of track.scenery?.rivers ?? []) {
    for (let j = 0; j + 1 < river.points.length; j++) {
      const a = river.points[j];
      const b = river.points[j + 1];
      for (let i = 0; i + 1 < P.length; i++) {
        if (track.cum[i + 1] < track.start - 50 || track.cum[i] > track.finish + 50) continue;
        const c = P[i];
        const d = P[i + 1];
        const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
        if (Math.abs(den) < 1e-9) continue;
        const u = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
        const v = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
        if (u < 0 || u > 1 || v < 0 || v > 1) continue;
        const s = track.cum[i] + (track.cum[i + 1] - track.cum[i]) * v;
        if (!out.some((m) => Math.abs(m.s - s) < PATCH_LEN * 2)) out.push({ s, len: PATCH_LEN, level: PATCH_LEVEL });
      }
    }
  }
  return out.sort((x, y) => x.s - y.s);
}

/** Sites and always-there mud together. */
export function slideField(track: TrackData, seed: number, ground: (p: Vec2) => number): SlideField {
  return { sites: slideSites(track, seed, ground), patches: mudPatches(track) };
}

/** Where a site is at race time `t` (s since GO). */
export function slidePhase(site: SlideSite, t: number): SlidePhase {
  if (t < site.trigger) return 'idle';
  if (t < site.trigger + WARN) return 'warning';
  if (t < site.trigger + WARN + FALL) return 'falling';
  return 'settled';
}

/** The fall's progress along its path for a boulder `τ` (0..1) into its own fall: eases in, then rolls out (C1 at the join). */
function pathFraction(tau: number): number {
  const c = 0.6;
  if (tau <= 0) return 0;
  if (tau >= 1) return 1;
  if (tau < c) return (tau * tau) / c;
  const w = (tau - c) / (1 - c);
  return c + (1 - c) * (1 - (1 - w) * (1 - w));
}

/** How far boulder `k` is into its own fall at race time `t`: <= 0 still hanging on the slope, >= 1 landed at rest. */
export function fallProgress(site: SlideSite, k: number, t: number): number {
  const b = site.boulders[k];
  const end = FALL - b.delay;
  return end > 0 ? (t - (site.trigger + WARN) - b.delay) / end : 1;
}

/**
 * Boulder `k` of `site` at race time `t`, into `out`: exactly its start pose until the fall,
 * exactly its rest pose from the end of it. In between it slides down the slope (eases in,
 * bounces smaller and smaller, rolls out across the road's uphill half) turning as far as it
 * goes (distance / radius).
 */
export function boulderPose(track: TrackData, site: SlideSite, k: number, t: number, out: BoulderPose): BoulderPose {
  const b = site.boulders[k];
  const tau = fallProgress(site, k, t);
  if (tau >= 1) return pose(out, b.rest.x, b.rest.y, b.rest.z, b, b.spin);
  if (tau <= 0) return pose(out, b.start.x, b.start.y, b.start.z, b, 0);
  const f = pathFraction(tau);
  const p = place(track, b.startAt.s + (b.restAt.s - b.startAt.s) * f, b.startAt.u + (b.restAt.u - b.startAt.u) * f, site.side);
  // Height along the profile, plus bounces that die away (zero at both ends).
  const x = f * (SAMPLES - 1);
  const i = Math.min(SAMPLES - 2, Math.floor(x));
  const y = b.profile[i] + (b.profile[i + 1] - b.profile[i]) * (x - i) + Math.abs(Math.sin(Math.PI * b.bounces * tau)) * 0.45 * b.r * (1 - tau) * (1 - tau);
  return pose(out, p.x, y, p.z, b, b.spin * f);
}

function pose(out: BoulderPose, x: number, y: number, z: number, b: Boulder, angle: number): BoulderPose {
  const h = angle / 2;
  const s = Math.sin(h);
  out.x = x;
  out.y = y;
  out.z = z;
  out.qx = b.axis.x * s;
  out.qy = 0;
  out.qz = b.axis.z * s;
  out.qw = Math.cos(h);
  return out;
}

/**
 * How muddy the road is (0..1) at `s` meters along, `off` right of the centerline, at race time
 * `t`: nothing at a site before it falls, growing over the fall to a ragged-edged tongue over the
 * uphill half (spilling a little over the middle, gone 1.5 m into the open half), plus the
 * always-there patches (`wet`, 0..1: rain makes them worse).
 */
export function mudAt(field: SlideField, t: number, s: number, off: number, wet = 0, hw = 4.2): number {
  let m = 0;
  for (const p of field.patches) {
    const along = 1 - smooth(p.len / 2 - 4, p.len / 2 + 2, Math.abs(s - p.s));
    if (along > 0) m = Math.max(m, Math.min(1, p.level * (1 + 0.6 * wet)) * along);
  }
  for (const site of field.sites) {
    const grown = smooth(site.trigger + WARN, site.trigger + WARN + FALL + 1.5, t);
    if (grown <= 0) continue;
    const d = Math.abs(s - site.s);
    if (d > site.len / 2 + 2) continue;
    const e = tongueEdge(site, s);
    const along = 1 - smooth(e - 8, e, d);
    const u = off * site.side;
    const across = smooth(-SPILL, 0, u) * (u > hw + 1 ? 1 - smooth(hw + 1, hw + 3, u) : 1);
    m = Math.max(m, along * across * grown);
  }
  return m;
}

/** Half-length of the tongue at `s`: ragged (seeded). */
export function tongueEdge(site: SlideSite, s: number): number {
  const w = (s - site.s) * 0.35;
  return (site.len / 2) * (0.86 + 0.08 * Math.sin(w + site.shape[0]) + 0.06 * Math.sin(w * 2.3 + site.shape[1]));
}

/** What a driver needs to know about the slides ahead of it. */
export interface SlideAdvice {
  /** The offset to drive at (the open half's middle) or NaN: nothing to avoid. */
  lane: number;
  /** Where the debris starts, in meters along (the front axle must slow before). */
  s0: number;
  /** Speed to hold (m/s) so as to be at `mudSpeed` at `s0` braking at `brake`, Infinity if far. */
  limit: number;
  /** Debris has landed (falling or settled): worth waiting for oncoming traffic. */
  landed: boolean;
  /** How far over to the open lane to be by now (0 far off .. 1 right at it): a bend isn't taken wide for a slide a long way ahead. */
  ramp: number;
}

/** An AI's pace through the debris (m/s). */
export const MUD_SPEED = 18;
/** The open half's lane: this far (m) from the middle, away from the slope. */
export const OPEN_LANE = 1.6;
/** How far ahead (m) a driver starts to take the slides into account. */
const ADVICE_LOOK = 160;

/**
 * For a driver whose front axle is `s` and which is `len` long, at race time `t`: the lane to take and
 * the speed to hold for the nearest slide that is warning, falling or settled and not behind it yet.
 * Out of the way when it has none.
 */
export function slideAdvice(sites: readonly SlideSite[], t: number, s: number, len: number, brake: number, out: SlideAdvice): SlideAdvice {
  out.lane = NaN;
  out.s0 = Infinity;
  out.limit = Infinity;
  out.landed = false;
  out.ramp = 0;
  for (const site of sites) {
    const phase = slidePhase(site, t);
    if (phase === 'idle') continue;
    const s0 = site.s - site.len / 2 - 4;
    const s1 = site.s + site.len / 2;
    // Past it entirely (the tail out of the tongue), or still far off.
    if (s - len > s1 + 2 || s0 - s > ADVICE_LOOK) continue;
    if (s0 >= out.s0) continue;
    out.s0 = s0;
    out.lane = -site.side * OPEN_LANE;
    out.landed = phase !== 'warning';
    const dist = Math.max(0, s0 - s);
    out.limit = Math.sqrt(MUD_SPEED * MUD_SPEED + 2 * brake * dist);
    out.ramp = clamp(1 - (s0 - 8 - s) / 35, 0, 1);
  }
  return out;
}

/** How far (m) the rumble of a slide carries, and how long (s) the rockfall's last echoes last. */
const HEARD = 320;
const ECHO = 4;

/**
 * How loud the slides are at `ear` (x, z), at race time `t`: `rumble` (0..1: the ground
 * shaking, swelling through the warning and the fall), `fall` (0..1: rocks crashing down, the
 * fall and a short tail), each from the loudest site, fading with distance.
 */
export function slideLoudness(sites: readonly SlideSite[], t: number, ear: Vec2, out: { rumble: number; fall: number }): { rumble: number; fall: number } {
  out.rumble = 0;
  out.fall = 0;
  for (const site of sites) {
    const d = Math.hypot(site.at.x - ear.x, site.at.z - ear.z);
    if (d > HEARD) continue;
    const near = 1 / (1 + (d / 45) ** 2);
    const since = t - site.trigger;
    if (since < 0) continue;
    const rumble = since < WARN ? 0.2 + 0.5 * (since / WARN) : since < WARN + FALL ? 1 : 1 - smooth(WARN + FALL, WARN + FALL + ECHO, since);
    const fall = since < WARN ? 0 : since < WARN + FALL ? 1 : 1 - smooth(WARN + FALL, WARN + FALL + ECHO / 2, since);
    out.rumble = Math.max(out.rumble, rumble * near);
    out.fall = Math.max(out.fall, fall * near);
  }
  return out;
}

/** Tire grip in deep mud (a share of the road's), and how much less on top when it is wet. */
const MUD_GRIP = 0.55;
const MUD_WET = 0.15;
/** What an AI counts on to brake before a slide, as a share of its dry braking (mud and a heavy bus take more). */
export const SLIDE_BRAKE = 0.55;

/** The grip left in `mud` (0..1) on a road `wet` (0..1). */
export function mudGrip(mud: number, wet: number): number {
  return mud <= 0 ? 1 : (1 - (1 - MUD_GRIP) * mud) * (1 - MUD_WET * wet * mud);
}
