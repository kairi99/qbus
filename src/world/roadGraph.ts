import type { CityData, Vec2 } from './cityData';
import { right } from './cityData';
import { segmentIntersection } from './geom';

export interface GraphNode {
  id: number;
  pos: Vec2;
  /** Outgoing directed edge ids. */
  out: number[];
  /** Half-width of the widest road through this node: the size of the intersection box. */
  radius: number;
}

/** One direction of travel along a straight road piece between two nodes. */
export interface LaneEdge {
  id: number;
  from: number;
  to: number;
  /** Centerline start/end, trimmed back from the intersection boxes. */
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  heading: number;
  len: number;
  /** Lanes in this direction. Lane 0 is next to the curb. */
  lanes: number;
  laneWidth: number;
  roadWidth: number;
  reverse: number;
  road: string;
}

export interface RoadGraph {
  nodes: GraphNode[];
  edges: LaneEdge[];
}

const MERGE = 1;
const MIN_EDGE = 4;

/** Directed lane graph: nodes at crossings, bends and road ends; two edges per road piece. */
export function buildRoadGraph(city: CityData): RoadGraph {
  const nodes: GraphNode[] = [];
  const nodeAt = (p: Vec2, halfWidth: number): number => {
    let n = nodes.find((n) => Math.hypot(n.pos.x - p.x, n.pos.z - p.z) < MERGE);
    if (!n) nodes.push((n = { id: nodes.length, pos: { ...p }, out: [], radius: 0 }));
    n.radius = Math.max(n.radius, halfWidth);
    return n.id;
  };

  // Split every road at its vertices and at crossings with other roads.
  const pieces: { from: number; to: number; roadIndex: number }[] = [];
  city.roads.forEach((r, ri) => {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const cuts: { t: number; id: number }[] = [
        { t: 0, id: nodeAt(a, r.width / 2) },
        { t: len, id: nodeAt(b, r.width / 2) },
      ];
      city.roads.forEach((o, oi) => {
        if (oi === ri) return;
        for (let j = 0; j < o.points.length - 1; j++) {
          const hit = segmentIntersection(a, b, o.points[j], o.points[j + 1]);
          if (!hit) continue;
          const id = nodeAt(hit, Math.max(r.width, o.width) / 2);
          cuts.push({ t: Math.hypot(hit.x - a.x, hit.z - a.z), id });
        }
      });
      cuts.sort((x, y) => x.t - y.t);
      for (let k = 0; k < cuts.length - 1; k++) {
        if (cuts[k].id !== cuts[k + 1].id) pieces.push({ from: cuts[k].id, to: cuts[k + 1].id, roadIndex: ri });
      }
    }
  });

  const edges: LaneEdge[] = [];
  for (const p of pieces) {
    const r = city.roads[p.roadIndex];
    const lanes = Math.max(1, Math.floor(r.lanes / 2));
    const make = (from: number, to: number): LaneEdge | null => {
      const A = nodes[from];
      const B = nodes[to];
      const full = Math.hypot(B.pos.x - A.pos.x, B.pos.z - A.pos.z);
      const dir = { x: (B.pos.x - A.pos.x) / full, z: (B.pos.z - A.pos.z) / full };
      const trimA = A.radius + 1;
      const trimB = B.radius + 1;
      const len = full - trimA - trimB;
      if (len < MIN_EDGE) return null;
      return {
        id: -1,
        from,
        to,
        a: { x: A.pos.x + dir.x * trimA, z: A.pos.z + dir.z * trimA },
        b: { x: B.pos.x - dir.x * trimB, z: B.pos.z - dir.z * trimB },
        dir,
        heading: Math.atan2(-dir.z, dir.x),
        len,
        lanes,
        laneWidth: r.width / (2 * lanes),
        roadWidth: r.width,
        reverse: -1,
        road: r.name,
      };
    };
    const fwd = make(p.from, p.to);
    const back = make(p.to, p.from);
    if (!fwd || !back) continue;
    fwd.id = edges.length;
    back.id = edges.length + 1;
    fwd.reverse = back.id;
    back.reverse = fwd.id;
    edges.push(fwd, back);
    nodes[fwd.from].out.push(fwd.id);
    nodes[back.from].out.push(back.id);
  }
  return { nodes, edges };
}

/** Distance from the centerline to the middle of lane `k` (0 = curb lane), to the right. */
export function laneOffset(e: LaneEdge, k: number): number {
  return e.roadWidth / 2 - e.laneWidth * (k + 0.5);
}

export function lanePoint(e: LaneEdge, s: number, k: number, offset = laneOffset(e, k)): Vec2 {
  const r = right(e.heading);
  return { x: e.a.x + e.dir.x * s + r.x * offset, z: e.a.z + e.dir.z * s + r.z * offset };
}
