import type { CircuitData, CityData, Vec2 } from './cityData';

/**
 * A race track: a stretch of a real mountain highway (osm/track.ts imports it), raced from
 * `start` to `finish` along its centerline. The road is `city.roads[0]`, on its own graded deck
 * (`Road.surface`); past its edges the terrain is the real valley side, cut into uphill and
 * falling away downhill, with guardrails along some of the drops and none along others.
 */
export interface TrackData {
  /** Shown in the HUD and menu: "Papallacta → Cuyuja". */
  from: string;
  to: string;
  /** Centerline (same points as the road), its surface height and distance along at each point. */
  points: Vec2[];
  y: number[];
  cum: number[];
  /** Asphalt width (m). */
  width: number;
  /** Where the race starts (the grid's front row) and ends, in meters along the centerline. */
  start: number;
  finish: number;
  /** Guardrails: stretches of one side (1 = right of the way to the finish, -1 = left). */
  rails: { s0: number; s1: number; side: 1 | -1 }[];
  /** Drops beside the road (side, stretch) with no rail: where a bus can go over. */
  drops: { s0: number; s1: number; side: 1 | -1 }[];
  /** Nitro pickups: distance along and offset from the centerline (m, + right). */
  pickups: { s: number; off: number }[];
  /** What's beside the road, from OSM: rivers, the oil pipelines, the town's buildings. */
  scenery?: TrackScenery;
  /** What grows and how the valley looks (trackBuilder's BIOMES); absent = páramo. */
  biome?: 'paramo' | 'cloudforest' | 'canyon';
  /**
   * Real tunnels (OSM tunnel=yes) along the track, in meters along: the road runs through a closed bore
   * (world/tunnels.ts) under a mound of rock. `top`: height of the mountain over the deck every
   * `TUNNEL_TOP_STEP` m from `s0`, from the DEM (clamped), so the mound reads as the mountain.
   */
  tunnels?: { s0: number; s1: number; name?: string; top: number[] }[];
  /** Real bridges (OSM bridge=yes) along the track: the ground falls away under the deck, parapets both sides. */
  bridges?: { s0: number; s1: number; name?: string }[];
  /**
   * A closed street circuit (circuitTrack.ts) unrolled over all its laps: `points` run lead-in + `laps` x `lap`
   * + run-off, so `s` only grows and the lap is `lapOf(t, s)`. `data` is the one-lap course.
   */
  circuit?: { id: string; laps: number; lap: number; data: CircuitData };
  /** Per point barrier offsets from the centerline (m, + right of travel, both positive); where present they replace `width / 2`. */
  edges?: {
    left: number[];
    right: number[];
    /** Carriageway half widths (m): the AI's line stays inside them on straights. */
    road?: number[];
  };
}

/** Is this track a street circuit (laps, city look) rather than a mountain road? */
export function isCircuit(t: TrackData | null | undefined): boolean {
  return !!t?.circuit;
}

/** The lap (1-based, clamped to [1, laps]) that `s` meters along an unrolled circuit is on; the lead-in is lap 1, the run-off the last. Other tracks: 1. */
export function lapOf(t: TrackData, s: number): number {
  const c = t.circuit;
  if (!c) return 1;
  return Math.max(1, Math.min(c.laps, Math.floor((s - t.start) / c.lap) + 1));
}

/** `s` of the line that starts `lap` (1-based; `laps + 1` = the finish line). */
export function lapStart(t: TrackData, lap: number): number {
  return t.start + (t.circuit ? (lap - 1) * t.circuit.lap : 0);
}

/** Spacing (m) of `Tunnel.top`. */
export const TUNNEL_TOP_STEP = 12;
/** A bore's cross-section: half width of the walls, where the arch springs (m over the deck) and how high it rises from there. */
export const BORE_HALF = 5.4;
export const BORE_WALL = 2.6;
export const BORE_RISE = 4;
/** Height of the bore's apex over the deck. */
export const BORE_TOP = BORE_WALL + BORE_RISE;
/** The rock mound over a tunnel reaches this far either side of the centerline (m). */
export const MOUND_HALF = 40;

/** The real things along a track (osm/track.ts), drawn by trackBuilder. */
export interface TrackScenery {
  /** Water surface heights at each point (the terrain is carved under them). */
  rivers: { points: Vec2[]; y: number[]; width: number }[];
  /** Pipes on low stands over the ground, broken where they pass under the road. */
  pipes: { points: Vec2[]; diameter: number }[];
  /** Block walls and tin roofs; `sign` names a roadside business's trade ("TRUCHAS"); a place of worship is a `chapel`. */
  buildings: { footprint: Vec2[]; floors: number; wall: string; roof: string; sign?: string; kind?: 'chapel' }[];
  /** High-voltage lines: the towers mapped inside the terrain, in order, and the circuits they carry. */
  powerLines?: { towers: Vec2[]; circuits: number }[];
  /** Real waterfalls (OSM waterway=waterfall): the course the water takes down the slope (points every ~5 m, height of the ground under each), and its width (m). */
  waterfalls?: { name?: string; points: Vec2[]; y: number[]; width: number }[];
}

/** Is `s` inside a tunnel (or within `pad` m of one)? */
export function inTunnel(t: Pick<TrackData, 'tunnels'>, s: number, pad = 0): boolean {
  return !!t.tunnels && t.tunnels.some((u) => s >= u.s0 - pad && s <= u.s1 + pad);
}

