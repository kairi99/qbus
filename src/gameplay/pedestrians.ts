import { Rng } from '../core/rng';
import type { CityData, Vec2 } from '../world/cityData';
import { forward, right } from '../world/cityData';
import { bbox, pointInPolygon } from '../world/geom';

export interface BusState {
  pos: Vec2;
  heading: number;
  /** Signed forward speed, m/s. */
  speed: number;
}

type Mode = 'walk' | 'cross' | 'dive' | 'recover';

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
  block: number;
  /** Distance along the block's walking ring. */
  u: number;
  dir: 1 | -1;
  target: Vec2 | null;
  timer: number;
  diveFrom: Vec2 | null;
  /** Where to head once a dive is over (the crossing target, or back to the ring). */
  resume: Vec2 | null;
}

/** Walkers keep this far from the curb, which puts them on the zebra stripes at corners. */
const RING_INSET = 1.8;
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

interface Ring {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  perimeter: number;
}

/**
 * Sidewalk life, engine-agnostic: people loop around blocks, cross at the zebra crossings at
 * corners, and dive out of the way of a bus coming at them. They have no colliders on purpose.
 */
export class PedestrianSim {
  peds: Pedestrian[] = [];
  private rings: Ring[];
  private rng: Rng;

  constructor(
    private city: CityData,
    opts: { seed: number; count: number },
  ) {
    this.rng = new Rng(opts.seed);
    // Blocks are axis-aligned rectangles in generated cities; OSM blocks will need real insets.
    this.rings = city.blocks.map((b) => {
      const { min, max } = bbox(b.footprint);
      const r = { x0: min.x + RING_INSET, z0: min.z + RING_INSET, x1: max.x - RING_INSET, z1: max.z - RING_INSET, perimeter: 0 };
      r.perimeter = 2 * (r.x1 - r.x0 + (r.z1 - r.z0));
      return r;
    });
    for (let i = 0; i < opts.count; i++) {
      const block = this.rng.int(0, this.rings.length - 1);
      const u = this.rng.range(0, this.rings[block].perimeter);
      const p: Pedestrian = {
        id: i,
        pos: ringPoint(this.rings[block], u),
        heading: 0,
        speed: this.rng.range(...WALK_SPEED),
        mode: 'walk',
        onRoad: false,
        look: this.rng.next(),
        hop: 0,
        lean: 0,
        block,
        u,
        dir: this.rng.chance(0.5) ? 1 : -1,
        target: null,
        timer: 0,
        diveFrom: null,
        resume: null,
      };
      this.peds.push(p);
    }
  }

