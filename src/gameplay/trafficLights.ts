import type { TrafficSignal, Vec2 } from '../world/cityData';
import { forward } from '../world/cityData';
import { distToPolyline, pointInPolygon } from '../world/geom';
import { type RoadGraph, edgeDir, edgeLift, pointAt } from '../world/roadGraph';

export type LightState = 'green' | 'amber' | 'red';

/** Seconds of green per phase at a crossing of two roads, and at one with three or more directions. */
export const GREEN = 14;
export const GREEN_MANY = 10;
export const AMBER = 3;
/** Everyone red between two phases, so the junction clears. */
export const ALL_RED = 2;
/** The stop line is this far before the end of an approach (behind its zebra crossing). */
export const STOP_BACK = 4;
/** A signal this far outside a junction's paved area (on an approach, at its stop line) still belongs to it. */
const ATTACH = 15;
/** Signalized junctions closer than this run in step (the two crossings of a divided avenue). */
const COORDINATE = 60;
/** Approaches whose axes are within this angle share a phase (opposite approaches go together). */
const SAME_AXIS = (35 * Math.PI) / 180;
/** Lifts further apart than this are different levels (a bridge, an underpass). */
const LEVEL = 2;

/** One incoming edge of a signalized junction, and its stop line. */
export interface Approach {
  edge: number;
  phase: number;
  /** Middle of the road at the stop line, and the direction of travel there. */
  line: Vec2;
  dir: Vec2;
  /** Distance along the edge of the stop line. */
  s: number;
  halfWidth: number;
  lift: number;
}

