import { Rng } from '../core/rng';
import type { CityData, Vec2 } from '../world/cityData';
import { forward, right } from '../world/cityData';
import { type LaneEdge, type RoadGraph, edgeDir, laneOffset, lanePoint, projectOnPath } from '../world/roadGraph';

export interface CarKind {
  name: 'sedan' | 'taxi' | 'buseta';
  length: number;
  width: number;
  height: number;
  mass: number;
  /** Cruising speed, m/s. */
  vmax: number;
  /** Relative spawn frequency. */
  weight: number;
}

export const CAR_KINDS: Record<CarKind['name'], CarKind> = {
  sedan: { name: 'sedan', length: 4.3, width: 1.8, height: 1.45, mass: 700, vmax: 12.5, weight: 0.5 },
  taxi: { name: 'taxi', length: 4.4, width: 1.8, height: 1.5, mass: 700, vmax: 14, weight: 0.35 },
  buseta: { name: 'buseta', length: 8.5, width: 2.3, height: 2.8, mass: 2600, vmax: 10.5, weight: 0.15 },
};

/** Something cars must not drive into: the player's bus, wrecked cars, people crossing. */
export interface Obstacle {
  id: string;
  pos: Vec2;
  heading: number;
  length: number;
  width: number;
}

export type TrafficEvent = { type: 'honk'; carId: number; pos: Vec2 };

/** Cars farther than this from the bus are moved closer; nobody drives around unseen. */
export const RECYCLE_RADIUS = 200;
/** New cars appear at least this far ahead (inside the fog)... */
export const SPAWN_HIDDEN_DIST = 115;
/** ...or behind the bus, at least this far back. */
export const SPAWN_BEHIND_DIST = 45;
const SPAWN_MAX_DIST = 180;

interface Turn {
  pts: Vec2[];
  cum: number[];
  len: number;
  t: number;
  node: number;
  speed: number;
}

export interface Car {
  id: number;
  kind: CarKind;
  /** 0..1, picks the paint color. */
  paint: number;
  /** driving: follows lanes. free: handed to physics (wrecked). parked: hidden by the budget. */
  state: 'driving' | 'free' | 'parked';
  pos: Vec2;
  heading: number;
  speed: number;
  edge: number;
  s: number;
  lane: number;
  /** Current lateral offset from the centerline (animates during lane changes). */
  offset: number;
  next: number;
  nextLane: number;
  turn: Turn | null;
  reserved: number | null;
  wait: number;
  blockedTime: number;
  honkCooldown: number;
  hurry: number;
  /** Obstacle id that limited our speed last step (for breaking mutual standoffs). */
  blocker: string | null;
  /** Bumped every time the car is placed somewhere new, so the physics body knows to snap. */
  generation: number;
}

const ACCEL = 3;
const DECEL = 6;
const MIN_GAP = 2;
const LOOKAHEAD = 45;
const PATH_STEP = 1;
/** Clearance kept around our path, beyond half our width. */
const PATH_MARGIN = 0.3;
const STRAIGHT_SPEED = 12;
const TURN_SPEED = 5.5;
const UTURN_SPEED = 3.5;
const HUMP_SPEED = 5;
const LANE_CHANGE_RATE = 2;
const PRIORITY_WAIT = 3;
/** A car stuck this long (a real jam) is recycled out of sight rather than forced through. */
const STUCK_WAIT = 25;
const EXIT_CLEAR = 9;

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.z * b.z;
const sameDir = (a: Vec2, b: Vec2) => dot(a, b) > 0.7;

/**
 * Lane-following traffic, engine-agnostic. Cars follow the road graph, keep a safe gap to
 * whatever is ahead (other cars, the bus, pedestrians), and share each intersection one
 * direction at a time. Poses here are targets; the physics layer chases them.
 */