  step(dt: number, bus: BusState): { dives: number } {
    let dives = 0;
    for (const p of this.peds) {
      if (p.mode !== 'dive' && p.mode !== 'recover' && this.threatened(p, bus)) {
        this.startDive(p, bus);
        dives++;
      }
      switch (p.mode) {
        case 'walk':
          this.walk(p, dt);
          break;
        case 'cross':
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
            p.mode = 'cross'; // walk to wherever we were headed (a crossing, or back to the ring)
            p.target = p.resume;
            p.speed = RUN_SPEED * 0.6;
          }
          break;
      }
      p.onRoad = p.mode !== 'walk' && !this.city.blocks.some((b) => pointInPolygon(p.pos, b.footprint));
    }
    return { dives };
  }

  /** Moves walkers that fell out of the bubble around the bus onto nearby sidewalks, out of sight. */
  recycle(focus: { pos: Vec2; heading: number }, fill = false): void {
    const f = forward(focus.heading);
    const near = this.rings
      .map((r, i) => ({ r, i, d: Math.hypot((r.x0 + r.x1) / 2 - focus.pos.x, (r.z0 + r.z1) / 2 - focus.pos.z) }))
      .filter((b) => b.d < PED_RECYCLE_RADIUS - 40);
    if (!near.length) return;
    for (const p of this.peds) {
      if (!fill && Math.hypot(p.pos.x - focus.pos.x, p.pos.z - focus.pos.z) < PED_RECYCLE_RADIUS) continue;
      for (let attempt = 0; attempt < 30; attempt++) {
        const b = this.rng.pick(near);
        const u = this.rng.range(0, b.r.perimeter);
        const q = ringPoint(b.r, u);
        const rel = { x: q.x - focus.pos.x, z: q.z - focus.pos.z };
        const d = Math.hypot(rel.x, rel.z);
        const hidden = d > 100 || rel.x * f.x + rel.z * f.z < 0;
        if (d > PED_RECYCLE_RADIUS - 5 || (!fill && (!hidden || d < PED_SPAWN_MIN))) continue;
        Object.assign(p, { block: b.i, u, pos: q, mode: 'walk', target: null, resume: null, hop: 0, lean: 0, onRoad: false });
        break;
      }
    }
  }

  /** Honked at: anyone near `pos` on the road runs. */
  honk(pos: Vec2): void {
    for (const p of this.peds) {
      if (p.mode === 'cross' && Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z) < 35) p.speed = Math.max(p.speed, RUN_SPEED);
    }
  }

  private walk(p: Pedestrian, dt: number): void {
    const ring = this.rings[p.block];
    const before = p.u;
    p.u = mod(p.u + p.dir * p.speed * dt, ring.perimeter);
    const corners = cornerParams(ring);
    // Passed a corner this step?
    const passed = corners.find((c) => (p.dir > 0 ? between(before, p.u, c, ring.perimeter) : between(p.u, before, c, ring.perimeter)));
    const next = ringPoint(ring, p.u);
    p.heading = Math.atan2(-(next.z - p.pos.z), next.x - p.pos.x);
    p.pos = next;
    if (passed !== undefined && this.rng.chance(CROSS_CHANCE)) this.tryCross(p, ringPoint(ring, passed));
  }

  /** From a ring corner, cross to the facing block along x or z (zebra crossings are right there). */
  private tryCross(p: Pedestrian, corner: Vec2): void {
    const ring = this.rings[p.block];
    const cx = (ring.x0 + ring.x1) / 2;
    const cz = (ring.z0 + ring.z1) / 2;
    const options: { to: Vec2; block: number }[] = [];
    const sx = Math.sign(corner.x - cx);
    const sz = Math.sign(corner.z - cz);
    this.rings.forEach((r, i) => {
      if (i === p.block) return;
      // Across along x: same z band, next block over.
      if (Math.abs(r.z0 - ring.z0) < 1 && Math.abs(r.z1 - ring.z1) < 1) {
        const x = sx > 0 ? r.x0 : r.x1;
        const gap = (x - corner.x) * sx;
        if (gap > 0 && gap < 30) options.push({ to: { x, z: corner.z }, block: i });
      }
      if (Math.abs(r.x0 - ring.x0) < 1 && Math.abs(r.x1 - ring.x1) < 1) {
        const z = sz > 0 ? r.z0 : r.z1;
        const gap = (z - corner.z) * sz;
        if (gap > 0 && gap < 30) options.push({ to: { x: corner.x, z }, block: i });
      }
    });
    const nearest = (axis: 'x' | 'z') =>
      options.filter((o) => o.to[axis === 'x' ? 'z' : 'x'] === corner[axis === 'x' ? 'z' : 'x']).sort((a, b) => dist(a.to, corner) - dist(b.to, corner))[0];
    const pick = [nearest('x'), nearest('z')].filter(Boolean);
    if (!pick.length) return;
    const o = this.rng.pick(pick);
    p.pos = corner;
    p.mode = 'cross';
    p.target = o.to;
    p.resume = o.to;
    p.block = o.block;
  }

  private arrive(p: Pedestrian): void {
    const ring = this.rings[p.block];
    p.mode = 'walk';
    p.speed = this.rng.range(...WALK_SPEED);
    p.u = project(ring, p.pos);
    p.pos = ringPoint(ring, p.u);
    p.dir = this.rng.chance(0.5) ? 1 : -1;
    p.target = p.resume = null;
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
    const dirSign = Math.sign(bus.speed);
    const rel = { x: p.pos.x - bus.pos.x, z: p.pos.z - bus.pos.z };
    const ahead = (rel.x * f.x + rel.z * f.z) * dirSign;
    const lateral = Math.abs(rel.x * f.z - rel.z * f.x);
    return ahead > -2 && ahead < BUS_NOSE + 0.5 + Math.abs(bus.speed) * REACTION_TIME && lateral < 2.4;
  }

  private startDive(p: Pedestrian, bus: BusState): void {
    const r = right(bus.heading);
    const rel = { x: p.pos.x - bus.pos.x, z: p.pos.z - bus.pos.z };
    let side = Math.sign(rel.x * r.x + rel.z * r.z) || (this.rng.chance(0.5) ? 1 : -1);
    const land = (s: number, d: number) => ({ x: p.pos.x + r.x * s * d, z: p.pos.z + r.z * s * d });
    const blocked = (q: Vec2) => this.city.buildings.some((b) => pointInPolygon(q, b.footprint));
    let dist = DIVE_DIST;
    if (blocked(land(side, dist))) side = -side;
    while (dist > 0.8 && blocked(land(side, dist))) dist -= 0.4;
    p.resume = p.mode === 'cross' ? p.target : ringPoint(this.rings[p.block], p.u);
    p.diveFrom = { ...p.pos };
    p.target = land(side, dist);
    p.mode = 'dive';
    p.timer = 0;
  }
}

function ringPoint(r: Ring, u: number): Vec2 {
  const w = r.x1 - r.x0;
  const h = r.z1 - r.z0;
  u = mod(u, r.perimeter);
  if (u < w) return { x: r.x0 + u, z: r.z0 };
  if ((u -= w) < h) return { x: r.x1, z: r.z0 + u };
  if ((u -= h) < w) return { x: r.x1 - u, z: r.z1 };
  u -= w;
  return { x: r.x0, z: r.z1 - u };
}

function cornerParams(r: Ring): number[] {
  const w = r.x1 - r.x0;
  const h = r.z1 - r.z0;
  return [0, w, w + h, 2 * w + h];
}

/** Ring parameter of the ring point closest to `p`. */
function project(r: Ring, p: Vec2): number {
  let best = 0;
  let bestD = Infinity;
  for (let u = 0; u < r.perimeter; u += 0.5) {
    const q = ringPoint(r, u);
    const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    if (d < bestD) (bestD = d), (best = u);
  }
  return best;
}

/** Is `c` in the half-open arc (a, b] going forward around a loop of length `len`? */
function between(a: number, b: number, c: number, len: number): boolean {
  const span = mod(b - a, len);
  const off = mod(c - a, len);
  return off > 0 && off <= span;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
