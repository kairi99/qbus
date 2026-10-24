import type { Building, CircuitData, CityData, Road, Vec2 } from '../cityData';
import { buildRoadGraph, type LaneEdge } from '../roadGraph';
import { pointInPolygon } from '../geom';
import { SIDEWALK_WIDTH } from '../sidewalks';

/** A street circuit as written in `tools/zones.ts`: the street crossings it passes, in driving order. */
export interface ZoneCircuit {
  id: string;
  name: string;
  laps: number;
  /** Approximate street-crossing points (city metres); each snaps to the nearest road-graph junction. First = the start/finish line's street. */
  via: [number, number][];
}

/** A via point further than this from any junction is a wrong crossing. */
const SNAP_MAX = 25;
/** The start/finish line sits this far past the first crossing. */
const LINE_AFTER = 120;
/** Barrier stops this far short of a building. */
const BUILDING_GAP = 0.3;
/** The racing line stays this far inside the course boundary at a filleted corner. */
const LINE_MARGIN = 1.5;
/** The distance transform overestimates by up to ~8% (plus a cell): ask for that much extra. */
const RASTER_SLACK = 0.2;
/** Largest fillet radius tried. */
const MAX_RADIUS = 40;
/** Raster cell of the course region, m. */
const CELL = 0.25;
/** Distance between points of the finished lap. */
const SPACING = 2;
/** Shape points closer than this to the chord of their neighbours are not corners, m. */
const SIMPLIFY = 0.1;
/** Corner arcs are sampled this densely before the lap is resampled. */
const ARC_STEP = 0.5;
/** Raw points closer than this merge. */
const MIN_GAP = 0.5;
/** Side-street arms are followed this far looking for where they leave the course. */
const ARM_REACH = 40;

const hypot = Math.hypot;

interface Leg {
  from: number;
  to: number;
  /** Graph edges in driving order, with whether each is driven against its own direction. */
  steps: { edge: LaneEdge; reversed: boolean }[];
  meters: number;
}

/**
 * Turns the circuits of a zone into closed lap data. Between consecutive `via` points the
 * course follows the shortest path over road pieces (one-way ignored, busways never used);
 * corners are filleted with the largest radius that stays inside the barrier offsets, and
 * the barrier offsets are carriageway edge + sidewalk, clipped short of buildings.
 * `log` receives what was found (snapped junctions, streets per leg, corner radii).
 */
export function buildCircuits(roads: Road[], buildings: Building[], defs: ZoneCircuit[], log: (line: string) => void = () => {}): CircuitData[] {
  const graph = buildRoadGraph({ roads } as unknown as CityData);
  return defs.map((def) => buildCircuit(roads, graph, buildings, def, log));
}

