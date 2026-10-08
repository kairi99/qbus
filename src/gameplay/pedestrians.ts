import { Rng } from '../core/rng';
import type { CityData, Road, Vec2 } from '../world/cityData';
import { forward, inPlayArea, right } from '../world/cityData';
import { pointInPolygon } from '../world/geom';
import { RoadIndex } from '../world/roadIndex';
import { type Path, type RoadGraph, edgeLift, makePath, offsetPath, pointAt } from '../world/roadGraph';
import { LIFTED } from '../world/elevation';
import type { TrafficLights } from './trafficLights';

/** An open cut's edge reaches this far past its asphalt (shoulder, retaining wall, a little more). */
const CUT_EDGE = 1.4;

export interface BusState {
  pos: Vec2;
  heading: number;
  /** Signed forward speed, m/s. */
  speed: number;
}

type Mode = 'walk' | 'wait' | 'corner' | 'cross' | 'dive' | 'recover' | 'return';

export interface Pedestrian {
  id: number;
  pos: Vec2;
  heading: number;
  speed: number;
  mode: Mode;
  /** On the asphalt (cars should yield). */
  onRoad: boolean;
  /** 0..1, picks clothing colors. */
  look: number;
  /** Visual: hop height and sideways lean during a dive. */
  hop: number;
  lean: number;
  strip: number;
  /** Distance along the strip. */
  s: number;
  dir: 1 | -1;
  /** Where corner/cross/return walks head. */
  target: Vec2 | null;
  /** What to do on arrival (or after a dive): continue on a strip, or resume a crossing. */
  then: { strip: number; s: number; dir: 1 | -1; resumeCross: Vec2 | null } | null;
  timer: number;
  diveFrom: Vec2 | null;
  /** Waiting at a lit crossing: the approach whose red lets us walk. */
  gate: number;
}

/** One side of one road piece. */
interface Strip {
  path: Path;
  /** Endpoint ids at the start and end of the path. */
  ends: [number, number];
}

/** Where a strip meets a node. */
interface Endpoint {
  strip: number;
  atEnd: boolean;
  pos: Vec2;
  /** Nearest end reachable without touching asphalt (round a corner). -1 if none. */
  corner: number;
  /** Nearest end across the road, near junctions only (a zebra crossing). -1 if none. */
  cross: number;
  /** That crossing is over an approach of a junction with lights: walk only while it's red. -1 if none. */
  gate: number;
}

const WALK_SPEED: [number, number] = [1.1, 1.6];
const RUN_SPEED = 3.6;
const CROSS_CHANCE = 0.35;
const DIVE_TIME = 0.32;
const DIVE_DIST = 3.2;
const RECOVER_TIME = 0.9;
const THREAT_MIN_SPEED = 4;
/** Seconds of warning before the bus nose arrives: late on purpose, for comedy. */
const REACTION_TIME = 0.45;
const BUS_NOSE = 5.5;
/** Walkers farther than this from the bus are moved closer. */
export const PED_RECYCLE_RADIUS = 160;
const PED_SPAWN_MIN = 50;

/**
 * Sidewalk life on any road layout: people walk along both sides of every road, turn corners,
 * cross at junctions (where the zebra crossings are; at lights, on the cars' red), and dive out of the way of a bus coming
 * at them. They have no colliders on purpose.
 */
export class PedestrianSim {
  peds: Pedestrian[] = [];
  private strips: Strip[] = [];
  private ends: Endpoint[] = [];
  private rng: Rng;
  private roadsIdx!: RoadIndex;
  private lights: TrafficLights | null;
  /** Seconds simulated: the traffic lights' clock (kept in step with the traffic's). */
  time = 0;

