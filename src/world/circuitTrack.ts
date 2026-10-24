import { type CircuitData, type CityData, type Vec2, groundHeightAt } from './cityData';
import type { TrackData } from './track';

/** Meters of course before the line: the grid (the last stretch of the lap). */
export const CIRCUIT_LEAD = 100;
/** Meters of course past the finish line: where the finishers roll to a stop. */
export const CIRCUIT_RUNOFF = 150;
/** Nitro pickups per lap, in pairs across the road. */
const PICKUPS_PER_LAP = 3;
/** Pickups keep this far (m) from the line and from a corner's apex. */
const PICKUP_CLEAR = 40;
/** Extra clearance (m) from an apex: a long bend's sharpest point is vague by a few meters. */
const APEX_MARGIN = 8;
/** A corner: the heading changes more than this (rad) within `CORNER_SPAN` m. */
const CORNER_ANGLE = (30 * Math.PI) / 180;
const CORNER_SPAN = 20;
const PICKUP_OFF = 1.9;

const turn = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
/** Is lap distance `u` inside a corner: the heading changes more than `CORNER_ANGLE` within `CORNER_SPAN` m around it? */
const inCorner = (headingAt: (u: number) => number, u: number) => turn(headingAt(u - CORNER_SPAN / 2), headingAt(u + CORNER_SPAN / 2)) > CORNER_ANGLE;

/**
 * Lap distances (m) of each corner's apex: its point of sharpest turning (the most heading change
 * over 10 m) among the stretch of lap that is in a corner. `headingAt(u)` is the lap's heading at `u`.
 */
