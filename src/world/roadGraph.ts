import type { CityData, Road, Vec2 } from './cityData';
import { segmentIntersection } from './geom';

export interface GraphNode {
  id: number;
  pos: Vec2;
  /** Outgoing directed edge ids. */
  out: number[];
  /** Incoming directed edge ids. */
  in: number[];
  /** Where three or more road pieces meet (cars take turns; pedestrians may cross). */
  junction: boolean;
  /** A sharp bend between two pieces: trimmed like a junction so cars can round it. */
  corner: boolean;
  /** Paved area of a junction/corner: convex hull of the road ends meeting there. */
  hull: Vec2[] | null;
}

/** A polyline with cumulative distances. */
export interface Path {
  pts: Vec2[];
  cum: number[];
  len: number;
}

/** One direction of travel along a road piece between two nodes. */
export interface LaneEdge {
  id: number;
  from: number;
  to: number;
  /** Centerline, trimmed back from the intersection boxes at both ends. */
  center: Path;
  /** First and last centerline points. */
  a: Vec2;
  b: Vec2;
  /** One path per lane, offset from the centerline. Lane 0 is next to the curb. */
  lanePaths: Path[];
  /** Direction at the start / end of the edge. */
  dir: Vec2;
  endDir: Vec2;
  heading: number;
  endHeading: number;
  len: number;
  lanes: number;
  laneWidth: number;
  roadWidth: number;
  /** The opposite direction of the same piece, or -1 on one-way roads. */
  reverse: number;
  /** Undirected piece this edge runs along (shared with `reverse`). */
  piece: number;
  road: string;
  oneway: boolean;
  /** Part of the strongly connected core: a car can always drive on from here. */
  drivable: boolean;
}

export interface RoadGraph {
  nodes: GraphNode[];
  edges: LaneEdge[];
}

const MERGE = 1;
const CELL = 40;
const MIN_EDGE = 3;
/** Trims never exceed this; intersections never grow wider than MAX_CLUSTER. */
const MAX_TRIM = 15;
const MAX_CLUSTER = 35;

interface Piece {
  road: number;
  pts: Vec2[];
  a: number;
  b: number;
}

/**
 * Directed lane graph for any road layout. Nodes sit where roads cross or end; intersections
 * closer together than their own size (divided avenues) are merged into one cluster so every
 * remaining edge has room for a car. One-way roads get a single edge.
 */
