import type { Road, Vec2 } from '../cityData';

/**
 * Divided avenues: two one-way carriageways with the same name side by side. Traffic keeps to
 * the right, so each one's twin runs the opposite way on its left. A way drawn backwards in OSM
 * (it happens: an editor "moving" a node reversed Av. América's northbound carriageway) makes
 * both run the same way, and the import can't tell on its own: this finds such stretches.
 */

/** Twins are parallel carriageways this far apart (center to center), meters. */
const MIN_GAP = 4;
const MAX_GAP = 45;
/** How parallel a twin must be (|cos| of the angle between them). */
const PARALLEL = 0.9;
const STEP = 10;

export interface CarriagewaySample {
  name: string;
  road: number;
  pos: Vec2;
  dir: Vec2;
  /** The nearest parallel carriageway of the same name, if any. */
  twin?: { road: number; dir: Vec2; gap: number };
}

/** Samples every one-way named road and pairs each sample with its twin carriageway. */
export function carriagewaySamples(roads: Road[]): CarriagewaySample[] {
  const samples: CarriagewaySample[] = [];
  roads.forEach((r, road) => {
    if (!r.oneway || /sin nombre/i.test(r.name)) return;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      for (let s = STEP / 2; s < len; s += STEP) samples.push({ name: r.name, road, pos: { x: a.x + dir.x * s, z: a.z + dir.z * s }, dir });
    }
  });
  const byName = new Map<string, CarriagewaySample[]>();
  for (const s of samples) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  for (const group of byName.values())
    for (const s of group) {
      let best: CarriagewaySample['twin'];
      for (const o of group) {
        if (o.road === s.road || Math.abs(o.dir.x * s.dir.x + o.dir.z * s.dir.z) < PARALLEL) continue;
        const dx = o.pos.x - s.pos.x;
        const dz = o.pos.z - s.pos.z;
        const along = dx * s.dir.x + dz * s.dir.z;
        const gap = Math.abs(dx * s.dir.z - dz * s.dir.x);
        if (Math.abs(along) > STEP || gap < MIN_GAP || gap > MAX_GAP) continue;
        if (!best || gap < best.gap) best = { road: o.road, dir: o.dir, gap };
      }
      s.twin = best;
    }
  return samples;
}

export interface WrongWayStretch {
  name: string;
  /** The two carriageways (road indices) running the same way side by side. */
  roads: [number, number];
  from: Vec2;
  to: Vec2;
  length: number;
}

/** How far along its own carriageway a branch is followed to find where it splits off or merges. */
const BRANCH_REACH = 250;

/**
 * Same-name one-way roads reachable from `road` by following the traffic on it (forward) or
 * back against it, up to `reach` meters each way, including `road` itself.
 */
const pointKey = (p: Vec2) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;

function carriageway(roads: Road[], road: number, reach: number): Set<number> {
  const key = pointKey;
  const name = roads[road].name;
  const seen = new Set([road]);
  const walk = (from: number, forward: boolean, left: number) => {
    if (left <= 0) return;
    const pts = roads[from].points;
    const at = key(forward ? pts[pts.length - 1] : pts[0]);
    roads.forEach((r, i) => {
      if (seen.has(i) || !r.oneway || r.name !== name || key(forward ? r.points[0] : r.points[r.points.length - 1]) !== at) return;
      seen.add(i);
      let len = 0;
      for (let k = 1; k < r.points.length; k++) len += Math.hypot(r.points[k].x - r.points[k - 1].x, r.points[k].z - r.points[k - 1].z);
      walk(i, forward, left - len);
    });
  };
  walk(road, true, reach);
  walk(road, false, reach);
  return seen;
}

/**
 * Stretches of divided avenues whose two carriageways run the same way. Two branches of one
 * carriageway (a split into a tunnel and a surface lane, a slip lane) also run side by side the
 * same way, but they split off from or merge into each other: those are left out.
 */
export function sameWayStretches(roads: Road[], minLength = 20): WrongWayStretch[] {
  const out: WrongWayStretch[] = [];
  let cur: WrongWayStretch | null = null;
  const chains = new Map<number, Set<number>>();
  const chain = (r: number) => chains.get(r) ?? chains.set(r, carriageway(roads, r, BRANCH_REACH)).get(r)!;
  // Branches meet: one chain runs into the other, or both leave from (or end at) one point.
  const ends = (rs: Set<number>) => new Set([...rs].flatMap((r) => [`s${pointKey(roads[r].points[0])}`, `e${pointKey(roads[r].points.at(-1)!)}`]));
  const branches = (a: number, b: number) => {
    const cb = chain(b);
    const eb = ends(cb);
    return [...chain(a)].some((r) => cb.has(r)) || [...ends(chain(a))].some((k) => eb.has(k));
  };
  for (const s of carriagewaySamples(roads)) {
    const same = s.twin && s.twin.dir.x * s.dir.x + s.twin.dir.z * s.dir.z > 0 && !branches(s.road, s.twin.road);
    if (same && cur && cur.roads[0] === s.road && cur.roads[1] === s.twin!.road) {
      cur.to = s.pos;
      cur.length += STEP;
      continue;
    }
    if (cur && cur.length >= minLength) out.push(cur);
    cur = same ? { name: s.name, roads: [s.road, s.twin!.road], from: s.pos, to: s.pos, length: STEP } : null;
  }
  if (cur && cur.length >= minLength) out.push(cur);
  // Each stretch is found from both carriageways: keep one.
  return out.filter((w, i) => !out.some((o, j) => j < i && o.roads[0] === w.roads[1] && o.roads[1] === w.roads[0]));
}
