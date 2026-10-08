import { Rng } from '../core/rng';
import type { CityData, Stop, Vec2 } from '../world/cityData';
import { right } from '../world/cityData';

/** Quito's real bus fare. */
export const FARE_CENTS = 35;
export const START_TIME = 90;
/** Stop within this distance of the zone center to service a stop. */
export const ZONE_RADIUS = 7;
/** Passengers get on and off below this speed (m/s): 25 km/h, a Quito bus barely stops. */
export const STOP_SPEED = 25 / 3.6;
const APPROACH_DIST = 60;
const MIN_STOP_SPACING = 90;
/** Straight-line distance undercounts street distance on a grid. */
const DETOUR = 1.3;

const TIPS = { fast: 50, ok: 10, slow: 0 } as const;
const TIME_BONUS = { fast: 8, ok: 4, slow: 1 } as const;
export type Rating = keyof typeof TIPS;

export interface RouteStop {
  stop: Stop;
  /** Where the bus has to stop: the right-hand lane beside the shelter. */
  zone: Vec2;
}

export interface Passenger {
  id: number;
  from: number;
  to: number;
  /** Seconds a ride to `to` should take; slower rides earn no tip. */
  budget: number;
  boardedAt: number;
  /** 0..1, picks clothing colors. */
  look: number;
  impatient: boolean;
}

export type GameEvent =
  | { type: 'arrive'; stopIndex: number; boarded: Passenger[]; alighted: Passenger[]; spawned: Passenger[]; timeBonus: number; rating: Rating }
  | { type: 'fare'; passenger: Passenger; cents: number; rating: Rating }
  | { type: 'approach'; stopIndex: number; count: number }
  | { type: 'impatient'; passenger: Passenger }
  | { type: 'gameOver' };

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/** Greedy tour through `count` stops, starting at the one nearest the spawn. */
export function buildRoute(city: CityData, opts: { count: number }): RouteStop[] {
  const left = [...city.stops];
  const pickNearest = (from: Vec2, minDist: number) => {
    const ok = left.filter((s) => dist(s.pos, from) >= minDist);
    const pool = ok.length ? ok : left;
    let best = pool[0];
    for (const s of pool) if (dist(s.pos, from) < dist(best.pos, from)) best = s;
    left.splice(left.indexOf(best), 1);
    return best;
  };
  const route: Stop[] = [pickNearest(city.spawn.pos, 30)];
  while (route.length < Math.min(opts.count, city.stops.length)) route.push(pickNearest(route[route.length - 1].pos, MIN_STOP_SPACING));
  return route.map((stop) => {
    const r = right(stop.heading);
    return { stop, zone: { x: stop.pos.x - r.x * 4.2, z: stop.pos.z - r.z * 4.2 } };
  });
}

/**
 * Crazy-Taxi-style route rules, engine-agnostic: stops are served in order; passengers board
 * at one stop and pay (fare + speed tip) when dropped at theirs; quick legs buy extra time.
 */
export class RouteGame {
  timeLeft = START_TIME;
  cents = 0;
  delivered = 0;
  activeIndex = 0;
  over = false;
  onBoard: Passenger[] = [];
  private started = false;
  private clock = 0;
  private legTime = 0;
  private legFrom: Vec2;
  private warned = false;
  private waiting: Passenger[][];
  private rng: Rng;
  private nextId = 1;

  constructor(
    readonly route: RouteStop[],
    private opts: { seed: number; capacity: number; start: Vec2 },
  ) {
    this.rng = new Rng(opts.seed);
    this.legFrom = opts.start;
    this.waiting = route.map((_, i) => this.spawnPassengers(i));
  }

  get activeStop(): RouteStop {
    return this.route[this.activeIndex];
  }

  waitingAt(i: number): Passenger[] {
    return this.waiting[i];
  }

  /** Seconds a leg "should" take; beating it earns bonus time. */
  legPar(from: Vec2, to: Vec2): number {
    return (dist(from, to) * DETOUR) / 10 + 5;
  }

  start(): void {
    this.started = true;
  }

  addCents(c: number): void {
    this.cents += c;
  }

  update(dt: number, bus: { pos: Vec2; speed: number }): GameEvent[] {
    if (!this.started || this.over) return [];
    const out: GameEvent[] = [];
    this.clock += dt;
    this.legTime += dt;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.over = true;
      return [{ type: 'gameOver' }];
    }

    for (const p of this.onBoard) {
      if (!p.impatient && this.clock - p.boardedAt > p.budget) {
        p.impatient = true;
        out.push({ type: 'impatient', passenger: p });
      }
    }

    const d = dist(bus.pos, this.activeStop.zone);
    if (!this.warned && d < APPROACH_DIST) {
      this.warned = true;
      const count = this.onBoard.filter((p) => p.to === this.activeIndex).length;
      if (count) out.push({ type: 'approach', stopIndex: this.activeIndex, count });
    }
    if (d < ZONE_RADIUS && Math.abs(bus.speed) < STOP_SPEED) out.push(...this.service());
    return out;
  }

  private service(): GameEvent[] {
    const out: GameEvent[] = [];
    const i = this.activeIndex;
    const here = this.activeStop.zone;

    const alighted = this.onBoard.filter((p) => p.to === i);
    this.onBoard = this.onBoard.filter((p) => p.to !== i);
    for (const p of alighted) {
      const ride = this.clock - p.boardedAt;
      const rating: Rating = ride <= p.budget * 0.6 ? 'fast' : ride <= p.budget ? 'ok' : 'slow';
      const cents = FARE_CENTS + TIPS[rating];
      this.cents += cents;
      this.delivered++;
      out.push({ type: 'fare', passenger: p, cents, rating });
    }

    const room = Math.max(0, this.opts.capacity - this.onBoard.length);
    const boarded = this.waiting[i].slice(0, room);
    this.waiting[i] = this.waiting[i].slice(room);
    for (const p of boarded) p.boardedAt = this.clock;
    this.onBoard.push(...boarded);
    const spawned = this.spawnPassengers(i);
    this.waiting[i].push(...spawned);

    const par = this.legPar(this.legFrom, here);
    const rating: Rating = this.legTime <= par * 0.7 ? 'fast' : this.legTime <= par ? 'ok' : 'slow';
    const timeBonus = TIME_BONUS[rating];
    this.timeLeft += timeBonus;
    out.push({ type: 'arrive', stopIndex: i, boarded, alighted, spawned, timeBonus, rating });

    this.activeIndex = (i + 1) % this.route.length;
    this.legFrom = here;
    this.legTime = 0;
    this.warned = false;
    return out;
  }

  private spawnPassengers(from: number): Passenger[] {
    const n = this.route.length;
    return Array.from({ length: this.rng.int(1, 3) }, () => {
      const hops = this.rng.int(1, Math.min(3, n - 1));
      const to = (from + hops) % n;
      let path = 0;
      for (let k = 0; k < hops; k++) path += dist(this.route[(from + k) % n].zone, this.route[(from + k + 1) % n].zone);
      return {
        id: this.nextId++,
        from,
        to,
        budget: (path * DETOUR) / 9 + 6 * hops,
        boardedAt: 0,
        look: this.rng.next(),
        impatient: false,
      };
    });
  }
}