export class TrafficSim {
  cars: Car[] = [];
  private rng: Rng;
  /** Per junction: cars inside it, where each came from and where it's going. */
  private occupants = new Map<number, Map<number, { from: number; lane: number; next: number; nextLane: number }>>();
  private priority = new Map<number, { car: number; edge: number }>();
  private humps: number[][];
  /** Where the bus was last seen; cars leaving the map re-enter out of its sight. */
  private focus: { pos: Vec2; heading: number } = { pos: { x: 0, z: 0 }, heading: 0 };

  constructor(
    private graph: RoadGraph,
    city: CityData,
    opts: { seed: number; count: number; avoid?: { pos: Vec2; radius: number } },
  ) {
    this.rng = new Rng(opts.seed);
    this.humps = graph.edges.map((e) =>
      city.features
        .filter((f) => f.kind === 'hump')
        .map((f) => projectOnPath(e.center, f.pos))
        .filter((pr) => pr.d < e.roadWidth / 2)
        .map((pr) => pr.s),
    );
    const kinds = Object.values(CAR_KINDS);
    for (let i = 0; i < opts.count; i++) {
      let r = this.rng.next() * kinds.reduce((s, k) => s + k.weight, 0);
      const kind = kinds.find((k) => (r -= k.weight) < 0) ?? kinds[0];
      const car: Car = {
        id: i,
        kind,
        paint: this.rng.next(),
        state: 'parked',
        pos: { x: 0, z: 0 },
        heading: 0,
        speed: 0,
        edge: 0,
        s: 0,
        lane: 0,
        offset: 0,
        next: 0,
        nextLane: 0,
        turn: null,
        reserved: null,
        wait: 0,
        blockedTime: 0,
        honkCooldown: 0,
        hurry: 0,
        blocker: null,
        generation: 0,
      };
      this.cars.push(car);
      this.place(car, opts.avoid?.pos ?? { x: 1e9, z: 1e9 }, opts.avoid?.radius ?? 0);
    }
  }

  step(dt: number, obstacles: Obstacle[]): TrafficEvent[] {
    const events: TrafficEvent[] = [];
    const driving = this.cars.filter((c) => c.state === 'driving');
    const others: Obstacle[] = [
      ...driving.map((c) => ({ id: `car${c.id}`, pos: c.pos, heading: c.heading, length: c.kind.length, width: c.kind.width })),
      ...obstacles,
    ];
    for (const car of driving) this.drive(car, dt, others, obstacles, events);
    return events;
  }

  /** The bus honked: cars ahead of it hurry up and stop waiting politely at junctions. */
  honk(pos: Vec2, heading: number): void {
    const f = forward(heading);
    for (const c of this.cars) {
      if (c.state !== 'driving') continue;
      const rel = { x: c.pos.x - pos.x, z: c.pos.z - pos.z };
      const ahead = dot(rel, f);
      if (ahead > 0 && ahead < 35 && Math.abs(dot(rel, right(heading))) < 8) c.hurry = 3;
    }
  }

  /** Hands a car over to physics (it got hit). */
  release(id: number): void {
    const c = this.cars[id];
    this.unreserve(c);
    c.state = 'free';
    c.speed = 0;
  }

  /** Puts a car back into traffic at least `radius` meters from `avoid`. */
  respawn(id: number, avoid: Vec2, radius: number): void {
    this.place(this.cars[id], avoid, radius);
  }

  /**
   * Moves driving cars that fell out of the bubble around the bus to hidden spots near it.
   * `fill` spreads them over the whole bubble instead (at startup, before anyone is looking).
   */
  recycle(focus: { pos: Vec2; heading: number }, fill = false): void {
    this.focus = focus;
    for (const c of this.cars) {
      if (c.state !== 'driving') continue;
      const d = Math.hypot(c.pos.x - focus.pos.x, c.pos.z - focus.pos.z);
      if (fill) this.place(c, focus.pos, 20, (p) => Math.hypot(p.x - focus.pos.x, p.z - focus.pos.z) < RECYCLE_RADIUS * 0.8);
      else if (d >= RECYCLE_RADIUS) this.place(c, focus.pos, 0, (p) => hiddenFrom(focus, p));
    }
  }

