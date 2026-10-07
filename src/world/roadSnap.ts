import type { CityData, Vec2 } from './cityData';
import { forward, groundHeightAt, right } from './cityData';
import { type RoadProfile, profileAt, roadProfiles, surfaceY } from './elevation';

/** Keep reset spots this far from a road's ends so the bus isn't dropped past the city edge. */
const END_MARGIN = 10;
/** Extra clearance before/after a ramp or hump. */
const FEATURE_MARGIN = 6;
/**
 * Meters of sideways distance one meter of height mismatch is worth when picking the road. A
 * ramp near its top runs 2–3 m beside a parallel street about 1 m above it: the level must win.
 */
const LEVEL_WEIGHT = 4;
/** Weight of the distance off a road's asphalt (or past its ends), and from its centerline. */
const OFF_ROAD = 1;
const CENTER = 0.25;
/** Other roads tried when the best one has no clear spot (scoring at most this much worse). */
const ALTERNATIVES = 6;
const ALT_SCORE = 15;
/** ...and at most this much further off the bus's level than the best (m). */
const ALT_LEVEL = 0.75;
/** Slides along the road (m, + = direction of travel) and shifts toward its middle (m) tried for a clear spot, in order. */
const SLIDES = [0, 4, -4, 8, -8, 12, -12, 18, -18, 25, -25, 35, -35, 45, -45];
const SHIFTS = [0, 0.5, 1, 1.5, 2, 2.5];

/** Where the R reset puts the bus: position, heading, road height, and the road's grade there. */
export interface RoadPose {
  pos: Vec2;
  heading: number;
  y: number;
  /** Nose-up pitch over `length` (radians). */
  pitch: number;
}

export interface SnapOptions {
  /** Whether a bus at this pose would be clear of walls, roofs and ground (the static world). */
  clear?: (pose: RoadPose) => boolean;
  /** Vehicle length, for the pitch (m). */
  length?: number;
}

interface Candidate {
  road: number;
  /** Distance along the road (m) of the point nearest the bus. */
  s: number;
  score: number;
  /** Height mismatch with the bus there (m). */
  dy: number;
}

/** A road's length and how far to keep from each end (only dead ends: the map edge). */
interface RoadEnds {
  total: number;
  m0: number;
  m1: number;
}

const endsCache = new WeakMap<CityData, RoadEnds[]>();

/**
 * Per road: its length, and `END_MARGIN` (or half its length) at an end no other road
 * continues from. Where OSM ways join end to end (ramps are split into several) the spot may
 * sit anywhere, or a short ramp piece would push the reset onto the next level.
 */
function roadEnds(city: CityData): RoadEnds[] {
  const hit = endsCache.get(city);
  if (hit) return hit;
  // Every road point, bucketed by 4 m cell.
  const cell = (x: number, z: number) => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
  const grid = new Map<string, { ri: number; p: Vec2 }[]>();
  city.roads.forEach((r, ri) => {
    for (const p of r.points) {
      const k = cell(p.x, p.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push({ ri, p });
    }
  });
  const ends = city.roads.map((r, ri) => {
    const total = roadLength(r.points);
    const joined = (p: Vec2) => {
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++)
          for (const o of grid.get(cell(p.x + dx * 4, p.z + dz * 4)) ?? []) if (o.ri !== ri && Math.hypot(o.p.x - p.x, o.p.z - p.z) < 1.5) return true;
      return false;
    };
    const m = Math.min(END_MARGIN, total / 2);
    return { total, m0: joined(r.points[0]) ? 0 : m, m1: joined(r.points[r.points.length - 1]) ? 0 : m };
  });
  endsCache.set(city, ends);
  return ends;
}

/**
 * Nearest drivable spot to `p`: on the closest road, in the right-hand lane for whichever road
 * direction is closer to `heading`, and moved along the road until clear of ramps and humps.
 * Being on a road's asphalt counts much more than being near its centerline. With `y` (the
 * road height under the bus now), roads at another level weigh much more than ones beside it,
 * so a bus under a bridge stays under it and a bus on a ramp stays on the ramp rather than
 * jumping onto the street alongside. With `options.clear`, the spot slides along the road (and
 * toward its middle) until a bus there is clear of the static world, trying the next nearest
 * roads if needed. Returns the road surface height there too (the same surface the road and
 * its collider are built from) and its grade.
 */