  constructor(
    private city: CityData,
    graph: RoadGraph,
    opts: { seed: number; count: number; lights?: TrafficLights },
  ) {
    this.rng = new Rng(opts.seed);
    this.lights = opts.lights ?? null;
    // Generated cities have wide sidewalk slabs; real ones put people nearer the curb.
    const walkOffset = city.blocks.length ? 1.8 : 1.1;
    this.roadsIdx = new RoadIndex(city.roads);
    const idx = this.roadsIdx;
    // Down in a cut (or on its wall) unless on a street-level road's asphalt (one over a tunnel).
    const cuts = new RoadIndex(pieces(city.roads, (l) => l < -LIFTED));
    const level = new RoadIndex(pieces(city.roads, (l) => Math.abs(l) <= LIFTED));
    const inCut = (q: Vec2) => cuts.onAsphalt(q, CUT_EDGE) && !level.onAsphalt(q);
    const overCut = (a: Vec2, b: Vec2) => {
      const n = Math.max(2, Math.ceil(dist(a, b) / 0.7));
      for (let i = 0; i <= n; i++) if (inCut({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n })) return true;
      return false;
    };
    // Sidewalk lines along both sides of every road piece, cut wherever they'd run over asphalt
    // (other roads at junctions, the far carriageway of divided avenues).
    for (const e of graph.edges) {
      if (e.reverse >= 0 && e.reverse < e.id) continue; // one pair per piece
      for (const side of [1, -1]) {
        const line = offsetPath(e.center, side * (e.roadWidth / 2 + walkOffset));
        let run: Vec2[] = [];
        const flush = () => {
          if (run.length >= 2 && makePath(run).len > 2) this.addStrip(makePath(run));
          run = [];
        };
        for (let d = 0; d <= line.len; d += 1) {
          const q = pointAt(line, Math.min(d, line.len));
          // Nobody walks past the roadworks at the map edge, or along ramps, bridges and underpasses.
          // Nor along the edge of a cut beside them.
          if (idx.onAsphalt(q, 0.3) || !inPlayArea(city, q, 2) || Math.abs(edgeLift(e, Math.min(d, e.len))) > LIFTED || inCut(q)) flush();
          else run.push(q);
        }
        const last = pointAt(line, line.len);
        if (!idx.onAsphalt(last, 0.3) && inPlayArea(city, last, 2) && !inCut(last)) run.push(last);
        flush();
      }
    }
    // Link strip ends: to the nearest end reachable without touching asphalt (round a corner),
    // and, near junctions, to the nearest end straight across the road (a zebra crossing).
    const nearJunction = (q: Vec2) => graph.nodes.some((n) => n.junction && dist(n.pos, q) < 25);
    const hash = new Map<string, number[]>();
    const key = (q: Vec2) => `${Math.floor(q.x / 15)},${Math.floor(q.z / 15)}`;
    this.ends.forEach((e, i) => hash.set(key(e.pos), [...(hash.get(key(e.pos)) ?? []), i]));
    const around = (q: Vec2) => {
      const out: number[] = [];
      const cx = Math.floor(q.x / 15);
      const cz = Math.floor(q.z / 15);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) out.push(...(hash.get(`${cx + dx},${cz + dz}`) ?? []));
      return out;
    };
    this.ends.forEach((e, i) => {
      const cands = around(e.pos)
        .filter((j) => this.ends[j].strip !== e.strip)
        .sort((a, b) => dist(this.ends[a].pos, e.pos) - dist(this.ends[b].pos, e.pos));
      e.corner = cands.find((j) => dist(this.ends[j].pos, e.pos) < 14 && idx.lineClear(e.pos, this.ends[j].pos) && !overCut(e.pos, this.ends[j].pos)) ?? -1;
      if (nearJunction(e.pos)) {
        e.cross = cands.find((j) => j !== e.corner && dist(this.ends[j].pos, e.pos) < 28 && !idx.lineClear(e.pos, this.ends[j].pos) && !overCut(e.pos, this.ends[j].pos)) ?? -1;
      }
      if (e.cross >= 0) e.gate = this.gateOf(e.pos, this.ends[e.cross].pos);
    });