  /** Parks the cars farthest from the bus (or brings parked ones back) to hit `budget` drivers. */
  setBudget(budget: number, bus: Vec2, heading = 0): void {
    const driving = this.cars.filter((c) => c.state === 'driving');
    const far = (c: Car) => -Math.hypot(c.pos.x - bus.x, c.pos.z - bus.z);
    if (driving.length > budget) {
      driving.sort((a, b) => far(a) - far(b));
      for (const c of driving.slice(0, driving.length - budget)) {
        this.unreserve(c);
        c.state = 'parked';
      }
    } else {
      const parked = this.cars.filter((c) => c.state === 'parked');
      for (const c of parked.slice(0, budget - driving.length)) this.place(c, bus, 0, (p) => hiddenFrom({ pos: bus, heading }, p));
    }
  }

  private drive(car: Car, dt: number, others: Obstacle[], external: Obstacle[], events: TrafficEvent[]): void {
    if (car.wait > STUCK_WAIT || car.blockedTime > STUCK_WAIT) {
      this.place(car, this.focus.pos, 0, (p) => hiddenFrom(this.focus, p));
      return;
    }
    const e = this.graph.edges[car.edge];
    const vmax = car.kind.vmax * (car.hurry > 0 ? 1.15 : 1);
    car.hurry = Math.max(0, car.hurry - dt);
    car.honkCooldown = Math.max(0, car.honkCooldown - dt);

    // Whatever lies on the path we're about to drive (lane, turn curve, next lane).
    let vTarget = vmax;
    let blocker: string | null = null;
    const reach = Math.min(LOOKAHEAD, Math.max(14, (car.speed * car.speed) / (2 * DECEL) + 12));
    const path = this.futurePath(car, reach);
    const pad = car.kind.width / 2 + PATH_MARGIN;
    const self = `car${car.id}`;
    for (const o of others) {
      if (o.id === self) continue;
      if (Math.hypot(o.pos.x - car.pos.x, o.pos.z - car.pos.z) > reach + o.length) continue;
      // Standoff (both stopped, each waiting on the other): the lower id goes first.
      const other = o.id.startsWith('car') ? this.cars[+o.id.slice(3)] : null;
      const standoff = other && car.blocker === o.id && other.blocker === self && car.speed < 0.5 && other.speed < 0.5;
      if (standoff && car.id < other.id) continue;
      const of = forward(o.heading);
      const or = right(o.heading);
      for (const p of path) {
        const rel = { x: p.pos.x - o.pos.x, z: p.pos.z - o.pos.z };
        if (Math.abs(dot(rel, of)) > o.length / 2 + pad || Math.abs(dot(rel, or)) > o.width / 2 + pad) continue;
        const v = Math.sqrt(2 * DECEL * Math.max(0, p.d - car.kind.length / 2 - MIN_GAP));
        if (v < vTarget) {
          vTarget = v;
          blocker = o.id;
        }
        break;
      }
    }
    car.blocker = blocker;

    if (car.turn) {
      vTarget = Math.min(vTarget, car.turn.speed);
    } else {
      for (const hs of this.humps[e.id]) {
        const d = hs - car.s;
        if (d > -2 && d < 15) vTarget = Math.min(vTarget, HUMP_SPEED);
      }
      const remaining = e.len - car.s;
      const node = e.to;
      const exiting = car.next < 0;
      if (!exiting && this.graph.nodes[node].junction && car.reserved !== node) {
        const decide = Math.max(8, (car.speed * car.speed) / (2 * DECEL) + 4);
        if (remaining - car.kind.length / 2 < decide) {
          if (this.canEnter(car, e, external)) this.reserve(car, node, e.id);
          else {
            // Stop with the front bumper at the line, not the middle of the car.
            vTarget = Math.min(vTarget, Math.sqrt(2 * DECEL * Math.max(0, remaining - car.kind.length / 2 - 0.5)));
            if (car.speed < 0.5) car.wait += dt;
            if (car.wait > PRIORITY_WAIT && !this.priority.has(node)) this.priority.set(node, { car: car.id, edge: e.id });
          }
        }
      }
      if (!exiting) vTarget = Math.min(vTarget, Math.sqrt(this.turnSpeed(car) ** 2 + 2 * DECEL * remaining));

      // Stuck behind something that isn't moving on a multi-lane road: change lanes.
      if (e.lanes > 1 && blocker && car.speed < 1 && car.blockedTime > 2) {
        const other = car.lane === 0 ? 1 : car.lane - 1;
        const clear = this.cars.every(
          (c) => c === car || c.state !== 'driving' || c.edge !== e.id || c.lane !== other || Math.abs(c.s - car.s) > 12,
        );
        if (clear) {
          car.lane = other;
          this.chooseNext(car);
        }
      }
    }

    // Honk at the bus if it's in the way.
    if (blocker && car.speed < 1) {
      car.blockedTime += dt;
      if (blocker === 'bus' && car.blockedTime > 1.5 && car.honkCooldown <= 0) {
        car.honkCooldown = 5;
        events.push({ type: 'honk', carId: car.id, pos: { ...car.pos } });
      }
    } else car.blockedTime = 0;

    // Integrate speed and position.
    const dv = vTarget - car.speed;
    car.speed = Math.max(0, car.speed + Math.max(-DECEL * 2 * dt, Math.min(ACCEL * dt, dv)));
    const ds = car.speed * dt;

    if (car.turn) {
      car.turn.t += ds;
      if (car.turn.t >= car.turn.len) this.finishTurn(car, car.turn.t - car.turn.len);
      else {
        const [p, h] = sampleCurve(car.turn, car.turn.t);
        car.pos = p;
        car.heading = h;
        return;
      }
    } else {
      car.s += ds;
      if (car.s >= e.len) {
        // Driving off the map (or into the roadworks): come back somewhere near the bus, out of
        // sight. Nobody vanishes in plain view: until the player looks away, wait at the line.
        if (car.next < 0) {
          if (outOfSight(this.focus, car.pos)) this.place(car, this.focus.pos, 0, (p) => hiddenFrom(this.focus, p));
          else {
            car.s = e.len - 0.01;
            car.speed = 0;
            car.wait += dt;
          }
        }
        else if (this.graph.nodes[e.to].junction && car.reserved !== e.to && !this.canEnter(car, e, external)) {
          // Couldn't stop in time and the junction is busy: hold at the line.
          car.s = e.len - 0.01;
          car.speed = 0;
          car.wait += dt;
        } else this.startTurn(car, car.s - e.len);
        if (car.turn || car.s < e.len) return;
      }
    }
    const edge = this.graph.edges[car.edge];
    const target = laneOffset(edge, car.lane);
    const step = LANE_CHANGE_RATE * dt;
    const lateral = Math.max(-step, Math.min(step, target - car.offset));
    car.offset += lateral;
    // Settled in a lane: follow its mitered path; mid lane change: shift off the centerline.
    const settled = Math.abs(car.offset - target) < 1e-6;
    car.pos = settled ? lanePoint(edge, car.s, car.lane) : lanePoint(edge, car.s, car.lane, car.offset);
    const d = edgeDir(edge, car.s);
    car.heading = Math.atan2(-d.z, d.x) - (car.speed > 1 ? Math.atan2(lateral / dt, car.speed) : 0);
  }