function buildCircuit(roads: Road[], graph: ReturnType<typeof buildRoadGraph>, buildings: Building[], def: ZoneCircuit, log: (line: string) => void): CircuitData {
  // 1. Snap the crossings to junctions.
  const general = graph.nodes.filter((n) => n.access === 'general' && n.out.length + n.in.length >= 2);
  const stops = def.via.map(([x, z], k) => {
    let best = general[0];
    let bd = Infinity;
    for (const n of general) {
      const d = hypot(n.pos.x - x, n.pos.z - z);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    const names = [...new Set([...best.out, ...best.in].map((e) => graph.edges[e].road))].join(' x ');
    log(`${def.id} via ${k} (${x}, ${z}) -> junction #${best.id} (${best.pos.x.toFixed(1)}, ${best.pos.z.toFixed(1)}) ${bd.toFixed(1)} m off: ${names}`);
    if (bd > SNAP_MAX) throw new Error(`${def.id}: via ${k} (${x}, ${z}) is ${bd.toFixed(0)} m from the nearest junction: wrong crossing`);
    return best.id;
  });

  // 2. Shortest path between consecutive crossings.
  const adj = new Map<number, { to: number; edge: LaneEdge; reversed: boolean; w: number }[]>();
  for (const e of graph.edges) {
    if (e.access !== 'general') continue;
    const w = hypot(graph.nodes[e.from].pos.x - e.a.x, graph.nodes[e.from].pos.z - e.a.z) + e.len + hypot(graph.nodes[e.to].pos.x - e.b.x, graph.nodes[e.to].pos.z - e.b.z);
    for (const [a, b, reversed] of [[e.from, e.to, false], [e.to, e.from, true]] as const) {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a)!.push({ to: b, edge: e, reversed, w });
    }
  }
  const legs: Leg[] = stops.map((from, k) => shortest(adj, from, stops[(k + 1) % stops.length]));
  legs.forEach((leg, k) => {
    const runs: string[] = [];
    let last = '';
    let sum = 0;
    for (const s of leg.steps) {
      if (s.edge.road !== last) {
        if (last) runs.push(`${last} ${sum.toFixed(0)} m`);
        last = s.edge.road;
        sum = 0;
      }
      sum += s.edge.len;
    }
    if (last) runs.push(`${last} ${sum.toFixed(0)} m`);
    log(`${def.id} leg ${k + 1} (via ${k} -> ${(k + 1) % stops.length}), ${leg.meters.toFixed(0)} m: ${runs.join(' > ')}`);
  });

  // 3. The raw centreline: junction positions and road shape points, with the road each segment runs along.
  const raw: Vec2[] = [];
  const segRoad: number[] = []; // road index of the segment ending at raw[i]
  const nodeIdx: number[] = []; // graph node of raw[i], or -1
  const push = (p: Vec2, road: number, node: number) => {
    const last = raw[raw.length - 1];
    if (last && hypot(last.x - p.x, last.z - p.z) < MIN_GAP) {
      if (node >= 0) {
        raw[raw.length - 1] = { ...p };
        nodeIdx[nodeIdx.length - 1] = node;
      }
      return;
    }
    raw.push({ ...p });
    segRoad.push(road);
    nodeIdx.push(node);
  };
  const first = graph.nodes[stops[0]].pos;
  raw.push({ ...first });
  segRoad.push(-1);
  nodeIdx.push(stops[0]);
  for (const leg of legs)
    for (const s of leg.steps) {
      const pts = s.reversed ? [...s.edge.center.pts].reverse() : s.edge.center.pts;
      for (const p of pts) push(p, s.edge.roadIndex, -1);
      const end = graph.nodes[s.reversed ? s.edge.from : s.edge.to];
      push(end.pos, s.edge.roadIndex, end.id);
    }
  // The lap closes on its first point.
  if (hypot(raw[0].x - raw[raw.length - 1].x, raw[0].z - raw[raw.length - 1].z) < MIN_GAP * 2) {
    raw.pop();
    nodeIdx.pop();
    segRoad[0] = segRoad.pop()!;
  }
  const n = raw.length;
  const at = (i: number) => raw[((i % n) + n) % n];
  const roadOf = (i: number) => segRoad[((i % n) + n) % n]; // road of segment (i-1 -> i)

  // 4. The real course: the union of every driven street's corridor (carriageway + sidewalks),
  // minus the buildings (and their gap). Fillets and barrier offsets are measured against it.
  const segs: { a: Vec2; b: Vec2; w: number }[] = [];
  for (let i = 0; i < n; i++) segs.push({ a: at(i - 1), b: at(i), w: roads[roadOf(i)].width / 2 + SIDEWALK_WIDTH });
  const course = new Course(segs, buildings);

  // The corners: Douglas-Peucker on the closed course drops the straight-through shape points
  // and junction trims (a vertex a few meters from a corner would cap its fillet at half that).
  const keep = simplify(raw, SIMPLIFY);
  const V = keep.map((k) => raw[k]);
  const m = V.length;
  const atV = (i: number) => V[((i % m) + m) % m];

  // 5. Fillet every bend with the largest radius whose arc keeps LINE_MARGIN from the boundary.
  const dense: Vec2[] = [];
  let startIdx = 0;
  const radii: { node: number; at: Vec2; deg: number; r: number; clear: number }[] = [];
  for (let i = 0; i < m; i++) {
    const a = atV(i - 1);
    const b = atV(i);
    const c = atV(i + 1);
    const l1 = hypot(b.x - a.x, b.z - a.z);
    const l2 = hypot(c.x - b.x, c.z - b.z);
    const d1 = { x: (b.x - a.x) / l1, z: (b.z - a.z) / l1 };
    const d2 = { x: (c.x - b.x) / l2, z: (c.z - b.z) / l2 };
    const delta = Math.acos(Math.max(-1, Math.min(1, d1.x * d2.x + d1.z * d2.z)));
    const sgn = d1.x * d2.z - d1.z * d2.x >= 0 ? 1 : -1;
    if (delta < 0.01) {
      dense.push(b);
      if (i === 0) startIdx = dense.length - 1;
      continue;
    }
    const tanHalf = Math.tan(delta / 2);
    const rLen = (0.5 * Math.min(l1, l2)) / tanHalf;
    let r = Math.min(rLen, MAX_RADIUS);
    let arc = arcPoints(b, d1, delta, sgn, r, tanHalf);
    let clear = Math.min(...arc.map((q) => course.clearance(q)));
    while (clear < LINE_MARGIN + RASTER_SLACK && r > 1) {
      r = Math.max(1, r * 0.95);
      arc = arcPoints(b, d1, delta, sgn, r, tanHalf);
      clear = Math.min(...arc.map((q) => course.clearance(q)));
    }
    for (const q of arc) dense.push(q);
    if (i === 0) startIdx = dense.length - 1; // the corner's exit: the lap starts on the street that follows
    if (delta > 0.35) radii.push({ node: nodeIdx[keep[i]], at: b, deg: (delta * 180) / Math.PI, r, clear });
  }
  for (const c of radii) log(`${def.id} corner at (${c.at.x.toFixed(0)}, ${c.at.z.toFixed(0)}) ${c.deg.toFixed(0)} deg: radius ${c.r.toFixed(1)} m, ${c.clear.toFixed(1)} m clear of the boundary`);

  // 6. Rotate to start after the first corner, resample every ~SPACING m.
  const loop = [...dense.slice(startIdx), ...dense.slice(0, startIdx)];
  loop.push({ ...loop[0] });
  const cum = [0];
  for (let i = 1; i < loop.length; i++) cum.push(cum[i - 1] + hypot(loop[i].x - loop[i - 1].x, loop[i].z - loop[i - 1].z));
  const total = cum[cum.length - 1];
  const count = Math.round(total / SPACING);
  const step = total / count;
  const points: Vec2[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const s = k * step;
    while (cum[seg] < s) seg++;
    const t = (s - cum[seg - 1]) / (cum[seg] - cum[seg - 1] || 1);
    points.push({ x: loop[seg - 1].x + (loop[seg].x - loop[seg - 1].x) * t, z: loop[seg - 1].z + (loop[seg].z - loop[seg - 1].z) * t });
  }
  points.push({ ...points[0] });
  // The road each point runs along: that of the nearest driven segment.
  const road = points.map((q) => {
    let best = roadOf(1);
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = segDist(q, at(i - 1), at(i));
      if (d < bd) {
        bd = d;
        best = roadOf(i);
      }
    }
    return best;
  });

  // 7. Offsets: how far the real course boundary is either side of the line (right-hand
  // normal (-dz, dx): +Z is right when facing +X). Never less than the carriageway.
  const halfRoad = road.map((ri) => roads[ri].width / 2);
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const d = hypot(b.x - a.x, b.z - a.z) || 1;
    const nr = { x: -(b.z - a.z) / d, z: (b.x - a.x) / d };
    right.push(Math.max(halfRoad[i], course.ray(points[i], nr)));
    left.push(Math.max(halfRoad[i], course.ray(points[i], { x: -nr.x, z: -nr.z })));
  }

  // 8. The start/finish line: LINE_AFTER m past the first crossing along the raw course.
  let lineRaw = first;
  {
    let left = LINE_AFTER;
    for (let i = 1; i < raw.length; i++) {
      const l = hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
      if (l >= left) {
        lineRaw = { x: raw[i - 1].x + ((raw[i].x - raw[i - 1].x) * left) / l, z: raw[i - 1].z + ((raw[i].z - raw[i - 1].z) * left) / l };
        break;
      }
      left -= l;
    }
  }
  let line = 0;
  {
    let bd = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const d = hypot(points[i].x - lineRaw.x, points[i].z - lineRaw.z);
      if (d < bd) {
        bd = d;
        line = i * step;
      }
    }
  }

  // 9. Mouths: where the other roads meeting the course leave its barrier line.
  const mouths = findMouths(roads, graph, points, step, left, right, stops, legs);
  const minW = Math.min(...points.map((_, i) => left[i] + right[i]));
  log(`${def.id}: lap ${(total).toFixed(0)} m, ${points.length - 1} points, line at s=${line.toFixed(0)}, ${mouths.length} mouths, min width ${minW.toFixed(1)} m`);

  return {
    id: def.id,
    name: def.name,
    laps: def.laps,
    points: points.map((p) => ({ x: round(p.x), z: round(p.z) })),
    left: left.map(round),
    right: right.map(round),
    halfRoad,
    mouths,
    line: round(line),
  };
}

