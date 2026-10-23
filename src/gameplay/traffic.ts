import { Rng } from '../core/rng';
import type { CityData, Vec2 } from '../world/cityData';
import { forward, right, stopZone } from '../world/cityData';
import { type LaneEdge, type RoadGraph, edgeDir, edgeLift, laneOffset, lanePoint, pointAt, projectOnPath } from '../world/roadGraph';
import { pointInPolygon } from '../world/geom';
import type { TrafficLights } from './trafficLights';

export interface CarKind {
  name: 'sedan' | 'taxi' | 'buseta' | 'brt';
  length: number;
  width: number;
  height: number;
  mass: number;
  /** Cruising speed, m/s. */
  vmax: number;
  /** Relative spawn frequency. */
  weight: number;
}

export const CAR_KINDS: Record<Exclude<CarKind['name'], 'brt'>, CarKind> = {
  sedan: { name: 'sedan', length: 4.3, width: 1.8, height: 1.45, mass: 700, vmax: 12.5, weight: 0.5 },
  taxi: { name: 'taxi', length: 4.4, width: 1.8, height: 1.5, mass: 700, vmax: 14, weight: 0.35 },
  buseta: { name: 'buseta', length: 8.5, width: 2.3, height: 2.8, mass: 2600, vmax: 10.5, weight: 0.15 },
};

/**
 * The articulated bus that shuttles along the busways. Not in `CAR_KINDS`: ordinary traffic
 * never rolls it, only `TrafficSim`'s `brt` option adds a few (see `brtBusCount`).
 */
export const BRT_KIND: CarKind = { name: 'brt', length: 18, width: 2.55, height: 3.1, mass: 9000, vmax: 9.5, weight: 0 };

/** Extra width cars keep clear of a busway bus: its 18 m box sweeps wide on a bend beside a street. */
const BRT_CLEARANCE = 1.6;

/** A busway bus stops this long at a station, seconds. */
const DWELL = 5;
/** Braking it plans for into a station (gentle: it carries standing passengers), m/s². */
const BRT_DECEL = 2.5;
/** A station counts for a busway lane when its stop zone is this close to the lane, m. */
const STATION_REACH = 7;
/** A busway bus at the end of its line waits this long (terminal), then turns round onto the lane back if one is near. */
const TERMINAL_DWELL = 4;
const TERMINAL_REACH = 40;

/** Something cars must not drive into: the player's bus, wrecked cars, people crossing. */
export interface Obstacle {
  id: string;
  pos: Vec2;
  heading: number;
  length: number;
  width: number;
  /**
   * Height off the ground (negative down in an underpass, positive on a bridge). Things more
   * than `LEVEL_SEP` apart pass over each other; left out, it blocks every level.
   */
  lift?: number;
}

/** Two things whose lifts differ by more than this are on different levels (a road passing over another). */
export const LEVEL_SEP = 2;

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
  /** Waiting for a light: at the stop line, or queued behind a car that is (not stuck). */
  held: boolean;
  /** Busway bus: seconds left at the station it is stopped at. */
  dwell: number;
  /** Busway bus: the junction its tail is still crossing (kept reserved until it is clear). */
  tail: number | null;
  /** Busway bus: a junction its busway runs through without meeting it, claimed until its tail is out (`Crossing`). */
  crossing: Crossing | null;
  /** Busway bus: the station (edge and distance along it) it last stopped at, so it leaves it behind. */
  served: number;
  /** Where along `next` a turn round at a busway's end lands (0 for every ordinary turn). */
  entryS: number;
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
/** Extra room (m) kept from a car merging alongside from another edge. */
const MERGE_BERTH = 0.7;
const STRAIGHT_SPEED = 12;
const TURN_SPEED = 5.5;
const UTURN_SPEED = 3.5;
const HUMP_SPEED = 5;
const LANE_CHANGE_RATE = 2;
const PRIORITY_WAIT = 3;
/**
 * A car stuck this long (a real jam) is recycled out of sight rather than forced through.
 * Waiting for a light doesn't count: neither at the line nor queued behind someone who is.
 */
const STUCK_WAIT = 25;
/** A claim held this long (s) against a car stopped in our path from another incoming edge is given up. */
const YIELD_AFTER = 2;
/** Braking a car accepts to stop for an amber light; harder than this and it goes through. */
const AMBER_DECEL = 3.5;
const EXIT_CLEAR = 9;
/** Offset for the phantom junction claim a long bus's tail keeps (car ids stay below it). */
const TAIL = 100000;
/** Movements sharing a junction side by side keep their paths this far apart (bus and buseta half widths, a margin)... */
const SIDE_CLEAR = 2.55 / 2 + 2.3 / 2 + 0.4;
/** ...over this much of their way out of it. */
const SIDE_REACH = 20;
/** Occupant ids of busway buses running through a junction their busway doesn't meet (`Crossing`). */
const PASS = 200000;

/**
 * A junction a busway edge runs through without meeting it (OSM draws the busway across a side
 * street's junction with the avenue beside it, with no shared node): `s0`–`s1` along the edge is
 * inside its paved area, heading `dir`. A busway bus claims it like any junction, so a car turning
 * there never drives into the side of an 18 m bus.
 */
interface Crossing {
  node: number;
  edge: number;
  s0: number;
  s1: number;
  dir: Vec2;
}

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.z * b.z;
const sameDir = (a: Vec2, b: Vec2) => dot(a, b) > 0.7;

/**
 * Lane-following traffic, engine-agnostic. Cars follow the road graph, keep a safe gap to
 * whatever is ahead (other cars, the bus, pedestrians), and share each intersection one
 * direction at a time. At traffic lights they also wait at the stop line on red (and on amber
 * when they can stop comfortably). Poses here are targets; the physics layer chases them.
 */