  private turnSpeed(car: Car): number {
    const a = this.graph.edges[car.edge];
    if (car.next < 0) return STRAIGHT_SPEED;
    const b = this.graph.edges[car.next];
    if (b.id === a.reverse || dot(a.endDir, b.dir) < -0.8) return UTURN_SPEED;
    return sameDir(a.endDir, b.dir) ? STRAIGHT_SPEED : TURN_SPEED;
  }

  private canEnter(car: Car, e: LaneEdge, external: Obstacle[]): boolean {
    if (car.hurry > 0 && car.wait > 1) return true; // honked at: push in, Quito style
    const pri = this.priority.get(e.to);
    // One stream at a time: only cars from the same incoming edge share a junction, and never
    // two from different lanes merging into the same exit lane.
    if (pri && pri.car !== car.id && pri.edge !== e.id) return false;
    for (const o of this.occupants.get(e.to)?.values() ?? []) {
      if (o.from !== e.id) return false;
      if (o.lane !== car.lane && o.next === car.next && o.nextLane === car.nextLane) return false;
    }
    // A short exit gives no room to wait: the junction after it must be free for us too.
    const after = this.graph.edges[car.next];
    if (after.len < 25 && this.graph.nodes[after.to].junction) {
      for (const [id, o] of this.occupants.get(after.to) ?? []) if (id !== car.id && o.from !== after.id) return false;
    }
    // Don't block the box: the lane we're turning into must have room.
    const next = this.graph.edges[car.next];
    for (const c of this.cars) {
      if (c !== car && c.state === 'driving' && !c.turn && c.edge === next.id && c.lane === car.nextLane && c.s < EXIT_CLEAR) return false;
    }
    const exit = lanePoint(next, 4, car.nextLane);
    for (const o of external) if (Math.hypot(o.pos.x - exit.x, o.pos.z - exit.z) < o.length / 2 + 3) return false;
    return true;
  }