export function snapToRoad(city: CityData, p: Vec2, heading: number, y?: number, options: SnapOptions = {}): RoadPose {
  const profiles = roadProfiles(city);
  const ends = roadEnds(city);
  const found: Candidate[] = [];
  for (const [ri, r] of city.roads.entries()) {
    const prof = profiles[ri];
    const { total, m0, m1 } = ends[ri];
    let cum = 0;
    let best: Candidate | null = null;
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const s0 = cum;
      cum += len;
      if (len < 1e-6) continue;
      const lo = Math.max(0, m0 - s0);
      const hi = Math.min(len, total - m1 - s0);
      if (lo > hi) continue; // the segment lies wholly inside an end margin
      const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const t = Math.max(lo, Math.min(hi, (p.x - a.x) * dir.x + (p.z - a.z) * dir.z));
      const q = { x: a.x + dir.x * t, z: a.z + dir.z * t };
      const off = (p.x - q.x) * -dir.z + (p.z - q.z) * dir.x;
      const past = Math.abs((p.x - q.x) * dir.x + (p.z - q.z) * dir.z);
      let score = OFF_ROAD * (Math.max(0, Math.abs(off) - r.width / 2) + past) + CENTER * Math.abs(off);
      let dy = 0;
      if (y !== undefined) {
        // The surface under the bus if it's on this road (cross slope and all), else at its edge.
        const o = Math.max(-r.width / 2, Math.min(r.width / 2, off));
        dy = Math.abs(heightAt(city, prof, s0 + t, { x: q.x - dir.z * o, z: q.z + dir.x * o }) - y);
        score += LEVEL_WEIGHT * dy;
      }
      if (!best || score < best.score) best = { road: ri, s: s0 + t, score, dy };
    }
    if (best) found.push(best);
  }
  if (!found.length) {
    const pos = city.spawn.pos;
    return { pos, heading: city.spawn.heading, y: groundHeightAt(city, pos), pitch: 0 };
  }
  found.sort((u, v) => u.score - v.score);
  const first = place(city, profiles, found[0], heading, options.length, 0, 0);
  if (!options.clear) return first;
  for (const c of found.slice(0, ALTERNATIVES)) {
    if (c.score > found[0].score + ALT_SCORE) break;
    // Never trade a blocked spot for one on another level (the street over the cut).
    if (c !== found[0] && c.dy > found[0].dy + ALT_LEVEL) continue;
    for (const slide of SLIDES)
      for (const shift of SHIFTS) {
        const pose = place(city, profiles, c, heading, options.length, slide, shift);
        if (options.clear(pose)) return pose;
      }
  }
  return first;
}

/** Height of a road's surface at `p`, `s` meters along it (its profile, or the ground). */
function heightAt(city: CityData, prof: RoadProfile | null, s: number, p: Vec2): number {
  const at = prof ? profileAt(prof, s) : null;
  return at && Math.abs(at.lift) > 0.02 ? surfaceY(city, at, p) : groundHeightAt(city, p);
}

function roadLength(pts: Vec2[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return n;
}

/** Point and unit direction `s` meters along a polyline (clamped to its ends). */
function along(pts: Vec2[], s: number): { p: Vec2; dir: Vec2 } {
  let cum = 0;
  let last: { p: Vec2; dir: Vec2 } = { p: pts[0], dir: { x: 1, z: 0 } };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    const t = Math.max(0, Math.min(len, s - cum));
    last = { p: { x: a.x + dir.x * t, z: a.z + dir.z * t }, dir };
    if (s <= cum + len) return last;
    cum += len;
  }
  return last;
}

/**
 * The reset pose on candidate `c`: its road's right-hand lane (`shift` meters toward the
 * road's middle), `slide` meters along from the nearest point (in the direction of travel),
 * then clear of humps and ramps.
 */
function place(city: CityData, profiles: (RoadProfile | null)[], c: Candidate, heading: number, length = 10, slide: number, shift: number): RoadPose {
  const r = city.roads[c.road];
  const { total, m0, m1 } = roadEnds(city)[c.road];
  const clampS = (s: number) => Math.max(m0, Math.min(total - m1, s));
  // Pick the road direction closest to where the bus was pointing.
  const cur = forward(heading);
  const d0 = along(r.points, c.s).dir;
  // One-way streets only go one way, whatever the bus was pointing at.
  const sign = r.oneway || cur.x * d0.x + cur.z * d0.z >= 0 ? 1 : -1;

  // Center of the right-hand half of the road (one lane on streets, between lanes on avenues);
  // on one-way streets, the curb lane. Shifted toward the middle, but never over it on a
  // two-way street.
  const lane = r.oneway ? r.width / 2 - r.width / r.lanes / 2 : r.width / 4;
  const lateral = Math.max(r.oneway ? 0 : Math.min(lane, 1.3), lane - shift);
  const at = (s: number) => {
    const { p, dir } = along(r.points, s);
    const d = { x: dir.x * sign, z: dir.z * sign };
    const rt = right(Math.atan2(-d.z, d.x));
    return { pos: { x: p.x + rt.x * lateral, z: p.z + rt.z * lateral }, dir: d };
  };

  // Slide forward/back along the road past any feature under the spot.
  let s = clampS(c.s + slide * sign);
  for (let pass = 0; pass < 4; pass++) {
    const pos = at(s).pos;
    const hit = city.features.find((f) => {
      const ff = forward(f.heading);
      const al = Math.abs((pos.x - f.pos.x) * ff.x + (pos.z - f.pos.z) * ff.z);
      const across = Math.abs((pos.x - f.pos.x) * ff.z - (pos.z - f.pos.z) * ff.x);
      return al < f.length / 2 + FEATURE_MARGIN && across < f.width / 2 + 2;
    });
    if (!hit) break;
    const { p: fp, dir: fd } = along(r.points, s);
    const fs = s + (hit.pos.x - fp.x) * fd.x + (hit.pos.z - fp.z) * fd.z;
    const clear = hit.length / 2 + FEATURE_MARGIN + 0.5;
    const back = fs - clear;
    const ahead = fs + clear;
    s = clampS(back >= 0 && (Math.abs(back - s) <= Math.abs(ahead - s) || ahead > total) ? back : ahead);
  }
  const prof = profiles[c.road];
  const { pos, dir } = at(s);
  const y = heightAt(city, prof, s, pos);
  // Grade under the bus's length, along the road's own profile.
  const h = length / 2;
  const yf = heightAt(city, prof, s + h * sign, at(s + h * sign).pos);
  const yb = heightAt(city, prof, s - h * sign, at(s - h * sign).pos);
  return { pos, heading: Math.atan2(-dir.z, dir.x), y, pitch: Math.atan2(yf - yb, length) };
}