export class TrafficSim {
  cars: Car[] = [];
  /** Seconds simulated: the clock the traffic lights run on. */
  time = 0;
  /** Drivers' pace (rain: they slow down a little). */
  speedScale = 1;
  /** Speed caps (m/s) by edge id: lanes under floodwater, which cars crawl through. */
  slowEdges = new Map<number, number>();
  private lights: TrafficLights | null;
  /** Where cars may be (edge, meters along it): a race track keeps them off its grid. */
  private keep: ((edge: number, s: number) => boolean) | null;
  /** Cars turn round at a dead end (a city's); on a highway they drive off it instead. */
  private uturns: boolean;
  private rng: Rng;
  /** Per junction: cars inside it, where each came from and where it's going. */
  private occupants = new Map<number, Map<number, { from: number; lane: number; next: number; nextLane: number; dir?: Vec2 }>>();
  private priority = new Map<number, { car: number; edge: number }>();
  private humps: number[][];
  /** Lanes ordinary cars spawn on / busway buses spawn on. */
  private carEdges: LaneEdge[];
  private brtEdges: LaneEdge[];
  /** Per edge, distances along it where a busway bus stops at a station (busway lanes only). */
  private stations: number[][];
  /** Per busway edge that ends: the lane back it turns round onto (null: none near). */
  /** Busway edges a bus never enters: they run on to an end with no lane back (it would stand there in view). */
  private traps = new Set<number>();
  private terminals = new Map<number, { edge: number; s: number; lane: number } | null>();
  private apartCache = new Map<string, boolean>();
  /** Per edge, the junctions it runs through without meeting (busway lanes only). */
  private crossings: Crossing[][];
  /** Where the bus was last seen; cars leaving the map re-enter out of its sight. */
  private focus: { pos: Vec2; heading: number } = { pos: { x: 0, z: 0 }, heading: 0 };