  private reserve(car: Car, node: number, fromEdge: number): void {
    let occ = this.occupants.get(node);
    if (!occ) this.occupants.set(node, (occ = new Map()));
    occ.set(car.id, { from: fromEdge, lane: car.lane, next: car.next, nextLane: car.nextLane });
    car.reserved = node;
    car.wait = 0;
    if (this.priority.get(node)?.car === car.id) this.priority.delete(node);
  }

  private unreserve(car: Car): void {
    if (car.reserved !== null) this.occupants.get(car.reserved)?.delete(car.id);
    if (car.reserved !== null && this.priority.get(car.reserved)?.car === car.id) this.priority.delete(car.reserved);
    for (const [node, p] of this.priority) if (p.car === car.id) this.priority.delete(node);
    car.reserved = null;
    car.turn = null;
  }

  private startTurn(car: Car, overshoot: number): void {
    const a = this.graph.edges[car.edge];
    const { pts, cum } = this.turnCurve(car);
    car.turn = { pts, cum, len: cum[cum.length - 1], t: overshoot, node: a.to, speed: this.turnSpeed(car) };
    if (this.graph.nodes[a.to].junction && car.reserved !== a.to) this.reserve(car, a.to, a.id); // forced entry
    const [p, hd] = sampleCurve(car.turn, overshoot);
    car.pos = p;
    car.heading = hd;
  }