export function buildRoadGraph(city: CityData): RoadGraph {
  const roads = city.roads;

  // 1. Raw nodes at road ends and crossings, found through a segment hash.
  const raw: { pos: Vec2; halfWidth: number }[] = [];
  const nodeHash = new Map<string, number[]>();
  const nodeAt = (p: Vec2, halfWidth: number): number => {
    const kx = Math.floor(p.x / MERGE);
    const kz = Math.floor(p.z / MERGE);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const id of nodeHash.get(`${kx + dx},${kz + dz}`) ?? []) {
          if (Math.hypot(raw[id].pos.x - p.x, raw[id].pos.z - p.z) < MERGE) {
            raw[id].halfWidth = Math.max(raw[id].halfWidth, halfWidth);
            return id;
          }
        }
    raw.push({ pos: { ...p }, halfWidth });
    const key = `${kx},${kz}`;
    nodeHash.set(key, [...(nodeHash.get(key) ?? []), raw.length - 1]);
    return raw.length - 1;
  };
  const segHash = new Map<string, [number, number][]>();
  roads.forEach((r, ri) => {
    for (let i = 0; i < r.points.length - 1; i++) {
      for (const key of cellsOf(r.points[i], r.points[i + 1])) segHash.set(key, [...(segHash.get(key) ?? []), [ri, i]]);
    }
  });

  const pieces: Piece[] = [];
  roads.forEach((r, ri) => {
    const cuts: { i: number; t: number; node: number; pos: Vec2 }[] = [];
    const first = r.points[0];
    const last = r.points[r.points.length - 1];
    cuts.push({ i: 0, t: 0, node: nodeAt(first, r.width / 2), pos: first });
    cuts.push({ i: r.points.length - 2, t: 1, node: nodeAt(last, r.width / 2), pos: last });
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const seen = new Set<string>();
      for (const key of cellsOf(a, b))
        for (const [oi, j] of segHash.get(key) ?? []) {
          if (oi === ri || seen.has(`${oi},${j}`)) continue;
          seen.add(`${oi},${j}`);
          const o = roads[oi];
          const hit = segmentIntersection(a, b, o.points[j], o.points[j + 1]);
          if (!hit) continue;
          const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          cuts.push({ i, t: Math.hypot(hit.x - a.x, hit.z - a.z) / len, node: nodeAt(hit, Math.max(r.width, o.width) / 2), pos: hit });
        }
    }
    cuts.sort((x, y) => x.i + x.t - (y.i + y.t));
    for (let k = 0; k < cuts.length - 1; k++) {
      const c0 = cuts[k];
      const c1 = cuts[k + 1];
      if (c0.node === c1.node) continue;
      const p0 = c0.i + c0.t;
      const p1 = c1.i + c1.t;
      const pts = [raw[c0.node].pos];
      for (let v = Math.ceil(p0); v <= Math.floor(p1); v++) if (v > p0 + 1e-9 && v < p1 - 1e-9) pts.push(r.points[v]);
      pts.push(raw[c1.node].pos);
      pieces.push({ road: ri, pts: dedupe(pts), a: c0.node, b: c1.node });
    }
  });

  // 2. Cluster intersections and decide how far each road is cut back from them. Each piece end
  // must clear every other road at its node, which at sharp merges means going well back.
  // Pieces left too short to hold a car are folded into the intersection, and we try again.
  const degree = new Array(raw.length).fill(0);
  for (const p of pieces) degree[p.a]++, degree[p.b]++;
  const parent = raw.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const leaving = (p: Piece, atStart: boolean) =>
    atStart ? unit(p.pts[0], p.pts[1]) : unit(p.pts[p.pts.length - 1], p.pts[p.pts.length - 2]);
  let trims = new Map<Piece, [number, number]>();
  const shrunk = new Map<Piece, [number, number]>();
  const clusterMembers = new Map<number, number[]>();
  let kind = new Map<number, 'junction' | 'corner' | 'through'>();
  for (let pass = 0; pass < 6; pass++) {
    const ends = new Map<number, { p: Piece; start: boolean; dir: Vec2; w: number }[]>();
    for (const p of pieces) {
      const A = find(p.a);
      const B = find(p.b);
      if (A === B) continue;
      const w = roads[p.road].width;
      ends.set(A, [...(ends.get(A) ?? []), { p, start: true, dir: leaving(p, true), w }]);
      ends.set(B, [...(ends.get(B) ?? []), { p, start: false, dir: leaving(p, false), w }]);
    }
    kind = new Map();
    trims = new Map(pieces.map((p) => [p, [0, 0]]));
    for (const [c, list] of ends) {
      const k = list.length >= 3 ? 'junction' : list.length === 2 && dot2(list[0].dir, list[1].dir) > -0.82 ? 'corner' : 'through';
      kind.set(c, k);
      if (k === 'through') continue;
      for (const e of list) {
        let trim = 1;
        for (const o of list) {
          if (o === e) continue;
          const cos = dot2(e.dir, o.dir);
          if (cos < -0.87) continue; // straight across: no conflict
          const sin = Math.sqrt(Math.max(0.05, 1 - cos * cos));
          // Our corner nearest the other road must be outside its asphalt (plus a meter).
          trim = Math.max(trim, (o.w / 2 + 1 + (e.w / 2) * Math.max(0, cos)) / sin);
        }
        const t = trims.get(e.p)!;
        t[e.start ? 0 : 1] = Math.min(trim, MAX_TRIM);
      }
    }
    let changed = false;
    for (const p of pieces) {
      const A = find(p.a);
      const B = find(p.b);
      if (A === B) continue;
      const t = trims.get(p)!;
      const len = pathLength(p.pts);
      if (len - t[0] - t[1] >= MIN_EDGE) continue;
      const merged = [...(clusterMembers.get(A) ?? [A]), ...(clusterMembers.get(B) ?? [B])];
      if (diameter(merged.map((m) => raw[m].pos)) <= MAX_CLUSTER) {
        parent[A] = B;
        clusterMembers.set(B, merged);
        changed = true;
      } else {
        // Too big to be one intersection: keep the piece, cut back less.
        const k = Math.max(0, len - MIN_EDGE) / (t[0] + t[1] || 1);
        shrunk.set(p, [t[0] * k, t[1] * k]);
      }
    }
    if (!changed) break;
  }
  for (const [p, t] of shrunk) if (find(p.a) !== find(p.b)) trims.set(p, t);

  // 3. Graph nodes = clusters that still have external pieces.
  const clusterId = new Map<number, number>();
  const nodes: GraphNode[] = [];
  const external = pieces.filter((p) => find(p.a) !== find(p.b));
  const members = new Map<number, number[]>();
  raw.forEach((_, i) => members.set(find(i), [...(members.get(find(i)) ?? []), i]));
  const nodeOf = (rawId: number): number => {
    const c = find(rawId);
    let id = clusterId.get(c);
    if (id === undefined) {
      // Position from the real crossings in the cluster, not the dead-end stubs merged into it.
      const all = members.get(c)!;
      const cross = all.filter((m) => degree[m] >= 3);
      const ms = cross.length ? cross : all;
      const pos = { x: ms.reduce((s, m) => s + raw[m].pos.x, 0) / ms.length, z: ms.reduce((s, m) => s + raw[m].pos.z, 0) / ms.length };
      const k = kind.get(c);
      id = nodes.length;
      nodes.push({ id, pos, out: [], in: [], junction: k === 'junction', corner: k === 'corner', hull: null });
      clusterId.set(c, id);
    }
    return id;
  };

  // 4. Directed edges along each external piece, trimmed where they meet a junction.
  const edges: LaneEdge[] = [];
  external.forEach((p, pieceId) => {
    const r = roads[p.road];
    const A = nodeOf(p.a);
    const B = nodeOf(p.b);
    const [trimA, trimB] = trims.get(p)!;
    const center = trimPath(makePath(p.pts), trimA, trimB);
    if (!center || center.len < 1) return;
    const make = (path: Path, from: number, to: number, lanesDir: number): LaneEdge => {
      const laneWidth = r.oneway ? r.width / lanesDir : r.width / (2 * lanesDir);
      const e: LaneEdge = {
        id: edges.length,
        from,
        to,
        center: path,
        a: path.pts[0],
        b: path.pts[path.pts.length - 1],
        lanePaths: [],
        dir: dirAt(path, 0),
        endDir: dirAt(path, path.len),
        heading: 0,
        endHeading: 0,
        len: path.len,
        lanes: lanesDir,
        laneWidth,
        roadWidth: r.width,
        reverse: -1,
        piece: pieceId,
        road: r.name,
        oneway: !!r.oneway,
        drivable: false,
      };
      e.heading = Math.atan2(-e.dir.z, e.dir.x);
      e.endHeading = Math.atan2(-e.endDir.z, e.endDir.x);
      for (let k = 0; k < lanesDir; k++) e.lanePaths.push(offsetPath(path, laneOffset(e, k)));
      edges.push(e);
      nodes[from].out.push(e.id);
      nodes[to].in.push(e.id);
      return e;
    };
    if (r.oneway) {
      make(center, A, B, Math.max(1, r.lanes));
    } else {
      const lanesDir = Math.max(1, Math.floor(r.lanes / 2));
      const fwd = make(center, A, B, lanesDir);
      const back = make(reversePath(center), B, A, lanesDir);
      fwd.reverse = back.id;
      back.reverse = fwd.id;
    }
  });

  for (const n of nodes) {
    if (!n.junction && !n.corner) continue;
    const pts: Vec2[] = [];
    const add = (p: Vec2, d: Vec2, w: number) => pts.push({ x: p.x - d.z * (w / 2), z: p.z + d.x * (w / 2) }, { x: p.x + d.z * (w / 2), z: p.z - d.x * (w / 2) });
    for (const id of n.in) add(edges[id].b, edges[id].endDir, edges[id].roadWidth);
    for (const id of n.out) add(edges[id].a, edges[id].dir, edges[id].roadWidth);
    n.hull = convexHull(pts);
  }
  markDrivable(nodes, edges);
  return { nodes, edges };
}