/** A point `s` meters along the track and its direction (unit, toward the finish). */
export function trackPoint(t: TrackData, s: number, out: { x: number; z: number; y: number; dx: number; dz: number } = { x: 0, z: 0, y: 0, dx: 1, dz: 0 }) {
  const { cum, points: p } = t;
  const n = cum.length;
  s = Math.max(0, Math.min(cum[n - 1], s));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const len = cum[hi] - cum[lo] || 1;
  const u = (s - cum[lo]) / len;
  out.x = p[lo].x + (p[hi].x - p[lo].x) * u;
  out.z = p[lo].z + (p[hi].z - p[lo].z) * u;
  out.y = t.y[lo] + (t.y[hi] - t.y[lo]) * u;
  out.dx = (p[hi].x - p[lo].x) / len;
  out.dz = (p[hi].z - p[lo].z) / len;
  return out;
}

/** Heading (bus convention: 0 = +X, positive toward -Z) of the track `s` meters along. */
export function trackHeading(t: TrackData, s: number): number {
  const q = trackPoint(t, s);
  return Math.atan2(-q.dz, q.dx);
}

/**
 * Where `p` is along the track: distance along the centerline, signed offset (+ right) and the
 * road's height there. `hint` (a previous `s`) searches only near it, `reach` meters either way;
 * without one the whole track is searched. With a height (`p.y`) the nearest road counts the
 * vertical distance too: a hairpin's other leg 40 m off but 80 m up isn't the road under a bus.
 * On a street circuit the laps overlap in space, so a search without a hint covers one lap only (its
 * span padded 40 m, lap 1 with the lead-in, the last lap with the run-off): `lapHint` (1-based, from
 * `lapOf(t, lastS)`) says which, and without it lap 1 is searched. Mountain tracks ignore `lapHint`.
 */
export function locateOnTrack(t: TrackData, p: Vec2 & { y?: number }, hint = -1, reach = 80, lapHint?: number): { s: number; off: number; y: number } {
  const { points: pts, cum } = t;
  let i0 = 0;
  let i1 = pts.length - 1;
  // A circuit's lap search: the lap's own span (the padding only catches a car just over a seam).
  let lo = -Infinity;
  let hi = Infinity;
  if (hint >= 0) {
    i0 = indexAt(cum, hint - reach);
    i1 = Math.min(pts.length - 1, indexAt(cum, hint + reach) + 1);
  } else if (t.circuit) {
    const lap = Math.max(1, Math.min(t.circuit.laps, Math.round(lapHint ?? 1)));
    if (lap > 1) {
      lo = lapStart(t, lap);
      i0 = indexAt(cum, lo - LAP_PAD);
    }
    if (lap < t.circuit.laps) {
      hi = lapStart(t, lap + 1);
      i1 = Math.min(pts.length - 1, indexAt(cum, hi + LAP_PAD) + 1);
    }
  }
  let best = Infinity;
  let bs = 0;
  let boff = 0;
  let by = 0;
  for (let i = i0; i < i1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
    const ex = p.x - (a.x + dx * u);
    const ez = p.z - (a.z + dz * u);
    const ry = t.y[i] + (t.y[i + 1] - t.y[i]) * u;
    const ey = p.y === undefined ? 0 : p.y - ry;
    // The seam's padding repeats the lap's other end (the lap is closed): there the lap's own span wins a tie.
    const at = cum[i] + (cum[i + 1] - cum[i]) * u;
    const d2 = ex * ex + ez * ez + ey * ey + (at < lo - 1e-6 || at > hi + 1e-6 ? PAD_PENALTY : 0);
    if (d2 < best) {
      best = d2;
      bs = at;
      // Right of travel is (-dz, dx) in x/z (z points south).
      const l = Math.sqrt(l2);
      boff = (ex * -dz + ez * dx) / l;
      by = ry;
    }
  }
  return { s: bs, off: boff, y: by };
}

/** A lap's search span reaches this far (m) into its neighbours. */
const LAP_PAD = 40;
const PAD_PENALTY = 4;

/** Index of the last point at or before `s`. */
function indexAt(cum: number[], s: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  if (s <= 0) return 0;
  if (s >= cum[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The pose `back` meters behind the start line, `off` right of the middle (free roam's start, the grid's slots). */
export function trackStartPose(t: TrackData, back = 0, off = 0): { pos: Vec2; heading: number; y: number; pitch: number } {
  return trackPose(t, t.start - back, off);
}

/** A bus's pose `s` meters along the track, `off` right of the middle, facing the finish. */
export function trackPose(t: TrackData, s: number, off = 0): { pos: Vec2; heading: number; y: number; pitch: number } {
  const q = trackPoint(t, s);
  const ahead = trackPoint(t, s + 6);
  return {
    pos: { x: q.x - q.dz * off, z: q.z + q.dx * off },
    heading: Math.atan2(-q.dz, q.dx),
    y: q.y,
    pitch: Math.atan2(ahead.y - q.y, 6),
  };
}

/** The track of a city, if it is one. */
export function trackOf(city: CityData): TrackData | null {
  return city.race ?? null;
}

/** Is the city a mountain track (the point-to-point roads with their own terrain, mist and haze)? A circuit is a city with a race. */
export function onMountain(city: Pick<CityData, 'race'>): boolean {
  return !!city.race && !city.race.circuit;
}
