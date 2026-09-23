import type { Vec2 } from '../world/cityData';
import { type RoadGraph, dirAt, lanePoint, projectOnPath } from '../world/roadGraph';

/** A spot on the lane graph: an edge and a distance along it. */
export interface GraphSpot {
  edge: number;
  s: number;
}

/** A legal driving path: edges in order, and a polyline along their curb lanes. */
export interface NavPath {
  edges: number[];
  points: Vec2[];
  length: number;
}

const SEARCH = 40;
const POINT_STEP = 6;

/**
 * Turn-by-turn routing on the directed lane graph, so the player is guided along one-way
 * streets the right way (like a GPS) instead of straight at the target.
 */
export class Navigator {
  constructor(private graph: RoadGraph) {}

  /**
   * Nearest drivable edge to `p` whose direction agrees with `heading`; if none is close,
   * the nearest drivable edge regardless (the bus may be going the wrong way down a one-way).
   */
  locate(p: Vec2, heading: number): GraphSpot | null {
    const fx = Math.cos(heading);
    const fz = -Math.sin(heading);
    let best: (GraphSpot & { d: number }) | null = null;
    let any: (GraphSpot & { d: number }) | null = null;
    for (const e of this.graph.edges) {
      if (!e.drivable) continue;
      const { s, d } = projectOnPath(e.center, p);
      if (d > SEARCH) continue;
      if (!any || d < any.d) any = { edge: e.id, s, d };
      const dir = dirAt(e.center, s);
      if (dir.x * fx + dir.z * fz < 0.3) continue;
      if (!best || d < best.d) best = { edge: e.id, s, d };
    }
    const pick = best && (!any || best.d < any.d + 12) ? best : any;
    return pick ? { edge: pick.edge, s: pick.s } : null;
  }

  /** Shortest legal path from one spot to another (Dijkstra over edges). */
  route(from: GraphSpot, to: GraphSpot): NavPath | null {
    if (from.edge === to.edge && to.s >= from.s) return this.build([from.edge], from.s, to.s);
    const { dist, prev } = this.search(from, to.edge);
    if (!dist.has(to.edge)) return null;
    // Walk back from the target (which may be our own edge again, after a loop).
    const chain = [to.edge];
    let cur = to.edge;
    do {
      cur = prev.get(cur)!;
      chain.unshift(cur);
    } while (cur !== from.edge);
    return this.build(chain, from.s, to.s);
  }

  /** Legal driving distance from a spot to every reachable spot's edge start (for route building). */
  distanceTo(from: GraphSpot, to: GraphSpot): number {
    if (from.edge === to.edge && to.s >= from.s) return to.s - from.s;
    const d = this.search(from, to.edge).dist.get(to.edge);
    return d === undefined ? Infinity : d + to.s;
  }

  /** Distances from `from` to the start of every reachable edge. */
  distances(from: GraphSpot): Map<number, number> {
    return this.search(from, -1).dist;
  }

  private search(from: GraphSpot, stopAt: number): { dist: Map<number, number>; prev: Map<number, number> } {
    const edges = this.graph.edges;
    const dist = new Map<number, number>();
    const prev = new Map<number, number>();
    const heap = new MinHeap();
    const gap = (a: number, b: number) => Math.hypot(edges[b].a.x - edges[a].b.x, edges[b].a.z - edges[a].b.z);
    const relax = (id: number, d: number, p: number) => {
      if (d >= (dist.get(id) ?? Infinity)) return;
      dist.set(id, d);
      prev.set(id, p);
      heap.push(d, id);
    };
    const start = edges[from.edge];
    for (const id of this.graph.nodes[start.to].out) if (edges[id].drivable) relax(id, start.len - from.s + gap(from.edge, id), from.edge);
    while (heap.size) {
      const [d, id] = heap.pop();
      if (d > (dist.get(id) ?? Infinity)) continue;
      if (id === stopAt) break;
      const e = edges[id];
      for (const nx of this.graph.nodes[e.to].out) if (edges[nx].drivable) relax(nx, d + e.len + gap(id, nx), id);
    }
    return { dist, prev };
  }

  /** The point `ahead` meters along the path past where `p` projects onto it. */
  guidePoint(path: NavPath, p: Vec2, ahead: number): Vec2 {
    const pts = path.points;
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - p.x, pts[i].z - p.z);
      if (d < bestD) (bestD = d), (bestI = i);
    }
    let left = ahead;
    for (let i = bestI; i < pts.length - 1; i++) {
      const seg = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
      if (seg >= left) {
        const t = left / seg;
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t };
      }
      left -= seg;
    }
    return pts[pts.length - 1];
  }

  private build(chain: number[], s0: number, s1: number): NavPath {
    const points: Vec2[] = [];
    let length = 0;
    chain.forEach((id, i) => {
      const e = this.graph.edges[id];
      const a = i === 0 ? s0 : 0;
      const b = i === chain.length - 1 ? s1 : e.len;
      for (let s = a; s < b; s += POINT_STEP) points.push(lanePoint(e, s, 0));
      points.push(lanePoint(e, b, 0));
      length += Math.max(0, b - a);
      if (i < chain.length - 1) {
        const n = this.graph.edges[chain[i + 1]];
        length += Math.hypot(n.a.x - e.b.x, n.a.z - e.b.z);
      }
    });
    return { edges: chain, points, length };
  }
}

/** Binary min-heap of [priority, value]. */
class MinHeap {
  private a: [number, number][] = [];

  get size(): number {
    return this.a.length;
  }

  push(p: number, v: number): void {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (a[up][0] <= a[i][0]) break;
      [a[up], a[i]] = [a[i], a[up]];
      i = up;
    }
  }

  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