  constructor(
    private graph: RoadGraph,
    city: CityData,
    opts: {
      seed: number;
      count: number;
      /** Busway buses on top of `count` (0 when the city has no busway). */
      brt?: number;
      avoid?: { pos: Vec2; radius: number };
      lights?: TrafficLights;
      /** Where cars may be: never placed elsewhere, and one about to leave it is recycled (out of sight) or waits. */
      keep?: (edge: number, s: number) => boolean;
      /** False: no U-turns, not even at a dead end (it's the end of the map). */
      uturns?: boolean;
    },
  ) {
    this.rng = new Rng(opts.seed);
    this.lights = opts.lights ?? null;
    this.keep = opts.keep ?? null;
    this.uturns = opts.uturns ?? true;
    this.humps = graph.edges.map((e) =>
      city.features
        .filter((f) => f.kind === 'hump')
        .map((f) => projectOnPath(e.center, f.pos))
        .filter((pr) => pr.d < e.roadWidth / 2)
        .map((pr) => pr.s),
    );
    this.carEdges = graph.edges.filter((e) => e.drivable && e.len > 16);
    this.brtEdges = graph.edges.filter((e) => e.access === 'brt' && e.brtDrivable && e.len > 30);
    this.stations = graph.edges.map(() => []);
    for (const st of city.stops) {
      if (!st.system) continue;
      const z = stopZone(st);
      const f = forward(st.heading);
      for (const e of this.brtEdges) {
        const pr = projectOnPath(e.center, z);
        const d = edgeDir(e, pr.s);
        if (pr.d < STATION_REACH && dot(d, f) > 0.7 && pr.s > 3 && pr.s < e.len - 6) this.stations[e.id].push(pr.s);
      }
    }
    for (const list of this.stations) list.sort((a, b) => a - b);
    this.crossings = graph.edges.map((e) => (e.access === 'brt' ? crossingsOf(graph, e) : []));
    this.findTraps();
    this.brtEdges = this.brtEdges.filter((e) => !this.traps.has(e.id));
    const kinds = Object.values(CAR_KINDS);
    const total = opts.count + (this.brtEdges.length ? (opts.brt ?? 0) : 0);
    for (let i = 0; i < total; i++) {
      let r = this.rng.next() * kinds.reduce((s, k) => s + k.weight, 0);
      const kind = i >= opts.count ? BRT_KIND : (kinds.find((k) => (r -= k.weight) < 0) ?? kinds[0]);
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
        held: false,
        dwell: 0,
        entryS: 0,
        tail: null,
        crossing: null,
        served: -1,
        generation: 0,
      };
      this.cars.push(car);
      this.place(car, opts.avoid?.pos ?? { x: 1e9, z: 1e9 }, opts.avoid?.radius ?? 0);
    }
  }

  step(dt: number, obstacles: Obstacle[]): TrafficEvent[] {
    const events: TrafficEvent[] = [];
    this.time += dt;
    const driving = this.cars.filter((c) => c.state === 'driving');
    const others: Obstacle[] = [
      ...driving.map((c) => ({ id: `car${c.id}`, pos: c.pos, heading: c.heading, length: c.kind.length, width: c.kind.width + (c.kind === BRT_KIND ? BRT_CLEARANCE : 0), lift: this.liftOf(c) })),
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
    const dist = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.z - q.z);
    const elsewhere = (c: Car) => this.place(c, focus.pos, 0, (p) => hiddenFrom(focus, p));
    for (const c of this.cars) {
      // A busway bus parked for lack of a corridor in range comes back when one is.
      if (c.state === 'parked' && c.kind === BRT_KIND) this.place(c, focus.pos, 0, fill ? () => true : (p) => hiddenFrom(focus, p));
      // On a track (no budget to keep) a car is only parked for want of a spot: it tries again.
      else if (c.state === 'parked' && this.keep && !fill) elsewhere(c);
      if (c.state !== 'driving') continue;
      const d = dist(c.pos, focus.pos);
      if (fill) this.place(c, focus.pos, 20, (p) => dist(p, focus.pos) < RECYCLE_RADIUS * 0.8);
      else if (d >= RECYCLE_RADIUS) elsewhere(c);
    }
  }

  /** Parks the cars farthest from the bus (or brings parked ones back) to hit `budget` drivers. */
  setBudget(budget: number, bus: Vec2, heading = 0): void {
    const driving = this.cars.filter((c) => c.state === 'driving' && c.kind !== BRT_KIND);
    const far = (c: Car) => -Math.hypot(c.pos.x - bus.x, c.pos.z - bus.z);
    if (driving.length > budget) {
      driving.sort((a, b) => far(a) - far(b));
      for (const c of driving.slice(0, driving.length - budget)) {
        this.unreserve(c);
        c.state = 'parked';
      }
    } else {
      const parked = this.cars.filter((c) => c.state === 'parked' && c.kind !== BRT_KIND);
      for (const c of parked.slice(0, budget - driving.length)) this.place(c, bus, 0, (p) => hiddenFrom({ pos: bus, heading }, p));
    }
  }

  /** How far above (or below) the ground the car is: its lane's lift, or its junction's mid-turn. */
  liftOf(car: Car): number {
    return car.turn ? this.graph.nodes[car.turn.node].lift : edgeLift(this.graph.edges[car.edge], car.s);
  }

  private drive(car: Car, dt: number, others: Obstacle[], external: Obstacle[], events: TrafficEvent[]): void {
    if (car.wait > STUCK_WAIT || car.blockedTime > STUCK_WAIT) {
      this.place(car, this.focus.pos, 0, (p) => hiddenFrom(this.focus, p));
      return;
    }
    if (car.tail !== null && !car.turn && car.s > car.kind.length / 2 + 2) this.clearTail(car);
    const e = this.graph.edges[car.edge];
    // About to leave where cars may be (a track's grid ahead): gone if nobody sees it, else it stops short.
    let fenced = false;
    if (this.keep && !car.turn && !this.keep(car.edge, Math.min(e.len, car.s + (car.speed * car.speed) / (2 * DECEL) + 3))) {
      if (outOfSight(this.focus, car.pos)) {
        this.place(car, this.focus.pos, 0, (p) => hiddenFrom(this.focus, p));
        return;
      }
      fenced = true;
    }
    const cap = this.slowEdges.get(car.edge);
    const vmax = Math.min(cap ?? Infinity, car.kind.vmax * (car.hurry > 0 ? 1.15 : 1) * this.speedScale);
    car.hurry = Math.max(0, car.hurry - dt);
    car.honkCooldown = Math.max(0, car.honkCooldown - dt);

    // Whatever lies on the path we're about to drive (lane, turn curve, next lane).
    let vTarget = fenced ? 0 : vmax;
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
      // The one going first still keeps off the other's body, only not the safety margin round it
      // (and stays on record as blocked, or the standoff would lapse and flicker every step).
      const first = !!standoff && car.id < other!.id;
      if (first) blocker ??= o.id;
      const of = forward(o.heading);
      const or = right(o.heading);
      // Busway buses only go straight on, each in its own direction's lane: an oncoming one is in
      // the other lane, never in the way (its box, widened by the clearance cars keep from it,
      // would reach over the lane line and leave both buses waiting nose to nose).
      if (car.kind === BRT_KIND && other?.kind === BRT_KIND && dot(forward(car.heading), of) < -0.5) continue;
      if (car.kind === BRT_KIND && other && other.kind !== BRT_KIND) {
        // An 18 m bus has a body behind its center that its forward path never covers: with
        // someone already alongside it (a street running beside the busway), wait for them to clear.
        const bf = forward(car.heading);
        const rel = { x: o.pos.x - car.pos.x, z: o.pos.z - car.pos.z };
        const lift = this.liftOf(car);
        if (Math.abs(dot(rel, bf)) < car.kind.length / 2 + o.length / 2 + 0.5 && Math.abs(dot(rel, right(car.heading))) < car.kind.width / 2 + o.width / 2 + 0.3 && (o.lift === undefined || Math.abs(o.lift - lift) <= LEVEL_SEP)) {
          vTarget = 0;
          blocker = o.id;
          continue;
        }
      }
      // Two cars merging at a shallow angle: the corners of their boxes reach further sideways than
      // their centers (the path only samples the center line).
      const skew = Math.abs(of.x * forward(car.heading).z - of.z * forward(car.heading).x);
      // Alongside on another edge heading the same way (two roads drawn over the same corridor that
      // merge into one exit): its lane drifts across ours as the edges bend, so keep a wider berth.
      const merging = !!other && !other.turn && !car.turn && other.state === 'driving' && other.edge !== car.edge && dot(forward(car.heading), of) > 0.8;
      const reachPad = first ? car.kind.width / 2 : pad + (skew < 0.35 ? (skew * (o.length + car.kind.length)) / 2 : 0) + (merging ? MERGE_BERTH : 0);
      for (const p of path) {
        const rel = { x: p.pos.x - o.pos.x, z: p.pos.z - o.pos.z };
        if (Math.abs(dot(rel, of)) > o.length / 2 + reachPad || Math.abs(dot(rel, or)) > o.width / 2 + reachPad) continue;
        // Over or under our path (a bridge, an underpass): not in the way.
        if (o.lift !== undefined && Math.abs(o.lift - p.lift) > LEVEL_SEP) continue;
        const v = Math.sqrt(2 * DECEL * Math.max(0, p.d - car.kind.length / 2 - MIN_GAP));
        if (v < vTarget) {
          vTarget = v;
          blocker = o.id;
        }
        break;
      }
    }
    car.blocker = blocker;
    // Queued behind a car waiting for a light: waiting for it too.
    const ahead = blocker?.startsWith('car') ? this.cars[+blocker.slice(3)] : null;
    car.held = !!ahead && ahead.held && car.speed < 1;
    // Two incoming edges whose last meters share the same road (OSM draws both): a car stopped at
    // its line from the other edge sits in our path. Holding the junction against it deadlocks
    // (it can't enter, we can't pass it), so give the claim up and let it go first.
    const waiting = ahead !== null && ahead.state === 'driving' && !ahead.turn && ahead.edge !== car.edge && ahead.reserved !== e.to && this.graph.edges[ahead.edge].to === e.to && ahead.speed < 0.5 && !(ahead.blocker === self && car.id < ahead.id) && this.priority.get(e.to)?.car !== car.id;
    if (waiting && !car.turn && car.reserved === e.to && car.speed < 0.5 && car.blockedTime > YIELD_AFTER) {
      this.unreserve(car);
      this.priority.set(e.to, { car: ahead.id, edge: ahead.edge });
    } else if (ahead && ahead.state === 'driving' && !ahead.turn && ahead.reserved === null && ahead.speed < 0.5 && car.speed < 0.5 && car.blockedTime > YIELD_AFTER) {
      // Same for a priority claim on a junction further on (a short exit's next one): the car
      // stopped at its line there is in our way, so it goes first.
      const at = this.graph.edges[ahead.edge].to;
      if (this.priority.get(at)?.car === car.id) this.priority.set(at, { car: ahead.id, edge: ahead.edge });
    }

    if (car.turn) {
      vTarget = Math.min(vTarget, car.turn.speed);
      // Swinging round at a busway's end: hold still while something sits in the arc just ahead.
      if (car.entryS > 0 && !this.swingClear(car, car.turn, car.turn.t + 1, Math.min(car.turn.len, car.turn.t + 7), external)) vTarget = 0;
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
        const line = this.lights?.approach(e.id);
        const toLine = remaining - car.kind.length / 2 - (line ? e.len - line.s : 0);
        if (line && this.stopsForLight(car, e, toLine)) {
          // Red (or an amber we can stop for): front bumper at the stop line, and no waiting
          // counted (no priority claims, no recycling as stuck).
          vTarget = Math.min(vTarget, Math.sqrt(2 * DECEL * Math.max(0, toLine - 0.3)));
          car.held = true;
        } else if (toLine < decide) {
          // Never ahead of a car in front still waiting to go in (one in the next lane merging
          // into our path): with our claim it may not enter, and we can't pass it.
          const queued = waiting || (ahead !== null && ahead.state === 'driving' && !ahead.turn && ahead.edge === e.id && ahead.reserved !== node);
          if (!queued && this.canEnter(car, e, external)) this.reserve(car, node, e.id);
          else {
            // Stop with the front bumper at the line, not the middle of the car.
            vTarget = Math.min(vTarget, Math.sqrt(2 * DECEL * Math.max(0, remaining - car.kind.length / 2 - 0.5)));
            if (car.speed < 0.5) car.wait += dt;
            if (car.wait > PRIORITY_WAIT && !this.priority.has(node)) this.priority.set(node, { car: car.id, edge: e.id });
          }
        }
      }
      if (!exiting) vTarget = Math.min(vTarget, Math.sqrt(this.turnSpeed(car) ** 2 + 2 * DECEL * remaining));
      if (car.kind === BRT_KIND) {
        vTarget = Math.min(vTarget, this.station(car, e, dt));
        vTarget = Math.min(vTarget, this.passThrough(car, e, dt));
        if (exiting) {
          // A busway that ends: stop with the nose at the end (18 m must not hang over the street
          // it meets) and, once out of sight, go back into service elsewhere.
          const room = remaining - car.kind.length / 2 - 0.5;
          vTarget = Math.min(vTarget, Math.sqrt(2 * BRT_DECEL * Math.max(0, room)));
          if (room < 1 && car.speed < 0.3) {
            car.wait += dt;
            if (car.wait > 3 && outOfSight(this.focus, car.pos)) this.place(car, this.focus.pos, 0, (p) => hiddenFrom(this.focus, p));
            else if (car.wait > TERMINAL_DWELL && this.turnRound(car, e, external)) return;
          }
        }
      }

      // Stuck behind something that isn't moving on a multi-lane road: change lanes.
      if (e.lanes > 1 && blocker && car.speed < 1 && car.blockedTime > 2) {
        const other = car.lane === 0 ? 1 : car.lane - 1;
        const clear = this.cars.every(
          (c) => c === car || c.state !== 'driving' || c.edge !== e.id || c.lane !== other || Math.abs(c.s - car.s) > 12,
        );
        // Nor into a car of another edge sitting over that lane (two roads drawn over the same
        // corridor): the lane change would drive into its body.
        const spot = lanePoint(e, car.s, other);
        const free = clear && this.cars.every((c) => c === car || c.state !== 'driving' || c.edge === e.id || Math.hypot(c.pos.x - spot.x, c.pos.z - spot.z) > (c.kind.length + car.kind.length) / 2 + 1.5);
        if (free) {
          car.lane = other;
          this.chooseNext(car);
        }
      }
    }

    // Honk at the bus if it's in the way.
    if (blocker && car.speed < 1) {
      if (!car.held) car.blockedTime += dt;
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
        else if (this.graph.nodes[e.to].junction && car.reserved !== e.to && this.stopsForLight(car, e, 0)) {
          // Red, and we came in too fast to stop at the stop line: stop here instead.
          car.s = e.len - 0.01;
          car.speed = 0;
          car.held = true;
        } else if (this.graph.nodes[e.to].junction && car.reserved !== e.to && !this.canEnter(car, e, external)) {
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
    // Skew toward the lane we are moving to; capped by a nominal speed so a crawling car does not turn sideways.
    if (car.kind === BRT_KIND) {
      // A rigid 18 m box lies along the chord of the bend under it, not the tangent at its middle.
      const a = lanePoint(edge, Math.max(0, car.s - car.kind.length / 2), car.lane);
      const b = lanePoint(edge, Math.min(edge.len, car.s + car.kind.length / 2), car.lane);
      if (Math.hypot(b.x - a.x, b.z - a.z) > 4) {
        car.heading = Math.atan2(-(b.z - a.z), b.x - a.x);
        return;
      }
    }
    car.heading = Math.atan2(-d.z, d.x) - (car.speed > 1 && car.kind !== BRT_KIND ? Math.atan2(lateral / dt, Math.max(car.speed, 12)) : 0);
  }

  /** Speed cap for a busway bus approaching or standing at a station on its lane. */
  private station(car: Car, e: LaneEdge, dt: number): number {
    if (car.dwell > 0) {
      car.dwell -= dt;
      return 0;
    }
    for (const sd of this.stations[e.id]) {
      const key = e.id * 10000 + Math.round(sd);
      const left = sd - car.s;
      if (key === car.served || left < -1) continue;
      if (left < 0.8 && car.speed < 0.5) {
        car.served = key;
        car.dwell = DWELL;
        return 0;
      }
      return Math.sqrt(2 * BRT_DECEL * Math.max(0, left - 0.5)) + 0.3;
    }
    return Infinity;
  }

  private turnSpeed(car: Car): number {
    const a = this.graph.edges[car.edge];
    if (car.next < 0) return STRAIGHT_SPEED;
    const b = this.graph.edges[car.next];
    if (b.id === a.reverse || dot(a.endDir, b.dir) < -0.8) return UTURN_SPEED;
    return sameDir(a.endDir, b.dir) ? STRAIGHT_SPEED : TURN_SPEED;
  }

  /**
   * The light ahead says stop, `toLine` meters before the stop line (front bumper): on red, and on
   * amber when we can still stop gently. Without a light, never.
   */
  private stopsForLight(car: Car, e: LaneEdge, toLine: number): boolean {
    const light = this.lights?.state(e.id, this.time);
    if (light === 'red') return true;
    return light === 'amber' && toLine > 0 && (car.speed * car.speed) / (2 * AMBER_DECEL) < toLine;
  }

  private canEnter(car: Car, e: LaneEdge, external: Obstacle[]): boolean {
    if (car.hurry > 0 && car.wait > 1) return true; // honked at: push in, Quito style
    const pri = this.priority.get(e.to);
    // One stream at a time: only cars from the same incoming edge share a junction, and never
    // two from different lanes merging into the same exit lane. A car that claimed its turn
    // and then got a red light gives it up until its green.
    const brt = car.kind === BRT_KIND;
    if (pri && pri.car !== car.id && pri.edge !== e.id && !(brt && this.straight(e.id, car.next) && this.parallel(e.id, pri.edge)) && (this.lights?.state(pri.edge, this.time) ?? 'green') === 'green') return false;
    for (const [id, o] of this.occupants.get(e.to) ?? []) {
      // A busway bus running through without meeting the junction: only straight movements
      // alongside it share it.
      if (id >= PASS) {
        const x = this.cars[id - PASS]?.crossing;
        if (x && this.straight(e.id, car.next) && Math.abs(dot(e.endDir, o.dir!)) > 0.9 && this.clearOf(car.next, car.nextLane, 0, SIDE_REACH, x.edge, 0)) continue;
        return false;
      }
      // A busway bus going straight shares the junction with straight movements alongside it
      // (the avenue's lanes beside the busway, the oncoming bus): their paths never cross.
      if ((brt || this.cars[id >= TAIL ? id - TAIL : id]?.kind === BRT_KIND) && this.straight(e.id, car.next) && this.straight(o.from, o.next) && this.parallel(e.id, o.from) && this.clearOf(car.next, car.nextLane, 0, SIDE_REACH, o.next, o.nextLane)) continue;
      if (o.from !== e.id) return false;
      if (o.lane !== car.lane && o.next === car.next && o.nextLane === car.nextLane) return false;
    }
    // A short exit gives no room to wait: the junction after it must be free for us too.
    const after = this.graph.edges[car.next];
    if (after.len < 25 && this.graph.nodes[after.to].junction) {
      for (const [id, o] of this.occupants.get(after.to) ?? [])
        if (id !== car.id && o.from !== after.id) {
          // Claim that junction for the short exit's stream too, or a busy stream through it
          // starves ours for good (the Queseras tunnel link behind Queseras' 16 m).
          if (car.wait > PRIORITY_WAIT && !this.priority.has(after.to)) this.priority.set(after.to, { car: car.id, edge: after.id });
          return false;
        }
    }
    // Don't block the box: the lane we're turning into must have room.
    const next = this.graph.edges[car.next];
    for (const c of this.cars) {
      if (c !== car && c.state === 'driving' && !c.turn && c.edge === next.id && c.lane === car.nextLane && c.s < EXIT_CLEAR) return false;
    }
    const exit = lanePoint(next, 4, car.nextLane);
    const exitLift = edgeLift(next, 4);
    for (const o of external)
      if (Math.hypot(o.pos.x - exit.x, o.pos.z - exit.z) < o.length / 2 + 3 && (o.lift === undefined || Math.abs(o.lift - exitLift) <= LEVEL_SEP)) return false;
    return true;
  }

  /** Driving from edge `from` into `next` keeps (nearly) straight on. */
  private straight(from: number, next: number): boolean {
    return next >= 0 && dot(this.graph.edges[from].endDir, this.graph.edges[next].dir) > 0.9;
  }

  /**
   * Lane `la` of edge `a`, from `s0` to `s1` along it, keeps clear of lane `lb` of edge `b` by a
   * busway bus's and a car's half widths: two straight movements alongside each other only share
   * a junction if their paths really are apart (a busway leaving a junction a lane's width from
   * the avenue beside it is not: an 18 m bus covers the avenue's near lane as it straightens out).
   */
  private clearOf(a: number, la: number, s0: number, s1: number, b: number, lb: number): boolean {
    if (a < 0 || b < 0) return true;
    const key = `${a}:${la}:${s0}:${s1}:${b}:${lb}`;
    let v = this.apartCache.get(key);
    if (v === undefined) {
      const ea = this.graph.edges[a];
      const pb = this.graph.edges[b].lanePaths[Math.min(lb, this.graph.edges[b].lanes - 1)];
      v = true;
      for (let s = s0; s <= Math.min(s1, ea.len) && v; s += 2) if (projectOnPath(pb, lanePoint(ea, s, la)).d < SIDE_CLEAR) v = false;
      this.apartCache.set(key, v);
    }
    return v;
  }

  /** Two approaches run along the same axis (same way or opposite). */
  private parallel(a: number, b: number): boolean {
    return Math.abs(dot(this.graph.edges[a].endDir, this.graph.edges[b].endDir)) > 0.9;
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
    this.clearTail(car);
    this.clearCrossing(car);
    if (car.reserved !== null) this.occupants.get(car.reserved)?.delete(car.id);
    if (car.reserved !== null && this.priority.get(car.reserved)?.car === car.id) this.priority.delete(car.reserved);
    for (const [node, p] of this.priority) if (p.car === car.id) this.priority.delete(node);
    car.reserved = null;
    car.turn = null;
  }

  /**
   * Speed limit for a busway bus from the junctions its busway runs through without meeting
   * (`Crossing`): it claims the next one ahead once nothing but straight traffic alongside is in
   * it, and stops short of it until then; the claim lapses when its tail is out.
   */
  private passThrough(car: Car, e: LaneEdge, dt: number): number {
    const half = car.kind.length / 2;
    const x = car.crossing;
    if (x && (x.edge !== e.id || car.s - half > x.s1 + 1)) this.clearCrossing(car);
    if (car.crossing) return Infinity;
    const front = car.s + half;
    const next = this.crossings[e.id].find((c) => c.s1 > car.s - half);
    if (!next || next.s0 - front > Math.max(8, (car.speed * car.speed) / (2 * BRT_DECEL) + 4)) return Infinity;
    // Already in it (just placed, or it couldn't stop): claim it all the same.
    const free =
      front > next.s0 - 0.5 ||
      [...(this.occupants.get(next.node) ?? [])].every(([id, o]) =>
        id >= PASS ? Math.abs(dot(o.dir!, next.dir)) > 0.9 : this.straight(o.from, o.next) && Math.abs(dot(this.graph.edges[o.from].endDir, next.dir)) > 0.9 && this.clearOf(o.next, o.nextLane, 0, SIDE_REACH, e.id, car.lane),
      );
    if (!free) {
      if (car.speed < 0.5) car.wait += dt;
      return Math.sqrt(2 * BRT_DECEL * Math.max(0, next.s0 - front - 1));
    }
    let occ = this.occupants.get(next.node);
    if (!occ) this.occupants.set(next.node, (occ = new Map()));
    occ.set(PASS + car.id, { from: e.id, lane: car.lane, next: e.id, nextLane: car.lane, dir: next.dir });
    car.crossing = next;
    return Infinity;
  }

  private clearCrossing(car: Car): void {
    if (!car.crossing) return;
    this.occupants.get(car.crossing.node)?.delete(PASS + car.id);
    car.crossing = null;
  }

  /** A busway bus's tail has left the junction (or the bus was moved): other streams may enter. */
  private clearTail(car: Car): void {
    if (car.tail === null) return;
    this.occupants.get(car.tail)?.delete(TAIL + car.id);
    car.tail = null;
  }

  /** Fixed point: an edge is a trap when no lane runs on from its end and no lane back is near. */
  private findTraps(): void {
    const all = this.brtEdges;
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of all) {
        if (this.traps.has(e.id)) continue;
        const back = this.terminal(e);
        if (back && !this.traps.has(back.edge)) continue;
        const onward = this.graph.nodes[e.to].out.map((id) => this.graph.edges[id]).filter((o) => o.access === 'brt' && o.brtDrivable && sameDir(e.endDir, o.dir) && !this.traps.has(o.id));
        if (!onward.length) (this.traps.add(e.id), (changed = true));
      }
    }
  }

  /** The busway lane running back beside the end of `e` (a terminal's way round), if one is near. */
  private terminal(e: LaneEdge): { edge: number; s: number; lane: number } | null {
    let found = this.terminals.get(e.id);
    if (found !== undefined) return found;
    found = null;
    const end = lanePoint(e, e.len, 0);
    let best = TERMINAL_REACH;
    for (const o of this.brtEdges) {
      if (o.id === e.id || dot(e.endDir, o.dir) > -0.8) continue;
      for (let s = 0; s <= Math.min(o.len, 40); s += 2) {
        const p = lanePoint(o, s, 0);
        const d = Math.hypot(p.x - end.x, p.z - end.z);
        if (d < best) (best = d), (found = { edge: o.id, s: Math.max(s, 4), lane: 0 });
      }
    }
    this.terminals.set(e.id, found);
    return found;
  }

  /** End of the line: after the terminal wait, swing round onto the lane back (false: not yet or nowhere to go). */
  private turnRound(car: Car, e: LaneEdge, external: Obstacle[]): boolean {
    const t = this.terminal(e);
    if (!t) return false;
    const o = this.graph.edges[t.edge];
    const p3 = lanePoint(o, t.s, t.lane);
    const land = (c: Car) => (c.turn ? c.next === t.edge && c.entryS > 0 : c.edge === t.edge && Math.abs(c.s - t.s) < 12 + c.kind.length / 2);
    if (this.cars.some((c) => c !== car && c.kind === BRT_KIND && c.state === 'driving' && land(c))) return false;
    const p0 = lanePoint(e, e.len, car.lane);
    const d = Math.hypot(p3.x - p0.x, p3.z - p0.z);
    // Bulge ahead of the end first: a rigid 18 m box can't pivot on the spot.
    const h = Math.max(9, d);
    const p1 = { x: p0.x + e.endDir.x * h, z: p0.z + e.endDir.z * h };
    const p2 = { x: p3.x - o.dir.x * h, z: p3.z - o.dir.z * h };
    const pts: Vec2[] = [];
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      const v = 1 - u;
      pts.push({
        x: v * v * v * p0.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u * u * u * p3.x,
        z: v * v * v * p0.z + 3 * v * v * u * p1.z + 3 * v * u * u * p2.z + u * u * u * p3.z,
      });
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    // The whole swing must be clear of everything standing or driving about (the bus's own box, every 2 m).
    const swing: Turn = { pts, cum, len: cum[cum.length - 1], t: 0, node: e.to, speed: UTURN_SPEED };
    if (!this.swingClear(car, swing, 0, swing.len, external)) return false;
    car.next = t.edge;
    car.nextLane = t.lane;
    car.entryS = t.s;
    if (this.graph.nodes[e.to].junction && car.reserved !== e.to) {
      if (!this.canEnter(car, e, external)) {
        // Waiting for its green is no reason to be recycled as stuck.
        if (this.lights && this.lights.state(e.id, this.time) !== 'green') car.wait = Math.min(car.wait, TERMINAL_DWELL + 1);
        // Whoever has waited longest takes the junction's priority; a steady queue on the cross street can't hold it for good.
        const holder = this.priority.get(e.to);
        if (!holder || (holder.car !== car.id && (this.cars[holder.car].wait < car.wait - 2 || car.wait > TERMINAL_DWELL + 4))) this.priority.set(e.to, { car: car.id, edge: e.id });
        car.next = -1;
        car.entryS = 0;
        return false;
      }
      this.reserve(car, e.to, e.id);
    }
    car.turn = swing;
    car.wait = 0;
    return true;
  }

  /** The bus's box along `turn` between `from` and `to` (every 2 m) touches nothing else. */
  private swingClear(car: Car, turn: Turn, from: number, to: number, external: Obstacle[]): boolean {
    const lift = edgeLift(this.graph.edges[car.edge], this.graph.edges[car.edge].len);
    for (let u = from; u <= to; u += 2) {
      const [pos, heading] = sampleCurve(turn, u);
      const box = { pos, heading, length: car.kind.length + 1, width: car.kind.width + 1 };
      for (const c of this.cars) {
        if (c === car || c.state !== 'driving' || Math.abs(this.liftOf(c) - lift) > LEVEL_SEP) continue;
        // A bus queued behind us on this lane isn't in the way: it is where we came from.
        if (c.kind === BRT_KIND && c.edge === car.edge && !c.turn) continue;
        if (boxesOverlap(box, { pos: c.pos, heading: c.heading, length: c.kind.length, width: c.kind.width })) return false;
      }
      for (const x of external) if (Math.abs((x.lift ?? lift) - lift) <= LEVEL_SEP && boxesOverlap(box, x)) return false;
    }
    return true;
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
  private futurePath(car: Car, reach: number): { d: number; pos: Vec2; lift: number }[] {
    const out: { d: number; pos: Vec2; lift: number }[] = [];
    const e = this.graph.edges[car.edge];
    const next = car.next >= 0 ? this.graph.edges[car.next] : null;
    let d = PATH_STEP;
    const alongEdge = (edge: LaneEdge, s0: number, lane: number, offset: number | undefined, base: number) => {
      for (; d <= reach && s0 + (d - base) <= edge.len; d += PATH_STEP) out.push({ d, pos: lanePoint(edge, s0 + d - base, lane, offset), lift: edgeLift(edge, s0 + d - base) });
    };
    const alongTurn = (turn: { pts: Vec2[]; cum: number[] }, t0: number, base: number) => {
      const len = turn.cum[turn.cum.length - 1];
      const t = { ...turn, len, t: 0, node: 0, speed: 0 };
      const lift = this.graph.nodes[e.to].lift;
      for (; d <= reach && t0 + (d - base) <= len; d += PATH_STEP) out.push({ d, pos: sampleCurve(t, t0 + d - base)[0], lift });
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
    // An 18 m bus is still crossing the junction when its middle leaves it: keep it taken.
    const node = car.reserved;
    const held = car.kind === BRT_KIND && node !== null ? this.occupants.get(node)?.get(car.id) : undefined;
    this.unreserve(car);
    if (held && node !== null) {
      this.occupants.get(node)!.set(TAIL + car.id, held);
      car.tail = node;
    }
    car.edge = car.next;
    car.lane = car.nextLane;
    const e = this.graph.edges[car.edge];
    car.offset = laneOffset(e, car.lane);
    car.s = Math.min(car.entryS + overshoot, e.len);
    car.entryS = 0;
    car.pos = lanePoint(e, car.s, car.lane);
    const dir = edgeDir(e, car.s);
    car.heading = Math.atan2(-dir.z, dir.x);
    this.chooseNext(car);
  }

  /** Picks the next edge at the end of this one, respecting lane discipline on multi-lane roads. */
  private chooseNext(car: Car): void {
    const e = this.graph.edges[car.edge];
    const node = this.graph.nodes[e.to];
    // Busway buses stay on busway lanes (turning round at a dead end); the rest stay off them.
    const brt = car.kind === BRT_KIND;
    // An 18 m bus only drives straight on: a turn or U-turn would swing its box over the street
    // beside the busway, so where the busway turns it ends (see the end-of-busway wait in `drive`).
    const drivable = node.out.filter((id) => {
      const o = this.graph.edges[id];
      return brt ? o.access === 'brt' && o.brtDrivable && sameDir(e.endDir, o.dir) && !this.traps.has(o.id) : o.drivable;
    });
    if (!drivable.length) {
      car.next = -1; // leaving the map
      car.nextLane = 0;
      return;
    }
    const isUturn = (id: number) => id === e.reverse || dot(e.endDir, this.graph.edges[id].dir) < -0.8;
    let options = drivable.filter((id) => !isUturn(id));
    if (!options.length && this.uturns) options = drivable;
    if (!options.length) {
      car.next = -1; // the end of the road
      car.nextLane = 0;
      return;
    }
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
    // Busway buses start on a corridor lane near `avoid` (any other would rarely be in range).
    const edges = car.kind === BRT_KIND ? this.brtEdges.filter((e) => Math.hypot(e.a.x - avoid.x, e.a.z - avoid.z) < SPAWN_MAX_DIST + e.len) : this.carEdges;
    if (!edges.length) {
      car.state = 'parked';
      return;
    }
    const total = edges.reduce((s, e) => s + e.len, 0);
    for (let attempt = 0; attempt < 200; attempt++) {
      let roll = this.rng.next() * total;
      const e = edges.find((x) => (roll -= x.len) < 0) ?? edges[0];
      const lane = this.rng.int(0, e.lanes - 1);
      const s = this.rng.range(3, e.len - 10);
      const p = lanePoint(e, s, lane);
      if (Math.hypot(p.x - avoid.x, p.z - avoid.z) < radius || !accept(p) || (this.keep && !this.keep(e.id, s))) continue;
      const lift = edgeLift(e, s);
      const free = this.cars.every(
        (c) =>
          c === car ||
          c.state !== 'driving' ||
          Math.hypot(c.pos.x - p.x, c.pos.z - p.z) > 6 + (c.kind.length + car.kind.length) / 2 ||
          Math.abs(this.liftOf(c) - lift) > LEVEL_SEP,
      );
      if (!free) continue;
      const dir = edgeDir(e, s);
      Object.assign(car, { state: 'driving', edge: e.id, s, lane, offset: laneOffset(e, lane), pos: p, heading: Math.atan2(-dir.z, dir.x), speed: car.kind.vmax * 0.6, wait: 0, blockedTime: 0, held: false, dwell: 0, tail: null, turn: null });
      car.generation++;
      this.chooseNext(car);
      return;
    }
    car.state = 'parked';
  }
}

/** Busway buses a city gets: one per ~1.2 km of busway lane, 1 to 4 (0 without a busway). */
export function brtBusCount(graph: RoadGraph): number {
  const m = graph.edges.reduce((s, e) => s + (e.access === 'brt' && e.brtDrivable ? e.len : 0), 0);
  return m < 100 ? 0 : Math.max(1, Math.min(4, Math.round(m / 1200)));
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

/** Oriented boxes on the ground plane overlap (separating axis test). */
function boxesOverlap(a: { pos: Vec2; heading: number; length: number; width: number }, b: typeof a): boolean {
  const fa = forward(a.heading);
  const fb = forward(b.heading);
  const axes = [fa, { x: -fa.z, z: fa.x }, fb, { x: -fb.z, z: fb.x }];
  const d = { x: b.pos.x - a.pos.x, z: b.pos.z - a.pos.z };
  const reach = (o: typeof a, f: Vec2, ax: Vec2) => (Math.abs(dot(f, ax)) * o.length + Math.abs(f.x * ax.z - f.z * ax.x) * o.width) / 2;
  return axes.every((ax) => Math.abs(dot(d, ax)) <= reach(a, fa, ax) + reach(b, fb, ax));
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

/** The junctions a busway edge's lane runs through without meeting them (see `Crossing`). */
function crossingsOf(graph: RoadGraph, e: LaneEdge): Crossing[] {
  const out: Crossing[] = [];
  const path = e.lanePaths[0];
  const box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const p of path.pts) (box.x0 = Math.min(box.x0, p.x)), (box.x1 = Math.max(box.x1, p.x)), (box.z0 = Math.min(box.z0, p.z)), (box.z1 = Math.max(box.z1, p.z));
  for (const n of graph.nodes) {
    if (!n.junction || !n.hull || n.id === e.from || n.id === e.to) continue;
    if (n.hull.every((q) => q.x < box.x0 - 1 || q.x > box.x1 + 1 || q.z < box.z0 - 1 || q.z > box.z1 + 1)) continue;
    let s0 = -1;
    let s1 = -1;
    for (let s = 0; s <= path.len; s += 1)
      if (pointInPolygon(pointAt(path, s), n.hull)) {
        if (s0 < 0) s0 = s;
        s1 = s;
      }
    // (Near the edge's ends the busway is in its own junctions' paved area.)
    if (s0 < 0 || s0 < 12 || s1 > path.len - 12) continue;
    out.push({ node: n.id, edge: e.id, s0, s1, dir: edgeDir(e, (s0 + s1) / 2) });
  }
  return out.sort((a, b) => a.s0 - b.s0);
}