/** Distance from the centerline to the middle of lane `k` (0 = curb lane), to the right. */
export function laneOffset(e: Pick<LaneEdge, 'roadWidth' | 'laneWidth'>, k: number): number {
  return e.roadWidth / 2 - e.laneWidth * (k + 0.5);
}

/** Point `s` meters along lane `k` (or along the centerline shifted by `offset`, during lane changes). */
export function lanePoint(e: LaneEdge, s: number, k: number, offset?: number): Vec2 {
  if (offset === undefined) return pointAt(e.lanePaths[k], s * (e.lanePaths[k].len / e.len));
  const p = pointAt(e.center, s);
  const d = dirAt(e.center, s);
  return { x: p.x - d.z * offset, z: p.z + d.x * offset };
}

/** Closest point on a path: distance along it and distance from it. */
export function projectOnPath(p: Path, q: Vec2): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 0; i < p.pts.length - 1; i++) {
    const a = p.pts[i];
    const b = p.pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.z - a.z) * dz) / l2));
    const d = Math.hypot(q.x - (a.x + u * dx), q.z - (a.z + u * dz));
    if (d < best.d) best = { s: p.cum[i] + u * Math.sqrt(l2), d };
  }
  return best;
}

/** Travel direction `s` meters along the edge. */
export function edgeDir(e: LaneEdge, s: number): Vec2 {
  return dirAt(e.center, s);
}

