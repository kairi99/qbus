import type { Stop, Vec2 } from '../cityData';
import { forward } from '../cityData';
import type { OsmJson } from './import';

/** A real bus line's stretch through the zone: one direction's stops, then the other's. */
export interface BusLine {
  /** OSM ref, e.g. "CATAR-061". */
  ref: string;
  /** Display name, e.g. "Catar 061". */
  name: string;
  /** Where the full line runs, e.g. "Ejido – Carcelén". */
  endpoints: string;
  stops: string[];
  /** Index where the return direction starts in `stops`. */
  split: number;
  /** Other lines that serve the same stops (same street pattern). */
  alsoServedBy: string[];
}

/** Stops farther than this from a line's path aren't on it. */
const REACH = 18;
/** Stop heading vs. path direction: the bus has to be driving past the stop the right way. */
const MIN_ALIGN = 0.6;
const MIN_STOPS_PER_DIRECTION = 3;
/** Rapid-transit lines use median stations we don't model. */
const BRT = /^(E\d|C\d|T\d|Q\d)|metro-?bus|ecov|trole/i;

type Proj = (lat: number, lon: number) => Vec2;

/**
 * Real bus lines crossing the zone, from Overpass route relations (`out body geom(bbox)`).
 * Each direction's path is rebuilt by chaining its ways in member order; the zone's stops
 * lying along it, facing its way, become that direction's stops (in path order).
 */
export function importLines(osm: OsmJson, toXZ: Proj, stops: Stop[]): BusLine[] {
  type Dir = { ref: string; tags: Record<string, string>; stops: string[] };
  const dirs: Dir[] = [];
  for (const e of osm.elements) {
    const t = e.tags ?? {};
    if (e.type !== 'relation' || t.type !== 'route' || !t.ref) continue;
    if (t.route === 'trolleybus' || BRT.test(t.ref) || BRT.test(t.name ?? '')) continue;
    // Geometry clipped to the zone has null points where a way leaves it: split there.
    const ways: Vec2[][] = [];
    for (const m of e.members ?? []) {
      if (m.type !== 'way' || !m.geometry) continue;
      let run: Vec2[] = [];
      for (const g of m.geometry as ({ lat: number; lon: number } | null)[]) {
        if (g) run.push(toXZ(g.lat, g.lon));
        else if (run.length) (run.length > 1 && ways.push(run), (run = []));
      }
      if (run.length > 1) ways.push(run);
    }
    const pieces = chainWays(ways);
    const matched = pieces.flatMap((path) => stopsAlong(path, stops));
    const seq = matched.filter((id, i) => matched.indexOf(id) === i);
    if (seq.length >= MIN_STOPS_PER_DIRECTION) dirs.push({ ref: t.ref, tags: t, stops: seq });
  }

  // Pair the two directions of each line; a single mapped direction still makes a loop.
  const byRef = new Map<string, Dir[]>();
  for (const d of dirs) byRef.set(d.ref, [...(byRef.get(d.ref) ?? []), d]);
  const lines: BusLine[] = [];
  for (const [ref, ds] of byRef) {
    const [a, b] = ds.sort((x, y) => y.stops.length - x.stops.length);
    const back = b ? b.stops.filter((id) => !a.stops.includes(id)) : [];
    lines.push({
      ref,
      name: lineDisplayName({ ref, route: a.tags.route }),
      endpoints: endpoints(a.tags),
      stops: [...a.stops, ...back],
      split: a.stops.length,
      alsoServedBy: [],
    });
  }

  // Lines along the same streets serve (almost) the same stops: keep one, credit the others.
  lines.sort((x, y) => y.stops.length - x.stops.length);
  const kept: BusLine[] = [];
  for (const l of lines) {
    const twin = kept.find((k) => overlap(k.stops, l.stops) > 0.7);
    if (twin) twin.alsoServedBy.push(l.name);
    else kept.push(l);
  }
  return kept;
}

/** "CATAR-061" → "Catar 061"; trolleybus "C1" → "Trolebús C1". */
export function lineDisplayName(t: { ref: string; route?: string }): string {
  if (t.route === 'trolleybus') return `Trolebús ${t.ref}`;
  const small = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
  return t.ref
    .replace(/-/g, ' ')
    .split(/\s+/)
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (/\d/.test(w)) return w.toUpperCase();
      if (i > 0 && small.has(lw)) return lw;
      return lw[0].toUpperCase() + lw.slice(1);
    })
    .join(' ');
}

function endpoints(t: Record<string, string>): string {
  const cap = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  if (t.from && t.to) return `${cap(t.from)} – ${cap(t.to)}`;
  return (t.name ?? '').replace(/\s+\d+[A-Z]?$/, '').replace(/\s+-\s+/g, ' – ');
}

/** Joins ways end to end (flipping as needed); a gap starts a new piece. */
export function chainWays(ways: Vec2[][]): Vec2[][] {
  const pieces: Vec2[][] = [];
  let cur: Vec2[] = [];
  const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
  for (let i = 0; i < ways.length; i++) {
    let w = ways[i];
    if (!cur.length) {
      // Orient the first way of a piece toward the next one.
      const next = ways[i + 1];
      if (next) {
        const endNear = Math.min(d(w[w.length - 1], next[0]), d(w[w.length - 1], next[next.length - 1]));
        const startNear = Math.min(d(w[0], next[0]), d(w[0], next[next.length - 1]));
        if (startNear < endNear) w = [...w].reverse();
      }
      cur = [...w];
      continue;
    }
    const tail = cur[cur.length - 1];
    if (d(tail, w[0]) < 3) cur.push(...w.slice(1));
    else if (d(tail, w[w.length - 1]) < 3) cur.push(...[...w].reverse().slice(1));
    else {
      pieces.push(cur);
      cur = [];
      i--;
    }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

/** Stops within reach of the path and facing along it, in the order the path passes them. */
function stopsAlong(path: Vec2[], stops: Stop[]): string[] {
  const hits: { id: string; t: number }[] = [];
  let cum = 0;
  const cums = [0];
  for (let i = 1; i < path.length; i++) cums.push((cum += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z)));
  for (const s of stops) {
    let best = { d: Infinity, t: 0, align: 0 };
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const u = Math.max(0, Math.min(1, ((s.pos.x - a.x) * dx + (s.pos.z - a.z) * dz) / (len * len)));
      const dd = Math.hypot(s.pos.x - (a.x + u * dx), s.pos.z - (a.z + u * dz));
      if (dd < best.d) {
        const f = forward(s.heading);
        best = { d: dd, t: cums[i] + u * len, align: (f.x * dx + f.z * dz) / len };
      }
    }
    if (best.d < REACH && best.align > MIN_ALIGN) hits.push({ id: s.id, t: best.t });
  }
  return hits.sort((a, b) => a.t - b.t).map((h) => h.id);
}

function overlap(a: string[], b: string[]): number {
  const sa = new Set(a);
  return b.filter((x) => sa.has(x)).length / Math.min(a.length, b.length);
}
