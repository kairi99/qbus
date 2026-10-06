/**
 * Every grade-separated structure in a city (underpass cuts, bridge decks), found from the data,
 * so the underpass suites iterate over all of them instead of hardcoded coordinates.
 *
 * A structure is a cluster of roads lifted off the ground (cut: lift < 0, bridge: lift > 0) whose
 * deep/high parts lie close together. A passage is one legal way through it: a chain of drivable
 * lane edges (in their direction of travel) that are lifted, from where the lift starts to where
 * it ends, extended with a straight approach and exit at street level so a vehicle can be driven
 * through it.
 */
import { readFileSync } from 'node:fs';
import type { CityData, Vec2 } from '../../src/world/cityData';
import { groundHeightAt, inPlayArea } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { type LaneEdge, type RoadGraph, buildRoadGraph, dirAt, edgeLift, edgeY, lanePoint, pointAt, projectOnPath } from '../../src/world/roadGraph';
import type { NavPath } from '../../src/gameplay/navigation';

/** An edge counts as part of a structure where its lift exceeds this (m). */
export const LIFT_EDGE = 0.3;
/** A structure must reach at least this lift somewhere (smaller is just a hump in a ramp). */
export const LIFT_STRUCTURE = 2;
/** Lifted parts of different roads closer than this (m) belong to the same structure. */
const CLUSTER = 25;
/** Straight approach and exit added at both ends of a passage (m). */
export const APPROACH = 70;
export const EXIT = 60;
/** Sampling step along lanes (m). */
export const STEP = 2;

export type Kind = 'cut' | 'bridge';

export interface Passage {
  /** Stable, readable id used in test names: structure, road names, first→last edge. */
  id: string;
  structure: string;
  kind: Kind;
  /** Lifted edges in travel order. */
  edges: number[];
  /** Approach + passage + exit, each consecutive pair joined at a graph node (legal). */
  route: number[];
  /** Index in `route` of the first passage edge. */
  first: number;
  /** Deepest (cut) or highest (bridge) point: edge and distance along it. */
  extreme: { edge: number; s: number; lift: number; pos: Vec2; y: number };
  /** Whole route inside the play area (the player can actually drive it). */
  inPlay: boolean;
  /**
   * Whether the passage starts / ends at street level. A passage that enters already down in the
   * cut (or ends there) runs off the map edge: its other end is past the roadworks.
   */
  opensAt: { start: boolean; end: boolean };
}

export interface Structure {
  id: string;
  kind: Kind;
  name: string;
  /** `city.roads` indices with a lift of this sign. */
  roads: number[];
  /** All lifted lane edges (drivable or not). */
  edges: number[];
  center: Vec2;
  /** Largest |lift|. */
  depth: number;
  passages: Passage[];
}

export function loadCity(zone = 'mariscal', hills = DEFAULT_HILLS): CityData {
  const city: CityData = JSON.parse(readFileSync(`data/cities/${zone}.json`, 'utf8'));
  city.terrain!.scale = hills;
  return city;
}

const maxAbsLift = (e: LaneEdge, sign: number) => (e.lift ? Math.max(...e.lift.map((l) => l * sign)) : 0);