// ---- paths -----------------------------------------------------------------

export function makePath(pts: Vec2[]): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] };
}

export function pointAt(p: Path, s: number): Vec2 {
  const i = segIndex(p, s);
  const a = p.pts[i];
  const b = p.pts[i + 1];
  const seg = p.cum[i + 1] - p.cum[i] || 1;
  const u = Math.max(0, Math.min(1, (s - p.cum[i]) / seg));
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
}

export function dirAt(p: Path, s: number): Vec2 {
  const i = segIndex(p, s);
  const a = p.pts[i];
  const b = p.pts[i + 1];
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}

function segIndex(p: Path, s: number): number {
  let lo = 0;
  let hi = p.pts.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function trimPath(p: Path, a: number, b: number): Path | null {
  if (p.len - a - b < MIN_EDGE * 0.5) return null;
  const start = a;
  const end = p.len - b;
  const pts = [pointAt(p, start)];
  for (let i = 1; i < p.pts.length - 1; i++) if (p.cum[i] > start && p.cum[i] < end) pts.push(p.pts[i]);
  pts.push(pointAt(p, end));
  return makePath(dedupe(pts));
}

function reversePath(p: Path): Path {
  return makePath([...p.pts].reverse());
}

/** Parallel curve `off` meters to the right, with mitered joins. */
export function offsetPath(p: Path, off: number): Path {
  const n = p.pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const d0 = i > 0 ? unit(p.pts[i - 1], p.pts[i]) : unit(p.pts[0], p.pts[1]);
    const d1 = i < n - 1 ? unit(p.pts[i], p.pts[i + 1]) : d0;
    let mx = d0.x + d1.x;
    let mz = d0.z + d1.z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    // Right of direction (x, z) is (-z, x); scale so the offset stays constant at the joint.
    const cos = Math.max(0.5, mx * d1.x + mz * d1.z);
    out.push({ x: p.pts[i].x - (mz * off) / cos, z: p.pts[i].z + (mx * off) / cos });
  }
  return makePath(out);
}

/** Andrew's monotone chain. */
export function convexHull(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function diameter(pts: Vec2[]): number {
  let d = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) d = Math.max(d, Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z));
  return d;
}

function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.z * b.z;
}

function unit(a: Vec2, b: Vec2): Vec2 {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}

function pathLength(pts: Vec2[]): number {
  return makePath(pts).len;
}

function dedupe(pts: Vec2[]): Vec2[] {
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.05);
}

function cellsOf(a: Vec2, b: Vec2): string[] {
  const out: string[] = [];
  for (let x = Math.floor(Math.min(a.x, b.x) / CELL); x <= Math.floor(Math.max(a.x, b.x) / CELL); x++)
    for (let z = Math.floor(Math.min(a.z, b.z) / CELL); z <= Math.floor(Math.max(a.z, b.z) / CELL); z++) out.push(`${x},${z}`);
  return out;
}

/**
 * Marks edges inside the largest strongly connected component (Tarjan, iterative). Roads that
 * leave the map (one-way exits) are joined to the ones that enter it through a virtual portal
 * node, because traffic leaving the map is recycled to an entry anyway.
 */
function markDrivable(nodes: GraphNode[], edges: LaneEdge[]): void {
  const portal = nodes.length;
  const out = nodes.map((n) => n.out.map((id) => edges[id].to));
  out.push(nodes.filter((n) => n.out.length && !n.in.length).map((n) => n.id));
  for (const n of nodes) if (n.in.length && !n.out.length) out[n.id].push(portal);
  const count = nodes.length + 1;
  const index = new Array(count).fill(-1);
  const low = new Array(count).fill(0);
  const onStack = new Array(count).fill(false);
  const comp = new Array(count).fill(-1);
  const stack: number[] = [];
  let idx = 0;
  let comps = 0;
  for (let s = 0; s < count; s++) {
    if (index[s] >= 0) continue;
    const work: [number, number][] = [[s, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const [v, k] = top;
      if (k === 0) {
        index[v] = low[v] = idx++;
        stack.push(v);
        onStack[v] = true;
      }
      if (k < out[v].length) {
        top[1]++;
        const w = out[v][k];
        if (index[w] < 0) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          comp[w] = comps;
        } while (w !== v);
        comps++;
      }
      work.pop();
      if (work.length) {
        const p = work[work.length - 1][0];
        low[p] = Math.min(low[p], low[v]);
      }
    }
  }
  const size = new Array(comps).fill(0);
  for (const c of comp) size[c]++;
  const biggest = size.indexOf(Math.max(...size));
  for (const e of edges) e.drivable = comp[e.from] === biggest && comp[e.to] === biggest;
}

export type { Road };