  /** Bezier from the end of our lane to the start of the chosen next lane. */
  private turnCurve(car: Car): { pts: Vec2[]; cum: number[] } {
    const a = this.graph.edges[car.edge];
    const b = this.graph.edges[car.next];
    const p0 = Math.abs(car.offset - laneOffset(a, car.lane)) < 1e-6 ? lanePoint(a, a.len, car.lane) : lanePoint(a, a.len, car.lane, car.offset);
    const p3 = lanePoint(b, 0, car.nextLane);
    const d = Math.hypot(p3.x - p0.x, p3.z - p0.z);
    // Pass-through nodes (way splits) have almost no gap: keep the handles proportional.
    const h = d < 3 ? d * 0.35 : Math.max(1.5, d * (b.id === a.reverse ? 0.9 : 0.45));
    const p1 = { x: p0.x + a.endDir.x * h, z: p0.z + a.endDir.z * h };
    const p2 = { x: p3.x - b.dir.x * h, z: p3.z - b.dir.z * h };
    const pts: Vec2[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const u = 1 - t;
      pts.push({
        x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
        z: u * u * u * p0.z + 3 * u * u * t * p1.z + 3 * u * t * t * p2.z + t * t * t * p3.z,
      });
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    return { pts, cum };
  }

  /** Points along the route ahead, every PATH_STEP meters up to `reach`, with distance from the car. */
  private futurePath(car: Car, reach: number): { d: number; pos: Vec2 }[] {
    const out: { d: number; pos: Vec2 }[] = [];
    const e = this.graph.edges[car.edge];
    const next = car.next >= 0 ? this.graph.edges[car.next] : null;
    let d = PATH_STEP;
    const alongEdge = (edge: LaneEdge, s0: number, lane: number, offset: number | undefined, base: number) => {
      for (; d <= reach && s0 + (d - base) <= edge.len; d += PATH_STEP) out.push({ d, pos: lanePoint(edge, s0 + d - base, lane, offset) });
    };
    const alongTurn = (turn: { pts: Vec2[]; cum: number[] }, t0: number, base: number) => {
      const len = turn.cum[turn.cum.length - 1];
      const t = { ...turn, len, t: 0, node: 0, speed: 0 };
      for (; d <= reach && t0 + (d - base) <= len; d += PATH_STEP) out.push({ d, pos: sampleCurve(t, t0 + d - base)[0] });
      return len - t0;
    };
    const settled = Math.abs(car.offset - laneOffset(e, car.lane)) < 1e-6;
    if (car.turn) {
      const left = alongTurn(car.turn, car.turn.t, 0);
      if (next) alongEdge(next, 0, car.nextLane, undefined, left);
    } else {
      const leftOnEdge = e.len - car.s;
      alongEdge(e, car.s, car.lane, settled ? undefined : car.offset, 0);
      if (d <= reach && next) {
        const leftInTurn = alongTurn(this.turnCurve(car), 0, leftOnEdge);
        alongEdge(next, 0, car.nextLane, undefined, leftOnEdge + leftInTurn);
      }
    }
    return out;
  }

  private finishTurn(car: Car, overshoot: number): void {
    this.unreserve(car);
    car.edge = car.next;
    car.lane = car.nextLane;
    const e = this.graph.edges[car.edge];
    car.offset = laneOffset(e, car.lane);
    car.s = Math.min(overshoot, e.len);
    car.pos = lanePoint(e, car.s, car.lane);
    const dir = edgeDir(e, car.s);
    car.heading = Math.atan2(-dir.z, dir.x);
    this.chooseNext(car);
  }

  /** Picks the next edge at the end of this one, respecting lane discipline on multi-lane roads. */
  private chooseNext(car: Car): void {
    const e = this.graph.edges[car.edge];
    const node = this.graph.nodes[e.to];
    const drivable = node.out.filter((id) => this.graph.edges[id].drivable);
    if (!drivable.length) {
      car.next = -1; // leaving the map
      car.nextLane = 0;
      return;
    }
    const isUturn = (id: number) => id === e.reverse || dot(e.endDir, this.graph.edges[id].dir) < -0.8;
    let options = drivable.filter((id) => !isUturn(id));
    if (!options.length) options = drivable;
    const kind = (id: number) => {
      const o = this.graph.edges[id];
      if (isUturn(id)) return 'uturn';
      if (sameDir(e.endDir, o.dir)) return 'straight';
      return e.endDir.x * o.dir.z - e.endDir.z * o.dir.x > 0 ? 'right' : 'left';
    };
    const weight = { straight: 0.55, right: 0.25, left: 0.2, uturn: 0.1 };
    const allowed = options.filter((id) => {
      if (e.lanes < 2) return true;
      const k = kind(id);
      return k === 'straight' || (k === 'right' && car.lane === 0) || (k === 'left' && car.lane === e.lanes - 1);
    });
    const pool = allowed.length ? allowed : options;
    let roll = this.rng.next() * pool.reduce((s, id) => s + weight[kind(id)], 0);
    const pick = pool.find((id) => (roll -= weight[kind(id)]) < 0) ?? pool[0];
    const n = this.graph.edges[pick];
    const k = kind(pick);
    car.next = pick;
    if (k === 'straight') {
      // Keep the same position across width changes: the lane nearest our current offset.
      const here = laneOffset(e, car.lane);
      let best = 0;
      for (let j = 1; j < n.lanes; j++) if (Math.abs(laneOffset(n, j) - here) < Math.abs(laneOffset(n, best) - here)) best = j;
      car.nextLane = best;
    } else car.nextLane = k === 'right' || k === 'uturn' ? 0 : n.lanes - 1;
  }

  /** Drops a car on a random free lane spot at least `radius` from `avoid`. */
  private place(car: Car, avoid: Vec2, radius: number, accept: (p: Vec2) => boolean = () => true): void {
    this.unreserve(car);
    const edges = this.graph.edges.filter((e) => e.drivable && e.len > 16);
    const total = edges.reduce((s, e) => s + e.len, 0);
    for (let attempt = 0; attempt < 200; attempt++) {
      let roll = this.rng.next() * total;
      const e = edges.find((x) => (roll -= x.len) < 0) ?? edges[0];
      const lane = this.rng.int(0, e.lanes - 1);
      const s = this.rng.range(3, e.len - 10);
      const p = lanePoint(e, s, lane);
      if (Math.hypot(p.x - avoid.x, p.z - avoid.z) < radius || !accept(p)) continue;
      const free = this.cars.every(
        (c) => c === car || c.state !== 'driving' || Math.hypot(c.pos.x - p.x, c.pos.z - p.z) > 6 + (c.kind.length + car.kind.length) / 2,
      );
      if (!free) continue;
      const dir = edgeDir(e, s);
      Object.assign(car, { state: 'driving', edge: e.id, s, lane, offset: laneOffset(e, lane), pos: p, heading: Math.atan2(-dir.z, dir.x), speed: car.kind.vmax * 0.6, wait: 0, blockedTime: 0, turn: null });
      car.generation++;
      this.chooseNext(car);
      return;
    }
    car.state = 'parked';
  }
}

/** Out of the player's sight: in the fog ahead, or somewhere behind. Not too far either way. */
/** The player can't see `p`: in the fog, or behind the bus. */
function outOfSight(focus: { pos: Vec2; heading: number }, p: Vec2): boolean {
  const rel = { x: p.x - focus.pos.x, z: p.z - focus.pos.z };
  const d = Math.hypot(rel.x, rel.z);
  return d > SPAWN_HIDDEN_DIST || (dot(rel, forward(focus.heading)) < 0 && d > SPAWN_BEHIND_DIST);
}

function hiddenFrom(focus: { pos: Vec2; heading: number }, p: Vec2): boolean {
  const rel = { x: p.x - focus.pos.x, z: p.z - focus.pos.z };
  const d = Math.hypot(rel.x, rel.z);
  if (d > SPAWN_MAX_DIST) return false;
  const ahead = dot(rel, forward(focus.heading));
  return d > SPAWN_HIDDEN_DIST || (ahead < 0 && d > SPAWN_BEHIND_DIST);
}

function sampleCurve(turn: Turn, t: number): [Vec2, number] {
  let i = 1;
  while (i < turn.cum.length - 1 && turn.cum[i] < t) i++;
  const a = turn.pts[i - 1];
  const b = turn.pts[i];
  const seg = turn.cum[i] - turn.cum[i - 1] || 1;
  const u = Math.min(1, Math.max(0, (t - turn.cum[i - 1]) / seg));
  return [{ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }, Math.atan2(-(b.z - a.z), b.x - a.x)];
}