const round = (v: number) => Math.round(v * 100) / 100;

/** Indices of the closed polyline's vertices kept by Douglas-Peucker with tolerance tol (index 0 and the farthest from it are anchors). */
function simplify(pts: Vec2[], tol: number): number[] {
  const n = pts.length;
  let far = 1;
  let fd = 0;
  for (let i = 1; i < n; i++) {
    const d = hypot(pts[i].x - pts[0].x, pts[i].z - pts[0].z);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const keep = new Set<number>([0, far]);
  const run = (i0: number, i1: number) => {
    // Vertices strictly between i0 and i1 (indices may wrap past n).
    let best = -1;
    let bd = tol;
    for (let k = i0 + 1; k < i1; k++) {
      const d = segDist(pts[k % n], pts[i0 % n], pts[i1 % n]);
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best < 0) return;
    keep.add(best % n);
    run(i0, best);
    run(best, i1);
  };
  run(0, far);
  run(far, n);
  return [...keep].sort((a, b) => a - b);
}

function shortest(adj: Map<number, { to: number; edge: LaneEdge; reversed: boolean; w: number }[]>, from: number, to: number): Leg {
  if (from === to) throw new Error(`circuit: two consecutive crossings snap to the same junction #${from}`);
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, { node: number; edge: LaneEdge; reversed: boolean }>();
  const open = new Set<number>([from]);
  const done = new Set<number>();
  while (open.size) {
    let u = -1;
    for (const v of open) if (u < 0 || dist.get(v)! < dist.get(u)!) u = v;
    open.delete(u);
    if (done.has(u)) continue;
    done.add(u);
    if (u === to) break;
    for (const a of adj.get(u) ?? []) {
      const nd = dist.get(u)! + a.w;
      if (nd < (dist.get(a.to) ?? Infinity)) {
        dist.set(a.to, nd);
        prev.set(a.to, { node: u, edge: a.edge, reversed: a.reversed });
        open.add(a.to);
      }
    }
  }
  if (!prev.has(to)) throw new Error(`circuit: no path between junctions #${from} and #${to}`);
  const steps: Leg['steps'] = [];
  for (let v = to; v !== from; ) {
    const p = prev.get(v)!;
    steps.unshift({ edge: p.edge, reversed: p.reversed });
    v = p.node;
  }
  return { from, to, steps, meters: dist.get(to)! };
}

/** Arc of radius r rounding the corner at b (incoming direction d1, turning `delta` toward `sgn`), tangent point to tangent point. */
function arcPoints(b: Vec2, d1: Vec2, delta: number, sgn: number, r: number, tanHalf: number): Vec2[] {
  const t = r * tanHalf;
  const t1 = { x: b.x - d1.x * t, z: b.z - d1.z * t };
  const center = { x: t1.x + sgn * -d1.z * r, z: t1.z + sgn * d1.x * r };
  const a0 = Math.atan2(t1.z - center.z, t1.x - center.x);
  const steps = Math.max(2, Math.ceil((r * delta) / ARC_STEP));
  const out: Vec2[] = [];
  for (let k = 0; k <= steps; k++) {
    const ang = a0 + sgn * delta * (k / steps);
    out.push({ x: center.x + Math.cos(ang) * r, z: center.z + Math.sin(ang) * r });
  }
  return out;
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/** Nearest point of the closed lap to p: index and distance. */
function nearestOnLap(points: Vec2[], p: Vec2): { i: number; d: number } {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const d = hypot(points[i].x - p.x, points[i].z - p.z);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return { i: bi, d: bd };
}

function findMouths(
  roads: Road[],
  graph: ReturnType<typeof buildRoadGraph>,
  points: Vec2[],
  step: number,
  left: number[],
  right: number[],
  stops: number[],
  legs: Leg[],
): CircuitData['mouths'] {
  // Pieces the course drives, and the graph nodes it passes.
  const used = new Set<number>();
  const nodes = new Set<number>(stops);
  for (const leg of legs)
    for (const s of leg.steps) {
      used.add(s.edge.piece);
      nodes.add(s.edge.from);
      nodes.add(s.edge.to);
    }
  const mouths: CircuitData['mouths'] = [];
  const seen = new Set<number>();
  for (const id of nodes) {
    const node = graph.nodes[id];
    for (const eid of [...node.out, ...node.in]) {
      const e = graph.edges[eid];
      if (used.has(e.piece) || seen.has(e.piece)) continue;
      seen.add(e.piece);
      // Walk the arm outward from the junction to where it leaves the barrier line.
      const outward = e.from === id ? e.center.pts : [...e.center.pts].reverse();
      const arm: Vec2[] = [node.pos, ...outward];
      let found: { i: number; side: 1 | -1 } | null = null;
      let walked = 0;
      for (let k = 1; k < arm.length && !found && walked < ARM_REACH; k++) {
        const l = hypot(arm[k].x - arm[k - 1].x, arm[k].z - arm[k - 1].z);
        for (let u = 0; u < l && walked + u < ARM_REACH; u += 0.5) {
          const q = { x: arm[k - 1].x + ((arm[k].x - arm[k - 1].x) * u) / (l || 1), z: arm[k - 1].z + ((arm[k].z - arm[k - 1].z) * u) / (l || 1) };
          const { i, d } = nearestOnLap(points, q);
          const a = points[i];
          const b = points[i + 1];
          const len = hypot(b.x - a.x, b.z - a.z) || 1;
          const nr = { x: -(b.z - a.z) / len, z: (b.x - a.x) / len };
          const side = (q.x - a.x) * nr.x + (q.z - a.z) * nr.z >= 0 ? 1 : -1;
          if (d >= (side === 1 ? right[i] : left[i])) {
            found = { i, side };
            break;
          }
        }
        walked += l;
      }
      if (!found) continue;
      mouths.push({ s: round(found.i * step), side: found.side, width: round(roads[e.roadIndex].width + 2 * SIDEWALK_WIDTH) });
    }
  }
  // Openings on one side that overlap (street continuations at a corner) are one opening spanning both.
  const merged: CircuitData['mouths'] = [];
  for (const side of [1, -1] as const) {
    const own = mouths.filter((m) => m.side === side).sort((x, y) => x.s - y.s);
    let cur: { lo: number; hi: number } | null = null;
    const flush = () => {
      if (cur) merged.push({ s: round((cur.lo + cur.hi) / 2), side, width: round(cur.hi - cur.lo) });
    };
    for (const m of own) {
      const lo = m.s - m.width / 2;
      const hi = m.s + m.width / 2;
      if (cur && lo < cur.hi) cur.hi = Math.max(cur.hi, hi);
      else {
        flush();
        cur = { lo, hi };
      }
    }
    flush();
  }
  return merged.sort((a, b) => a.s - b.s || a.side - b.side);
}

/**
 * The ground the course may use, rasterized: every point within a driven street's corridor
 * (half width = carriageway half + sidewalk, so the union at a junction takes in both streets'
 * corners) and not within BUILDING_GAP of a building. `clearance` is the distance to the nearest
 * blocked cell (chamfer transform), `ray` how far a ray runs before it leaves the course.
 */
class Course {
  private x0: number;
  private z0: number;
  private w: number;
  private h: number;
  private free: Uint8Array;
  private dist: Float32Array;

  constructor(segs: { a: Vec2; b: Vec2; w: number }[], buildings: Building[]) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let pad = 0;
    for (const s of segs) {
      x0 = Math.min(x0, s.a.x, s.b.x);
      x1 = Math.max(x1, s.a.x, s.b.x);
      z0 = Math.min(z0, s.a.z, s.b.z);
      z1 = Math.max(z1, s.a.z, s.b.z);
      pad = Math.max(pad, s.w);
    }
    pad += 6;
    this.x0 = x0 - pad;
    this.z0 = z0 - pad;
    this.w = Math.ceil((x1 - x0 + 2 * pad) / CELL);
    this.h = Math.ceil((z1 - z0 + 2 * pad) / CELL);
    this.free = new Uint8Array(this.w * this.h);
    for (const s of segs) {
      const cx0 = Math.max(0, Math.floor((Math.min(s.a.x, s.b.x) - s.w - this.x0) / CELL));
      const cx1 = Math.min(this.w - 1, Math.ceil((Math.max(s.a.x, s.b.x) + s.w - this.x0) / CELL));
      const cz0 = Math.max(0, Math.floor((Math.min(s.a.z, s.b.z) - s.w - this.z0) / CELL));
      const cz1 = Math.min(this.h - 1, Math.ceil((Math.max(s.a.z, s.b.z) + s.w - this.z0) / CELL));
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const p = { x: this.x0 + (cx + 0.5) * CELL, z: this.z0 + (cz + 0.5) * CELL };
          if (segDist(p, s.a, s.b) <= s.w) this.free[cz * this.w + cx] = 1;
        }
    }
    for (const bld of buildings) {
      const f = bld.footprint;
      let bx0 = Infinity;
      let bx1 = -Infinity;
      let bz0 = Infinity;
      let bz1 = -Infinity;
      for (const p of f) {
        bx0 = Math.min(bx0, p.x);
        bx1 = Math.max(bx1, p.x);
        bz0 = Math.min(bz0, p.z);
        bz1 = Math.max(bz1, p.z);
      }
      const cx0 = Math.max(0, Math.floor((bx0 - BUILDING_GAP - this.x0) / CELL));
      const cx1 = Math.min(this.w - 1, Math.ceil((bx1 + BUILDING_GAP - this.x0) / CELL));
      const cz0 = Math.max(0, Math.floor((bz0 - BUILDING_GAP - this.z0) / CELL));
      const cz1 = Math.min(this.h - 1, Math.ceil((bz1 + BUILDING_GAP - this.z0) / CELL));
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          if (!this.free[cz * this.w + cx]) continue;
          const p = { x: this.x0 + (cx + 0.5) * CELL, z: this.z0 + (cz + 0.5) * CELL };
          let blocked = pointInPolygon(p, f);
          for (let k = 0; !blocked && k < f.length; k++) blocked = segDist(p, f[k], f[(k + 1) % f.length]) <= BUILDING_GAP;
          if (blocked) this.free[cz * this.w + cx] = 0;
        }
    }
    // Chamfer distance to the nearest blocked cell (and the raster's edge), in meters.
    const { w, h } = this;
    const d = new Float32Array(w * h);
    const BIG = 1e6;
    const D2 = Math.SQRT2 * CELL;
    for (let i = 0; i < d.length; i++) d[i] = this.free[i] ? BIG : 0;
    for (let cz = 0; cz < h; cz++)
      for (let cx = 0; cx < w; cx++) {
        const i = cz * w + cx;
        if (!d[i]) continue;
        let v = cx === 0 || cz === 0 ? CELL : d[i];
        if (cx > 0) v = Math.min(v, d[i - 1] + CELL);
        if (cz > 0) {
          v = Math.min(v, d[i - w] + CELL);
          if (cx > 0) v = Math.min(v, d[i - w - 1] + D2);
          if (cx < w - 1) v = Math.min(v, d[i - w + 1] + D2);
        }
        d[i] = v;
      }
    for (let cz = h - 1; cz >= 0; cz--)
      for (let cx = w - 1; cx >= 0; cx--) {
        const i = cz * w + cx;
        if (!d[i]) continue;
        let v = cx === w - 1 || cz === h - 1 ? CELL : d[i];
        if (cx < w - 1) v = Math.min(v, d[i + 1] + CELL);
        if (cz < h - 1) {
          v = Math.min(v, d[i + w] + CELL);
          if (cx < w - 1) v = Math.min(v, d[i + w + 1] + D2);
          if (cx > 0) v = Math.min(v, d[i + w - 1] + D2);
        }
        d[i] = Math.min(d[i], v);
      }
    this.dist = d;
  }

  private cell(p: Vec2): number {
    const cx = Math.floor((p.x - this.x0) / CELL);
    const cz = Math.floor((p.z - this.z0) / CELL);
    return cx < 0 || cz < 0 || cx >= this.w || cz >= this.h ? -1 : cz * this.w + cx;
  }

  /** Meters from p to the nearest blocked ground (0 outside the course). */
  clearance(p: Vec2): number {
    const i = this.cell(p);
    return i < 0 ? 0 : this.dist[i];
  }

  /** Meters a ray from p along unit d runs inside the course. */
  ray(p: Vec2, d: Vec2): number {
    for (let u = 0; u < 40; u += CELL) {
      const i = this.cell({ x: p.x + d.x * u, z: p.z + d.z * u });
      if (i < 0 || !this.free[i]) return u;
    }
    return 40;
  }
}