    for (let i = 0; i < opts.count; i++) {
      const strip = this.rng.int(0, this.strips.length - 1);
      const s = this.rng.range(0, this.strips[strip].path.len);
      this.peds.push({
        id: i,
        pos: pointAt(this.strips[strip].path, s),
        heading: 0,
        speed: this.rng.range(...WALK_SPEED),
        mode: 'walk',
        onRoad: false,
        look: this.rng.next(),
        hop: 0,
        lean: 0,
        strip,
        s,
        dir: this.rng.chance(0.5) ? 1 : -1,
        target: null,
        then: null,
        timer: 0,
        diveFrom: null,
        gate: -1,
      });
    }
  }

  step(dt: number, bus: BusState): { dives: number } {
    let dives = 0;
    this.time += dt;
    for (const p of this.peds) {
      if (p.mode !== 'dive' && p.mode !== 'recover' && this.threatened(p, bus)) {
        this.startDive(p, bus);
        dives++;
      }
      switch (p.mode) {
        case 'walk':
          this.walk(p, dt);
          break;
        case 'wait':
          // At the curb until the cars crossing our way get their red.
          if (this.lights?.state(p.gate, this.time) === 'red') p.mode = 'cross';
          break;
        case 'corner':
        case 'cross':
        case 'return':
          if (this.moveTo(p, p.target!, dt)) this.arrive(p);
          break;
        case 'dive': {
          p.timer += dt;
          const k = Math.min(1, p.timer / DIVE_TIME);
          p.pos = { x: p.diveFrom!.x + (p.target!.x - p.diveFrom!.x) * k, z: p.diveFrom!.z + (p.target!.z - p.diveFrom!.z) * k };
          p.hop = Math.sin(k * Math.PI) * 0.7;
          p.lean = Math.sin(k * Math.PI) * 1.2;
          if (k >= 1) (p.mode = 'recover'), (p.timer = 0), (p.hop = 0);
          break;
        }
        case 'recover':
          p.timer += dt;
          p.lean = Math.max(0, p.lean - dt * 3);
          if (p.timer > RECOVER_TIME) {
            // Head back to the sidewalk spot we left, or on across the road.
            const t = p.then!;
            p.mode = t.resumeCross ? 'cross' : 'return';
            p.target = t.resumeCross ?? pointAt(this.strips[t.strip].path, t.s);
            p.speed = RUN_SPEED * 0.6;
          }
          break;
      }
      p.onRoad = p.mode === 'cross' || ((p.mode === 'dive' || p.mode === 'recover' || p.mode === 'return') && this.onAsphalt(p.pos));
    }
    return { dives };
  }

  private addStrip(path: Path): void {
    const id = this.strips.length;
    const start = this.ends.push({ strip: id, atEnd: false, pos: path.pts[0], corner: -1, cross: -1, gate: -1 }) - 1;
    const end = this.ends.push({ strip: id, atEnd: true, pos: path.pts[path.pts.length - 1], corner: -1, cross: -1, gate: -1 }) - 1;
    this.strips.push({ path, ends: [start, end] });
  }

  /** Moves walkers that fell out of the bubble around the bus onto nearby sidewalks, out of sight. */
  recycle(focus: { pos: Vec2; heading: number }, fill = false): void {
    const f = forward(focus.heading);
    const near = this.strips
      .map((st, i) => ({ i, mid: pointAt(st.path, st.path.len / 2) }))
      .filter((c) => dist(c.mid, focus.pos) < PED_RECYCLE_RADIUS - 20);
    if (!near.length) return;
    for (const p of this.peds) {
      if (!fill && dist(p.pos, focus.pos) < PED_RECYCLE_RADIUS) continue;
      for (let attempt = 0; attempt < 30; attempt++) {
        const c = this.rng.pick(near);
        const path = this.strips[c.i].path;
        const s = this.rng.range(0, path.len);
        const q = pointAt(path, s);
        const rel = { x: q.x - focus.pos.x, z: q.z - focus.pos.z };
        const d = Math.hypot(rel.x, rel.z);
        const hidden = d > 100 || rel.x * f.x + rel.z * f.z < 0;
        if (d > PED_RECYCLE_RADIUS - 5 || (!fill && (!hidden || d < PED_SPAWN_MIN))) continue;
        Object.assign(p, { strip: c.i, s, pos: q, mode: 'walk', target: null, then: null, hop: 0, lean: 0, onRoad: false });
        break;
      }
    }
  }

  /** Honked at: anyone near `pos` on the road runs. */
  honk(pos: Vec2): void {
    for (const p of this.peds) if (p.mode === 'cross' && dist(p.pos, pos) < 35) p.speed = Math.max(p.speed, RUN_SPEED);
  }

  private walk(p: Pedestrian, dt: number): void {
    const path = this.strips[p.strip].path;
    const before = p.pos;
    p.s += p.dir * p.speed * dt;
    const atEnd = p.s >= path.len;
    if (atEnd || p.s <= 0) {
      p.s = atEnd ? path.len : 0;
      p.pos = pointAt(path, p.s);
      this.atStripEnd(p, this.strips[p.strip].ends[atEnd ? 1 : 0]);
      return;
    }
    p.pos = pointAt(path, p.s);
    p.heading = Math.atan2(-(p.pos.z - before.z), p.pos.x - before.x);
  }

  /** At the end of a sidewalk: cross the road here (at junctions), or walk round the corner. */
  private atStripEnd(p: Pedestrian, endId: number): void {
    const e = this.ends[endId];
    const crossing = e.cross >= 0 && (e.corner < 0 || this.rng.chance(CROSS_CHANCE));
    const toId = crossing ? e.cross : e.corner;
    if (toId < 0) {
      p.dir = p.dir > 0 ? -1 : 1; // dead end: turn around
      return;
    }
    const to = this.ends[toId];
    const len = this.strips[to.strip].path.len;
    p.mode = crossing ? 'cross' : 'corner';
    p.target = to.pos;
    p.then = { strip: to.strip, s: to.atEnd ? len : 0, dir: to.atEnd ? -1 : 1, resumeCross: null };
    // Lights: wait for the walk phase (`timer` holds the edge whose red lets us go).
    if (crossing && e.gate >= 0 && this.lights?.state(e.gate, this.time) !== 'red') (p.mode = 'wait'), (p.gate = e.gate);
  }

  private arrive(p: Pedestrian): void {
    const t = p.then!;
    p.mode = 'walk';
    p.strip = t.strip;
    p.s = t.s;
    p.dir = t.dir;
    p.target = null;
    p.then = null;
    p.speed = this.rng.range(...WALK_SPEED);
  }

  /** Steps toward `to`; true on arrival. */
  private moveTo(p: Pedestrian, to: Vec2, dt: number): boolean {
    const dx = to.x - p.pos.x;
    const dz = to.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    const step = p.speed * dt;
    if (d <= step) {
      p.pos = { ...to };
      return true;
    }
    p.pos = { x: p.pos.x + (dx / d) * step, z: p.pos.z + (dz / d) * step };
    p.heading = Math.atan2(-dz, dx);
    return false;
  }

  private threatened(p: Pedestrian, bus: BusState): boolean {
    if (Math.abs(bus.speed) < THREAT_MIN_SPEED) return false;
    const f = forward(bus.heading);
    const rel = { x: p.pos.x - bus.pos.x, z: p.pos.z - bus.pos.z };
    const ahead = (rel.x * f.x + rel.z * f.z) * Math.sign(bus.speed);
    const lateral = Math.abs(rel.x * f.z - rel.z * f.x);
    return ahead > -2 && ahead < BUS_NOSE + 0.5 + Math.abs(bus.speed) * REACTION_TIME && lateral < 2.4;
  }

  private startDive(p: Pedestrian, bus: BusState): void {
    const r = right(bus.heading);
    const rel = { x: p.pos.x - bus.pos.x, z: p.pos.z - bus.pos.z };
    let side = Math.sign(rel.x * r.x + rel.z * r.z) || (this.rng.chance(0.5) ? 1 : -1);
    const land = (s: number, d: number) => ({ x: p.pos.x + r.x * s * d, z: p.pos.z + r.z * s * d });
    const blocked = (q: Vec2) => this.city.buildings.some((b) => pointInPolygon(q, b.footprint));
    let d = DIVE_DIST;
    if (blocked(land(side, d))) side = -side;
    while (d > 0.8 && blocked(land(side, d))) d -= 0.4;
    // Remember where to pick up afterwards.
    if (p.mode === 'walk') p.then = { strip: p.strip, s: p.s, dir: p.dir, resumeCross: null };
    // Waiting at the lights: a fright like that, and we cross whatever the light says.
    else if (p.mode === 'cross' || p.mode === 'wait') p.then = { ...p.then!, resumeCross: p.target };
    // corner / return: `then` already holds the strip to continue on.
    p.diveFrom = { ...p.pos };
    p.target = land(side, d);
    p.mode = 'dive';
    p.timer = 0;
  }

  /**
   * The approach of a lit junction that a crossing from `a` to `b` walks across (by its zebra,
   * just past the stop line), as an edge id; -1 if none.
   */
  private gateOf(a: Vec2, b: Vec2): number {
    if (!this.lights) return -1;
    const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    for (const j of this.lights.junctions) {
      if (dist(j.pos, m) > 45) continue;
      for (const ap of j.approaches) {
        const rel = { x: m.x - ap.line.x, z: m.z - ap.line.z };
        const along = rel.x * ap.dir.x + rel.z * ap.dir.z;
        const across = Math.abs(rel.x * ap.dir.z - rel.z * ap.dir.x);
        // Walking across the road (not along it), over its zebra.
        const walk = { x: (b.x - a.x) / (dist(a, b) || 1), z: (b.z - a.z) / (dist(a, b) || 1) };
        if (along > -2 && along < 6 && across < ap.halfWidth + 3 && Math.abs(walk.x * ap.dir.x + walk.z * ap.dir.z) < 0.5) return ap.edge;
      }
    }
    return -1;
  }

  private onAsphalt(q: Vec2): boolean {
    return this.roadsIdx.onAsphalt(q);
  }
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/** The stretches of `roads` whose lift passes `keep` (roads without one have lift 0), as roads. */
function pieces(roads: Road[], keep: (lift: number) => boolean): Road[] {
  const out: Road[] = [];
  for (const r of roads) {
    let run: Vec2[] = [];
    const flush = () => {
      if (run.length >= 2) out.push({ ...r, points: run, lift: undefined });
      run = [];
    };
    for (let i = 0; i < r.points.length - 1; i++) {
      const mid = r.lift ? (r.lift[i] + r.lift[i + 1]) / 2 : 0;
      if (!keep(mid)) {
        flush();
        continue;
      }
      if (!run.length) run.push(r.points[i]);
      run.push(r.points[i + 1]);
    }
    flush();
  }
  return out;
}
