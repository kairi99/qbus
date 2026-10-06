import type { Stop, TransitSystem, Vec2 } from '../cityData';
import { forward } from '../cityData';
import type { OsmJson } from './import';
import { aliasRef } from './operators';
import { transitSystem } from './stations';

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
  /** Trolebús/Ecovía/Metrobus line, served at its stations. */
  system?: TransitSystem;
}

/** Stops farther than this from a line's path aren't on it. */
const REACH = 18;
/** Stop heading vs. path direction: the bus has to be driving past the stop the right way. */
const MIN_ALIGN = 0.6;
const MIN_STOPS_PER_DIRECTION = 3;

type Proj = (lat: number, lon: number) => Vec2;

/**
 * Real bus lines crossing the zone, from Overpass route relations (`out body geom(bbox)`).
 * Each direction's path is rebuilt by chaining its ways in member order; the zone's stops
 * lying along it, facing its way, become that direction's stops (in path order). Trolebús,
 * Ecovía and Metrobus lines only use their own system's stations, other lines only curb stops.
 */
export function importLines(osm: OsmJson, toXZ: Proj, stops: Stop[]): BusLine[] {
  type Dir = { ref: string; tags: Record<string, string>; stops: string[]; split: number; system?: TransitSystem };
  const dirs: Dir[] = [];
  for (const e of osm.elements) {
    const t = e.tags ?? {};
    if (e.type !== 'relation' || t.type !== 'route' || !t.ref) continue;
    const system = transitSystem(t) ?? undefined;
    const served = stops.filter((s) => s.system === system);
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
    const hits = pieces.flatMap((path) => stopsAlong(path, served));
    const unique = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) === i);
    const seq = unique(hits.filter((h) => h.align > MIN_ALIGN).map((h) => h.id));
    if (system) {
      // Both directions of a BRT line share its corridor, and OSM often lists a relation's ways
      // or stops backwards: take the stations facing along the path, then the ones facing
      // back, returning. One relation gives the whole loop, whichever way it's drawn.
      const back = unique(hits.filter((h) => h.align < -MIN_ALIGN).reverse().map((h) => h.id));
      if (seq.length + back.length >= MIN_STOPS_PER_DIRECTION * 2)
        dirs.push({ ref: t.ref, tags: t, stops: [...seq, ...back], split: seq.length, system });
    } else if (seq.length >= MIN_STOPS_PER_DIRECTION) dirs.push({ ref: t.ref, tags: t, stops: seq, split: seq.length });
  }

  // Pair the two directions of each line; a single mapped direction still makes a loop.
  const byRef = new Map<string, Dir[]>();
  for (const d of dirs) byRef.set(`${d.system ?? ''}:${d.ref}`, [...(byRef.get(`${d.system ?? ''}:${d.ref}`) ?? []), d]);
  const lines: BusLine[] = [];
  for (const ds of byRef.values()) {
    const [a, b] = ds.sort((x, y) => y.stops.length - x.stops.length);
    // Real operators' names never reach the game: see `operators.ts`.
    const ref = aliasRef(a.ref);
    const back = b ? b.stops.filter((id) => !a.stops.includes(id)) : [];
    lines.push({
      ref,
      name: lineDisplayName({ ref, route: a.tags.route, system: a.system, name: a.tags.name }),
      endpoints: aliasRef(endpoints(a.tags)),
      stops: [...a.stops, ...back],
      split: a.split,
      alsoServedBy: [],
      system: a.system,
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

const SYSTEM_NAME: Record<TransitSystem, string> = { trolebus: 'Trolebús', ecovia: 'Ecovía', metrobus: 'Metrobus' };

/** "CATAR-061" → "Catar 061"; trolleybus "C1" → "Trolebús C1"; "E1" → "Ecovía E1". */
export function lineDisplayName(t: { ref: string; route?: string; system?: TransitSystem; name?: string }): string {
  const system = t.system ?? (t.route === 'trolleybus' ? 'trolebus' : undefined);
  if (system) {
    // Metrobus relations use the network as ref ("Metrobus-Q"): name the corridor instead.
    const ref = /^[A-Z]\d+$/i.test(t.ref) ? t.ref.toUpperCase() : '';
    return `${SYSTEM_NAME[system]} ${ref || corridor(t.name ?? '')}`.trim();
  }
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

/** "MetroBus Ofelia - Marín" → "Ofelia – Marín". */
function corridor(name: string): string {
  return name.replace(/^(trole ?bus|ecov[ií]a|metro-?bus)\s+([A-Z]\d+\s+)?/i, '').replace(/\s*(=>|-)\s*/g, ' – ');
}

function endpoints(t: Record<string, string>): string {
  // Word starts only: "\b" treats accented letters as word breaks ("Colón" → "ColÓN").
  const cap = (s: string) => s.replace(/(^|[\s(-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
  if (t.from && t.to) return `${cap(t.from)} – ${cap(t.to)}`;
  if (transitSystem(t)) return corridor(t.name ?? '');
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

/**
 * Stops within reach of the path, in the order the path passes them, with how well they face
 * along it (1: the bus drives past them the path's way, -1: the other way).
 */
function stopsAlong(path: Vec2[], stops: Stop[]): { id: string; align: number }[] {
  const hits: { id: string; t: number; align: number }[] = [];
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
    if (best.d < REACH && Math.abs(best.align) > MIN_ALIGN) hits.push({ id: s.id, t: best.t, align: best.align });
  }
  return hits.sort((a, b) => a.t - b.t);
}

function overlap(a: string[], b: string[]): number {
  const sa = new Set(a);
  return b.filter((x) => sa.has(x)).length / Math.min(a.length, b.length);
}