export function cornerApexes(headingAt: (u: number) => number, L: number): number[] {
  const M = Math.ceil(L);
  const inside: boolean[] = [];
  for (let u = 0; u < M; u++) inside.push(inCorner(headingAt, u));
  const from = inside.indexOf(false);
  if (from < 0) return [];
  const out: number[] = [];
  let best = -1;
  let bestK = 0;
  for (let j = 1; j <= M; j++) {
    const u = (from + j) % M;
    if (inside[u]) {
      const k = turn(headingAt(u - 5), headingAt(u + 5));
      if (k > bestK) (bestK = k), (best = u);
    } else if (best >= 0) {
      out.push(best);
      best = -1;
      bestK = 0;
    }
  }
  return out;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * A circuit's race: the lap unrolled as one long track, `CIRCUIT_LEAD` m of the lap before the line,
 * `laps` laps, then `CIRCUIT_RUNOFF` m past the finish, so `s` only grows and `lapOf` says which lap
 * (`start` = the line, `finish` = the line after the last lap). Heights come from `city`'s ground
 * (build the city at hills scale 1), `edges` carries the barrier offsets of each point and `width` the
 * narrowest course (barrier to barrier).
 */
export function circuitTrack(city: CityData, c: CircuitData): TrackData {
  // The lap without its closing duplicate of point 0.
  const n = c.points.length - 1;
  const lapPts = c.points.slice(0, n);
  const lapCum: number[] = [0];
  for (let i = 1; i <= n; i++) lapCum.push(lapCum[i - 1] + Math.hypot(c.points[i].x - c.points[i - 1].x, c.points[i].z - c.points[i - 1].z));
  const L = lapCum[n];
  const lapY = lapPts.map((p) => groundHeightAt(city, p));

  const d0 = c.line - CIRCUIT_LEAD;
  const d1 = c.line + c.laps * L + CIRCUIT_RUNOFF;
  const points: Vec2[] = [];
  const y: number[] = [];
  const cum: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  const road: number[] = [];
  const push = (p: Vec2, h: number, abs: number, l: number, r: number, h2: number) => {
    points.push({ x: round(p.x), z: round(p.z) });
    y.push(round(h));
    cum.push(round(abs - d0));
    left.push(l);
    right.push(r);
    road.push(h2);
  };
  /** The lap at distance `d` (any, wrapped), interpolated. */
  const at = (d: number) => {
    const u = ((d % L) + L) % L;
    let i = 0;
    while (i < n - 1 && lapCum[i + 1] <= u) i++;
    const a = i;
    const b = (i + 1) % n;
    const k = (u - lapCum[a]) / (lapCum[a + 1] - lapCum[a] || 1);
    const mix = (p: number, q: number) => p + (q - p) * k;
    return { p: { x: mix(lapPts[a].x, lapPts[b].x), z: mix(lapPts[a].z, lapPts[b].z) }, y: mix(lapY[a], lapY[b]), l: mix(c.left[a], c.left[b]), r: mix(c.right[a], c.right[b]), w: mix(c.halfRoad[a], c.halfRoad[b]) };
  };
  const first = at(d0);
  push(first.p, first.y, d0, first.l, first.r, first.w);
  for (let lap = Math.floor(d0 / L); lap * L <= d1; lap++) {
    for (let i = 0; i < n; i++) {
      const abs = lap * L + lapCum[i];
      if (abs > d0 + 0.5 && abs < d1 - 0.5) push(lapPts[i], lapY[i], abs, c.left[i], c.right[i], c.halfRoad[i]);
    }
  }
  const last = at(d1);
  push(last.p, last.y, d1, last.l, last.r, last.w);

  const width = Math.min(...c.left.map((l, i) => l + c.right[i]));
  const start = CIRCUIT_LEAD;
  const finish = start + c.laps * L;
  return {
    from: c.name,
    to: `${c.laps} vueltas`,
    points,
    y,
    cum,
    width: round(width),
    start,
    finish: round(finish, 1),
    rails: [],
    drops: [],
    pickups: lapPickups(c, lapPts, lapCum, L, start),
    circuit: { id: c.id, laps: c.laps, lap: L, data: c },
    edges: { left, right, road },
  };
}

/** Three pairs of pickups, spread round the lap, off the line and off the corners (each spot once: every lap drives over the same ones). */
function lapPickups(c: CircuitData, pts: Vec2[], cum: number[], L: number, start: number): TrackData['pickups'] {
  const n = pts.length;
  const posAt = (u: number): Vec2 => {
    u = ((u % L) + L) % L;
    let i = 0;
    while (i < n - 1 && cum[i + 1] <= u) i++;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const k = (u - cum[i]) / (cum[i + 1] - cum[i] || 1);
    return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
  };
  const headingAt = (u: number) => {
    const a = posAt(u - 1);
    const b = posAt(u + 1);
    return Math.atan2(b.z - a.z, b.x - a.x);
  };
  /** Distance between two spots on the lap, the short way round. */
  const cyc = (a: number, b: number) => {
    const d = (((a - b) % L) + L) % L;
    return Math.min(d, L - d);
  };
  const nearLine = (u: number) => cyc(u, c.line) < PICKUP_CLEAR;
  const apexes = cornerApexes(headingAt, L);
  const ok: number[] = [];
  for (let u = 0; u < L; u += 2) if (!nearLine(u) && apexes.every((a) => cyc(a, u) >= PICKUP_CLEAR + APEX_MARGIN) && !inCorner(headingAt, u)) ok.push(u);
  const spots: number[] = [];
  for (let j = 0; j < PICKUPS_PER_LAP && ok.length; j++) {
    const want = c.line + (L * (j + 0.5)) / PICKUPS_PER_LAP;
    let best = -1;
    let bd = Infinity;
    for (const u of ok) {
      const d = cyc(u, want);
      if (d < bd && !spots.some((v) => cyc(v, u) < PICKUP_CLEAR)) {
        bd = d;
        best = u;
      }
    }
    if (best < 0) continue;
    spots.push(best);
  }
  const out: TrackData['pickups'] = [];
  // One physical pickup per spot, shared by every lap (Pickups compares modulo the lap).
  for (const u of spots.map((v) => ((v - c.line) % L + L) % L).sort((a, b) => a - b)) {
    const s = round(start + u, 1);
    for (const off of [-PICKUP_OFF, PICKUP_OFF]) out.push({ s, off });
  }
  return out;
}