export function catalog(city: CityData, graph: RoadGraph = buildRoadGraph(city)): Structure[] {
  const out: Structure[] = [];
  for (const [kind, sign] of [
    ['cut', -1],
    ['bridge', 1],
  ] as const) {
    // Lifted vertices of each road, for clustering.
    const roads = city.roads.map((r, i) => ({ r, i })).filter(({ r }) => r.lift && r.lift.some((l) => l * sign > LIFT_EDGE));
    const pts = roads.map(({ r }) => r.points.filter((_, k) => r.lift![k] * sign > 1));
    const parent = roads.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let a = 0; a < roads.length; a++)
      for (let b = a + 1; b < roads.length; b++) {
        const close = pts[a].some((p) => pts[b].some((q) => Math.hypot(p.x - q.x, p.z - q.z) < CLUSTER));
        // Ramps are joined end to end (one road's lift continues into the next).
        const [ra, rb] = [roads[a].r, roads[b].r];
        const ends = [ra.points[0], ra.points[ra.points.length - 1]];
        const joined = ends.some((p) => [rb.points[0], rb.points[rb.points.length - 1]].some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 1.5));
        if (close || joined) parent[find(a)] = find(b);
      }
    const groups = new Map<number, number[]>();
    roads.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
    for (const members of groups.values()) {
      const idx = members.map((m) => roads[m].i);
      const depth = Math.max(...idx.map((i) => Math.max(...city.roads[i].lift!.map((l) => l * sign))));
      if (depth < LIFT_STRUCTURE) continue;
      const edges = graph.edges.filter((e) => idx.includes(e.roadIndex) && maxAbsLift(e, sign) > LIFT_EDGE).map((e) => e.id);
      const deep = idx.flatMap((i) => city.roads[i].points.filter((_, k) => city.roads[i].lift![k] * sign > depth - 1.5));
      const center = { x: avg(deep.map((p) => p.x)), z: avg(deep.map((p) => p.z)) };
      // Named after the deepest/highest road with a real name, else the most common name.
      const named = idx.map((i) => city.roads[i]).filter((r) => r.name && r.name !== 'sin nombre');
      const name = (named.sort((a, b) => Math.max(...b.lift!.map((l) => l * sign)) - Math.max(...a.lift!.map((l) => l * sign)))[0]?.name ?? 'sin nombre').replace(/\s+/g, ' ');
      const id = `${kind} ${name} @(${center.x.toFixed(0)},${center.z.toFixed(0)})`;
      const s: Structure = { id, kind, name, roads: idx.sort((a, b) => a - b), edges, center, depth, passages: [] };
      s.passages = passages(city, graph, s, sign);
      out.push(s);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function passages(city: CityData, graph: RoadGraph, s: Structure, sign: number): Passage[] {
  const E = graph.edges;
  const lifted = new Set(s.edges.filter((id) => E[id].drivable));
  const out: Passage[] = [];
  // Chains start at a lifted edge with no lifted drivable edge leading into it.
  const starts = [...lifted].filter((id) => !graph.nodes[E[id].from].in.some((p) => lifted.has(p)));
  const chains: number[][] = [];
  const walk = (chain: number[]) => {
    const last = E[chain[chain.length - 1]];
    const next = graph.nodes[last.to].out.filter((n) => lifted.has(n) && !chain.includes(n) && n !== last.reverse);
    if (!next.length) chains.push(chain);
    for (const n of next) walk([...chain, n]);
  };
  for (const st of starts) walk([st]);
  for (const chain of chains) {
    if (Math.max(...chain.map((id) => maxAbsLift(E[id], sign))) < LIFT_STRUCTURE) continue;
    const before = extend(graph, chain[0], APPROACH, 'back');
    const after = extend(graph, chain[chain.length - 1], EXIT, 'ahead');
    const route = [...before, ...chain, ...after];
    let extreme = { edge: chain[0], s: 0, lift: 0, pos: E[chain[0]].a, y: 0 };
    for (const id of chain) {
      const e = E[id];
      for (let t = 0; t <= e.len; t += 1) {
        const l = edgeLift(e, t);
        if (l * sign > extreme.lift * sign) extreme = { edge: id, s: t, lift: l, pos: lanePoint(e, t, 0), y: edgeY(e, t) ?? groundHeightAt(city, lanePoint(e, t, 0)) };
      }
    }
    const roads = [...new Set(chain.map((id) => E[id].road))].join(' → ');
    const inPlay = route.every((id) => E[id].center.pts.every((p) => inPlayArea(city, p)));
    const first = E[chain[0]];
    const last = E[chain[chain.length - 1]];
    const opensAt = { start: Math.abs(edgeLift(first, 0)) < 1, end: Math.abs(edgeLift(last, last.len)) < 1 };
    out.push({ id: `${s.id}: ${roads} [e${chain[0]}→e${chain[chain.length - 1]}]`, structure: s.id, kind: s.kind, edges: chain, route, first: before.length, extreme, inPlay, opensAt });
  }
  return out;
}

/** Drivable edges before (into `from`) or after `from`, taking the straightest way, for about `len` meters. */
function extend(graph: RoadGraph, from: number, len: number, way: 'back' | 'ahead'): number[] {
  const E = graph.edges;
  const out: number[] = [];
  let cur = E[from];
  let left = len;
  for (let guard = 0; guard < 10 && left > 0; guard++) {
    const cands = way === 'ahead' ? graph.nodes[cur.to].out : graph.nodes[cur.from].in;
    const opts = cands.map((id) => E[id]).filter((o) => o.drivable && o.id !== cur.reverse && !out.includes(o.id) && o.id !== from);
    if (!opts.length) break;
    const straight = (o: LaneEdge) => (way === 'ahead' ? cur.endDir.x * o.dir.x + cur.endDir.z * o.dir.z : o.endDir.x * cur.dir.x + o.endDir.z * cur.dir.z);
    const next = opts.reduce((a, b) => (straight(a) >= straight(b) ? a : b));
    if (straight(next) < 0.3) break; // no straight way on: stop here
    if (way === 'ahead') out.push(next.id);
    else out.unshift(next.id);
    left -= next.len;
    cur = next;
  }
  return out;
}

/** A NavPath (curb lane polyline) along `route`, from `s0` on the first edge to `s1` on the last. */
export function routePath(graph: RoadGraph, route: number[], s0 = 0, s1?: number): NavPath {
  const points: Vec2[] = [];
  let length = 0;
  route.forEach((id, i) => {
    const e = graph.edges[id];
    const a = i === 0 ? s0 : 0;
    const b = i === route.length - 1 ? (s1 ?? e.len) : e.len;
    for (let s = a; s < b; s += 3) points.push(lanePoint(e, s, 0));
    points.push(lanePoint(e, b, 0));
    length += b - a;
  });
  return { edges: route, points, length };
}

/**
 * Road surface height along a route near `p`: the nearest route edge's own height (ramp, deck
 * or floor), or the junction's, else the ground. Also returns the edge and how far off it `p` is.
 */
export function surfaceAlong(city: CityData, graph: RoadGraph, route: number[], p: Vec2): { y: number; edge: number; s: number; d: number } {
  let best = { y: 0, edge: route[0], s: 0, d: Infinity };
  for (const id of route) {
    const e = graph.edges[id];
    const pr = projectOnPath(e.center, p);
    // Past either end of an edge it's the junction between edges, not this edge.
    if (pr.d < best.d) best = { y: edgeY(e, pr.s) ?? groundHeightAt(city, p), edge: id, s: pr.s, d: pr.d };
  }
  return best;
}

/** Sample points along every edge of a passage: position, travel direction, surface height, lift. */
export function* samples(graph: RoadGraph, city: CityData, edges: number[], step = STEP) {
  for (const id of edges) {
    const e = graph.edges[id];
    for (let s = 0; s <= e.len; s += step) {
      const p = lanePoint(e, s, 0);
      yield { edge: id, s, pos: p, center: pointOnCenter(e, s), dir: dirAt(e.center, s), y: edgeY(e, s) ?? groundHeightAt(city, p), lift: edgeLift(e, s) };
    }
  }
}

function pointOnCenter(e: LaneEdge, s: number): Vec2 {
  return pointAt(e.center, s);
}

/**
 * Drivable edges at a clearly different height crossing over/under `p` (the street above a cut,
 * the road below a bridge).
 */
export function crossingEdges(city: CityData, graph: RoadGraph, p: Vec2, y: number, minGap = 3): { edge: number; s: number; y: number }[] {
  const out: { edge: number; s: number; y: number }[] = [];
  for (const e of graph.edges) {
    if (!e.drivable) continue;
    const pr = projectOnPath(e.center, p);
    if (pr.d > e.roadWidth / 2 - 0.5 || pr.s < 1 || pr.s > e.len - 1) continue;
    const ey = edgeY(e, pr.s) ?? groundHeightAt(city, pointOnCenter(e, pr.s));
    if (Math.abs(ey - y) >= minGap) out.push({ edge: e.id, s: pr.s, y: ey });
  }
  return out;
}

function avg(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / (v.length || 1);
}