export interface SignalJunction {
  node: number;
  pos: Vec2;
  lift: number;
  /** Phases in the order they get green; each lets its approaches in. */
  phases: number;
  approaches: Approach[];
  green: number;
  cycle: number;
  /** Seconds into the cycle at time 0. */
  offset: number;
}

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.z * b.z;
/** Direction of travel as an axis: opposite directions map to the same vector. */
const axisOf = (d: Vec2): Vec2 => ({ x: d.x * d.x - d.z * d.z, z: 2 * d.x * d.z });
const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Traffic lights at the signalized junctions of a road graph, engine-agnostic. A junction is
 * signalized when a signal of the city (at its level) is on its paved area or a few meters out
 * along an approach. Its incoming edges are grouped into phases by approach axis (opposite
 * approaches share one); phases take turns: green, amber, then all red while the junction
 * clears. Everything is a pure function of the session clock. Junctions close together (a
 * divided avenue's two crossings) share their timing, and give the widest road the first phase,
 * so nobody is stopped again halfway across; elsewhere each junction has its own offset.
 */
export class TrafficLights {
  readonly junctions: SignalJunction[] = [];
  /** Per edge: index of the junction it's an approach of (-1 if none) and that approach. */
  private junctionOf: Int32Array;
  private approachOf: (Approach | null)[];

  constructor(
    private graph: RoadGraph,
    signals: TrafficSignal[],
  ) {
    this.junctionOf = new Int32Array(graph.edges.length).fill(-1);
    this.approachOf = graph.edges.map(() => null);
    // Each signal belongs to the nearest junction at its level, if close enough.
    const lit = new Set<number>();
    const candidates = graph.nodes.filter((n) => n.junction && n.hull && n.in.length);
    for (const sig of signals) {
      let best: number | null = null;
      let bestD = ATTACH;
      for (const n of candidates) {
        if (Math.abs((sig.lift ?? 0) - n.lift) >= LEVEL || Math.hypot(n.pos.x - sig.pos.x, n.pos.z - sig.pos.z) > ATTACH + 40) continue;
        const d = pointInPolygon(sig.pos, n.hull!) ? 0 : distToPolyline(sig.pos, [...n.hull!, n.hull![0]]);
        if (d <= bestD) (bestD = d), (best = n.id);
      }
      if (best !== null) lit.add(best);
    }

    // Approaches grouped by axis.
    const groups = new Map<number, { edge: number; axis: Vec2 }[][]>();
    for (const id of [...lit].sort((a, b) => a - b)) {
      const phases: { edge: number; axis: Vec2 }[][] = [];
      for (const e of graph.nodes[id].in) {
        const axis = axisOf(graph.edges[e].endDir);
        const same = phases.find((p) => dot(p[0].axis, axis) > Math.cos(2 * SAME_AXIS));
        if (same) same.push({ edge: e, axis });
        else phases.push([{ edge: e, axis }]);
      }
      // A light that never stops anyone else is no light: everyone comes from one direction.
      if (phases.length >= 2) groups.set(id, phases);
    }

    // Junctions close together run in step; the widest road through them goes first.
    const ids = [...groups.keys()];
    const parent = new Map(ids.map((i) => [i, i]));
    const find = (i: number): number => (parent.get(i) === i ? i : find(parent.get(i)!));
    for (const a of ids)
      for (const b of ids) {
        const pa = graph.nodes[a].pos;
        const pb = graph.nodes[b].pos;
        if (a < b && Math.hypot(pa.x - pb.x, pa.z - pb.z) < COORDINATE) parent.set(find(b), find(a));
      }
    const reference = new Map<number, { axis: Vec2; width: number }>();
    for (const id of ids)
      for (const p of groups.get(id)!)
        for (const { edge, axis } of p) {
          const root = find(id);
          const w = graph.edges[edge].roadWidth;
          if (w > (reference.get(root)?.width ?? -1)) reference.set(root, { axis, width: w });
        }

    for (const id of ids) {
      const node = graph.nodes[id];
      const root = find(id);
      const ref = reference.get(root)!.axis;
      const phases = groups.get(id)!.sort((a, b) => dot(b[0].axis, ref) - dot(a[0].axis, ref));
      const green = phases.length > 2 ? GREEN_MANY : GREEN;
      const cycle = phases.length * (green + AMBER + ALL_RED);
      const root0 = graph.nodes[root].pos;
      const junction: SignalJunction = {
        node: id,
        pos: node.pos,
        lift: node.lift,
        phases: phases.length,
        approaches: [],
        green,
        cycle,
        offset: hash(root0.x, root0.z) * cycle,
      };
      phases.forEach((p, k) =>
        p.forEach(({ edge }) => {
          const e = graph.edges[edge];
          const s = Math.max(0, e.len - Math.min(STOP_BACK, e.len * 0.4));
          const a: Approach = { edge, phase: k, line: pointAt(e.center, s), dir: edgeDir(e, s), s, halfWidth: e.roadWidth / 2, lift: edgeLift(e, s) };
          junction.approaches.push(a);
          this.junctionOf[edge] = this.junctions.length;
          this.approachOf[edge] = a;
        }),
      );
      this.junctions.push(junction);
    }
  }

  /** The light facing traffic on `edge` at time `t`; null where there's none. */
  state(edge: number, t: number): LightState | null {
    const j = this.junctionOf[edge];
    if (j < 0) return null;
    const J = this.junctions[j];
    const local = mod(t + J.offset, J.cycle) - this.approachOf[edge]!.phase * (J.green + AMBER + ALL_RED);
    if (local < 0) return 'red';
    return local < J.green ? 'green' : local < J.green + AMBER ? 'amber' : 'red';
  }

  /** The approach (stop line) of a signalized junction that `edge` leads into, or null. */
  approach(edge: number): Approach | null {
    return this.approachOf[edge];
  }

  /** Index of the junction `edge` leads into (in `junctions`), or -1. */
  junctionIndex(edge: number): number {
    return this.junctionOf[edge];
  }

  /** Which cycle of junction `j` is running at time `t` (counts up by one each cycle). */
  cycleOf(j: number, t: number): number {
    const J = this.junctions[j];
    return Math.floor((t + J.offset) / J.cycle);
  }
}

/** Moving more than this in one step is a reset (R), not driving. */
const JUMP = 8;

/**
 * Notices the bus running a red: its front bumper crossing a stop line into the junction, at the
 * light's level, while that approach is red (amber is fair game; already in the box when it
 * turned red doesn't count). Each junction pays once per cycle (no rocking over the line).
 */
export class RedLightRunner {
  private last: Vec2 | null = null;
  private paid = new Map<number, number>();

  constructor(private lights: TrafficLights) {}

  /** The bus's front bumper is at `front` and `lift` off the ground: junctions whose red it just ran. */
  update(front: Vec2, heading: number, lift: number, t: number): number[] {
    const last = this.last;
    this.last = { x: front.x, z: front.z };
    if (!last || Math.hypot(front.x - last.x, front.z - last.z) > JUMP) return [];
    const out: number[] = [];
    const f = forward(heading);
    this.lights.junctions.forEach((J, j) => {
      if (Math.abs(J.pos.x - front.x) > 60 || Math.abs(J.pos.z - front.z) > 60) return;
      for (const a of J.approaches) {
        const before = (last.x - a.line.x) * a.dir.x + (last.z - a.line.z) * a.dir.z;
        const after = (front.x - a.line.x) * a.dir.x + (front.z - a.line.z) * a.dir.z;
        if (before >= 0 || after < 0) continue;
        if (Math.abs((front.x - a.line.x) * a.dir.z - (front.z - a.line.z) * a.dir.x) > a.halfWidth + 0.5) continue;
        if (dot(f, a.dir) < 0.5 || Math.abs(lift - a.lift) >= LEVEL) continue;
        if (this.lights.state(a.edge, t) !== 'red') continue;
        const cycle = this.lights.cycleOf(j, t);
        if (this.paid.get(j) === cycle) continue;
        this.paid.set(j, cycle);
        out.push(j);
      }
    });
    return out;
  }
}

/** 0..1 from a position: deterministic, no RNG. */
function hash(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
