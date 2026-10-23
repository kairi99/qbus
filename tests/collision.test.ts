import { appendFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { addGround, createWorld, initRapier, PHYSICS_STEP, type RAPIER } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { BUMP, BumpTracker, bumpImpulse, sideGain, type V3 } from '../src/physics/bump';
import { RemoteBus } from '../src/net/remoteBus';
import { carState } from '../src/net/snapshots';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';
import interparroquial from '../data/buses/interparroquial.json';
import ae86 from '../data/buses/ae86.json';
import articulado from '../data/buses/articulado.json';
import trailer from '../data/buses/trailer.json';

const KMH = 1 / 3.6;
const PRESETS = { popular, interparroquial, ae86, articulado, trailer } as unknown as Record<string, BusPreset>;
/** One-way network delay in the two-client runs (s). */
const LATENCY = 0.06;

export interface Outcome {
  /** Speed along +X (km/h) just before contact and 0.6 s after it. */
  hitterBefore: number;
  hitterAfter: number;
  targetBefore: number;
  targetAfter: number;
  /** Same, 0.25 s after contact (just past the impact, before the engines push the two back together). */
  hitter25: number;
  target25: number;
  /** Sideways travel of the target in the 1.5 s after contact (m, toward +Z). */
  targetDz: number;
  /** Largest sideways speed (m/s) each got in the second after contact. */
  hitterLat: number;
  targetLat: number;
  /** Largest upward speed after contact (m/s). */
  maxUp: number;
  /** Largest yaw rate (rad/s) after contact. */
  maxYaw: number;
  touched: boolean;
  /** Bumps applied (total over both clients). */
  hits: number;
  /** ... within 0.3 s of the first one (one per client, however many saw the hit). */
  firstHits: number;
}

type Mode = 'local' | 'online' | 'plain';
const idle = { throttle: 0, steer: 0, handbrake: false };

/** Holds `kmh` with the throttle (never brakes). */
const hold = (bus: BusPhysics, kmh: number) => ({ throttle: Math.max(0, Math.min(1, (kmh * KMH - bus.speed) * 0.6 + 0.3)), steer: 0, handbrake: false });

interface Setup {
  hitterKmh: number;
  targetKmh: number;
  hx: number;
  tz: number;
  heading: number;
}

function setup(hitterP: BusPreset, targetP: BusPreset, kind: 'rear' | 'side'): Setup {
  const targetKmh = kind === 'rear' ? 60 : 70;
  const hitterKmh = kind === 'rear' ? 90 : 70;
  const lf = targetP.body.length;
  const lh = hitterP.body.length;
  return {
    hitterKmh,
    targetKmh,
    hx: kind === 'rear' ? -(lf / 2 + lh / 2 + 14) : 0,
    // Side by side, the hitter's corners swung out by its heading: start clear of the target, converge from there.
    tz: kind === 'side' ? targetP.body.width / 2 + hitterP.body.width / 2 + (hitterP.body.length / 2) * Math.sin((15 * Math.PI) / 180) + 1.2 : 0,
    heading: kind === 'side' ? (-15 * Math.PI) / 180 : 0,
  };
}

const spawnAt = (world: RAPIER.World, p: BusPreset, x: number, z: number, heading: number) => new BusPhysics(world, p, { x, y: 1.5, z, heading });
const settle = (world: RAPIER.World, ...buses: BusPhysics[]) => {
  for (let t = 0; t < 1.2; t += PHYSICS_STEP) {
    for (const b of buses) b.update(idle, PHYSICS_STEP);
    world.step();
  }
};

const setV = (b: BusPhysics, v: number, h: number) => {
  for (const body of b.bodies) body.setLinvel({ x: Math.cos(h) * v, y: 0, z: -Math.sin(h) * v }, true);
};

/** Both vehicles in one world (a local race against an AI rival); `plain`: Rapier alone, no bump layer. */
function runLocal(hp: BusPreset, tp: BusPreset, kind: 'rear' | 'side', plain: boolean): Outcome {
  const world = createWorld();
  addGround(world, 3000);
  const s = setup(hp, tp, kind);
  const target = spawnAt(world, tp, 0, s.tz, 0);
  const hitter = spawnAt(world, hp, s.hx, 0, s.heading);
  settle(world, target, hitter);
  const bump = new BumpTracker(world);
  bump.own.push({ key: 'h', bus: hitter }, { key: 't', bus: target });
  if (plain) bump.own.length = 0;
  setV(hitter, s.hitterKmh * KMH, s.heading);
  setV(target, s.targetKmh * KMH, 0);
  const out = blank(s);
  let contact = -1;
  for (let t = 0; t < 10; t += PHYSICS_STEP) {
    hitter.update(hold(hitter, s.hitterKmh), PHYSICS_STEP);
    target.update(hold(target, s.targetKmh), PHYSICS_STEP);
    if (contact < 0) (out.hitterBefore = hitter.body.linvel().x / KMH), (out.targetBefore = target.body.linvel().x / KMH);
    bump.before();
    world.step();
    bump.after(PHYSICS_STEP);
    if (contact < 0) {
      let hit = false;
      for (const a of hitter.colliders) for (const b of target.colliders) world.contactPair(a, b, () => (hit = true));
      if (hit) contact = t;
    }
    if (contact >= 0 && sample(out, t - contact, hitter, target)) break;
  }
  out.touched = contact >= 0;
  out.hits = bump.hits;
  return out;
}

function blank(s: Setup): Outcome {
  return { hitterBefore: s.hitterKmh, hitterAfter: s.hitterKmh, targetBefore: s.targetKmh, targetAfter: s.targetKmh, hitter25: s.hitterKmh, target25: s.targetKmh, targetDz: 0, hitterLat: 0, targetLat: 0, maxUp: 0, maxYaw: 0, touched: false, hits: 0, firstHits: 0 };
}

const WINDOW = 1.5;
let dz0 = 0;
/** Records the outcome `age` s after contact; true once the window is over. */
function sample(out: Outcome, age: number, h: BusPhysics, t: BusPhysics): boolean {
  if (age < PHYSICS_STEP) dz0 = t.body.translation().z;
  track(out, [h], [t]);
  const done = (k: 'hitter25' | 'target25' | 'hitterAfter' | 'targetAfter', b: BusPhysics) => (out[k] = b.body.linvel().x / KMH);
  if (age <= 0.25) (done('hitter25', h), done('target25', t));
  if (age <= 0.6) (done('hitterAfter', h), done('targetAfter', t));
  out.targetDz = t.body.translation().z - dz0;
  return age >= WINDOW;
}

function track(out: Outcome, h: BusPhysics[], t: BusPhysics[]): void {
  out.hitterLat = Math.max(out.hitterLat, Math.abs(h[0].body.linvel().z));
  out.targetLat = Math.max(out.targetLat, Math.abs(t[0].body.linvel().z));
  for (const b of [...h, ...t]) {
    out.maxUp = Math.max(out.maxUp, b.body.linvel().y);
    out.maxYaw = Math.max(out.maxYaw, Math.abs(b.body.angvel().y));
  }
}

/** One player's world in an online race: its own bus, the other as a remote, a bump layer, a wire to the other. */
class Client {
  world = createWorld();
  own!: BusPhysics;
  remote!: RemoteBus;
  bump = new BumpTracker(this.world);
  key: string;
  other: string;
  kmh: number;
  acc = 0;
  sendQ: { at: number; fn: () => void }[] = [];
  constructor(key: string, other: string, kmh: number) {
    this.key = key;
    this.other = other;
    this.kmh = kmh;
    addGround(this.world, 3000);
  }
}

/** Two clients, each simulating its own bus and seeing the other as a remote fed by 15 Hz snapshots + bump messages over a 60 ms wire. */
function runOnline(hp: BusPreset, tp: BusPreset, kind: 'rear' | 'side'): Outcome {
  const s = setup(hp, tp, kind);
  const A = new Client('s0', 's1', s.hitterKmh);
  const B = new Client('s1', 's0', s.targetKmh);
  A.own = spawnAt(A.world, hp, s.hx, 0, s.heading);
  B.own = spawnAt(B.world, tp, 0, s.tz, 0);
  settle(A.world, A.own);
  settle(B.world, B.own);
  A.remote = new RemoteBus(A.world, tp, { x: 0, y: 1.5, z: s.tz, heading: 0 });
  B.remote = new RemoteBus(B.world, hp, { x: s.hx, y: 1.5, z: 0, heading: s.heading });
  const farOf = (c: Client) => ({ key: c.other, bus: (c === A ? A : B).remote.bus, get vel() { return (c === A ? A : B).remote.vel; }, shove: (dv: V3) => (c === A ? A : B).remote.shove(dv) });
  for (const c of [A, B]) {
    c.bump.own.push({ key: c.key, bus: c.own });
    c.bump.far.push(farOf(c));
    const peer = c === A ? B : A;
    c.bump.send = (to, from, j, at) => {
      const jj = { ...j };
      const aa = { ...at };
      c.sendQ.push({ at: now + LATENCY, fn: () => peer.bump.receive(from, to, jj, aa) });
    };
  }
  setV(A.own, s.hitterKmh * KMH, s.heading);
  setV(B.own, s.targetKmh * KMH, 0);
  let now = 0;
  const out = blank(s);
  const snap = [undefined, undefined] as (ReturnType<typeof carState> | undefined)[];
  const queue: { at: number; fn: () => void }[] = [];
  let contact = -1;
  for (let step = 0; step < 900; step++) {
    now = step * PHYSICS_STEP;
    if (contact < 0) (out.hitterBefore = A.own.body.linvel().x / KMH), (out.targetBefore = B.own.body.linvel().x / KMH);
    [A, B].forEach((c, i) => {
      const peer = c === A ? B : A;
      c.own.update(hold(c.own, c.kmh), PHYSICS_STEP);
      c.remote.apply(now * 1000 - 0 + 0, PHYSICS_STEP);
      c.bump.before();
      c.world.step();
      c.bump.after(PHYSICS_STEP);
      if (step % 4 === 0) {
        const car = JSON.parse(JSON.stringify(carState(c.own, { seat: i }, 0, 1, snap[i])));
        snap[i] = undefined;
        queue.push({ at: now + LATENCY, fn: () => peer.remote.push(now * 1000 + 0, car) });
        const at = now * 1000;
        queue[queue.length - 1].fn = () => peer.remote.push(at, car);
      }
      for (const m of c.sendQ.splice(0)) queue.push(m);
    });
    for (let k = queue.length - 1; k >= 0; k--) if (queue[k].at <= now) queue.splice(k, 1)[0].fn();
    if (contact < 0 && A.bump.hits + B.bump.hits > 0) contact = now;
    if (contact >= 0 && now - contact <= 0.3) out.firstHits = A.bump.hits + B.bump.hits;
    if (contact >= 0 && sample(out, now - contact, A.own, B.own)) break;
  }
  out.touched = contact >= 0;
  out.hits = A.bump.hits + B.bump.hits;
  return out;
}

export function scenario(h: string, t: string, kind: 'rear' | 'side', mode: Mode): Outcome {
  return mode === 'online' ? runOnline(PRESETS[h], PRESETS[t], kind) : runLocal(PRESETS[h], PRESETS[t], kind, mode === 'plain');
}

const PAIRS: [string, string][] = [
  ['popular', 'popular'],
  ['interparroquial', 'popular'],
  ['ae86', 'popular'],
  ['popular', 'ae86'],
  ['articulado', 'ae86'],
  ['popular', 'articulado'],
];

const table = (mode: Mode, kind: 'rear' | 'side', h: string, t: string, o: Outcome) => {
  const f = (n: number) => n.toFixed(1).padStart(6);
  appendFileSync(process.env.ROWS ?? '/dev/null', `ROW ${mode.padEnd(6)} ${kind.padEnd(4)} ${h.padEnd(15)}->${t.padEnd(15)} hitter ${f(o.hitterBefore)}->${f(o.hitter25)} ${f(o.hitterAfter)}  target ${f(o.targetBefore)}->${f(o.target25)} ${f(o.targetAfter)} dz ${f(o.targetDz)}  latPk h/t ${f(o.hitterLat)} ${f(o.targetLat)} yaw ${f(o.maxYaw)} up ${f(o.maxUp)} hits ${o.hits}\n`);
};

describe('vehicle collisions: arcade bumps instead of a dead stop', () => {
  beforeAll(() => initRapier());

  // Rear-ending: the rear one keeps most of its speed, the one in front gets a real shove forward.
  for (const mode of ['local', 'online'] as const)
    for (const [h, t] of PAIRS)
      it(`${mode} rear-end: ${h} into ${t}`, () => {
        const o = scenario(h, t, 'rear', mode);
        table(mode, 'rear', h, t, o);
        expect(o.touched).toBe(true);
        expect(o.hitter25).toBeGreaterThan(o.hitterBefore * 0.5);
        expect(o.hitter25).toBeLessThan(o.hitterBefore);
        expect(o.target25 - o.targetBefore).toBeGreaterThan(8);
        expect(o.maxUp).toBeLessThan(1);
        expect(o.maxYaw).toBeLessThan(3);
        // Online each client counts the hit once: two bumps (its own, the other's) per collision.
        if (mode === 'online') expect(o.firstHits).toBe(2);
      });

  // Side by side, converging at 15 deg: the one hit is pushed over, more for a heavier hitter.
  for (const mode of ['local', 'online'] as const)
    for (const [h, t, dz] of [['popular', 'popular', 3.2], ['interparroquial', 'popular', 3.2], ['popular', 'ae86', 3.2], ['articulado', 'ae86', 4]] as [string, string, number][])
      it(`${mode} side swipe: ${h} into ${t}`, () => {
        const o = scenario(h, t, 'side', mode);
        table(mode, 'side', h, t, o);
        expect(o.touched).toBe(true);
        expect(o.targetDz).toBeGreaterThan(dz);
        expect(o.maxUp).toBeLessThan(1);
        expect(o.maxYaw).toBeLessThan(3);
      });

  // The container truck: shoves a car hard (it is nine tonnes), and is hardly moved by one.
  it('the truck rear-ends a car: the car is flung ahead, the truck keeps rolling', () => {
    const o = scenario('trailer', 'ae86', 'rear', 'local');
    expect(o.touched).toBe(true);
    expect(o.hitter25).toBeGreaterThan(o.hitterBefore * 0.8);
    expect(o.target25 - o.targetBefore).toBeGreaterThan(12);
    expect(o.maxUp).toBeLessThan(1);
    expect(o.maxYaw).toBeLessThan(3);
  });
  it('a car rear-ends the truck: the car bounces off, the truck barely notices', () => {
    const o = scenario('ae86', 'trailer', 'rear', 'local');
    expect(o.touched).toBe(true);
    expect(Math.abs(o.target25 - o.targetBefore)).toBeLessThan(4);
    expect(o.hitter25).toBeLessThan(o.hitterBefore * 0.9);
    expect(o.maxUp).toBeLessThan(1);
  });

  it('a ghost bumps nothing and nothing bumps it', () => {
    const world = createWorld();
    addGround(world, 500);
    const a = spawnAt(world, popular as BusPreset, 0, 0, 0);
    const b = spawnAt(world, popular as BusPreset, 4, 0, 0);
    settle(world, a, b);
    a.setGhost(true);
    const bump = new BumpTracker(world);
    bump.own.push({ key: 'a', bus: a }, { key: 'b', bus: b });
    setV(a, 10, 0);
    for (let i = 0; i < 60; i++) {
      bump.before();
      world.step();
      bump.after(PHYSICS_STEP);
    }
    expect(bump.hits).toBe(0);
    expect(bump.receive('x', 'a', { x: 5000, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(false);
  });

  it('a bump received twice, or after our own detection, counts once', () => {
    const world = createWorld();
    addGround(world, 500);
    const a = spawnAt(world, popular as BusPreset, 0, 0, 0);
    settle(world, a);
    const bump = new BumpTracker(world);
    bump.own.push({ key: 'a', bus: a });
    const v0 = a.body.linvel().x;
    expect(bump.receive('b', 'a', { x: 7500, y: 0, z: 0 }, a.body.translation())).toBe(true);
    expect(bump.receive('b', 'a', { x: 7500, y: 0, z: 0 }, a.body.translation())).toBe(false);
    world.step();
    expect(a.body.linvel().x - v0).toBeGreaterThan(4);
    // Nonsense is refused: NaN, and a shove no collision could give.
    for (let i = 0; i < 60; i++) bump.after(PHYSICS_STEP);
    expect(bump.receive('b', 'a', { x: NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(false);
    expect(bump.receive('b', 'a', { x: 5e7, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(false);
  });
});

describe('bumpImpulse', () => {
  it('two equal masses swap speeds, with the bounce on top of sticking', () => {
    const stick = bumpImpulse(1000, 1000, 8, 0);
    expect(stick).toBeCloseTo(4000, 6);
    expect(bumpImpulse(1000, 1000, 8, BUMP.restitution)).toBeCloseTo(4000 * (1 + BUMP.restitution), 6);
  });
  it('is the same from either side, and a light car meets a heavy bus as if the bus were a wall', () => {
    expect(bumpImpulse(1500, 520, 10)).toBeCloseTo(bumpImpulse(520, 1500, 10), 9);
    const j = bumpImpulse(520, 1e9, 4);
    expect(j / 520).toBeCloseTo(4 * (1 + BUMP.restitution), 3);
  });
  it('a nudge or a separating pair is nothing; a crash is capped on the lighter one', () => {
    expect(bumpImpulse(1000, 1000, BUMP.minClosing - 0.1)).toBe(0);
    expect(bumpImpulse(1000, 1000, -5)).toBe(0);
    expect(bumpImpulse(1000, 1000, 80) / 1000).toBeLessThanOrEqual(BUMP.maxDv + 1e-9);
    expect(bumpImpulse(0, 1000, 8)).toBe(0);
  });
  it('a broadside hit earns the side gain, a nose-to-tail one none', () => {
    expect(sideGain(0, 0, { x: 1, z: 0 })).toBeCloseTo(1, 9);
    expect(sideGain(0, 0, { x: 0, z: 1 })).toBeCloseTo(BUMP.sideGain, 9);
    expect(sideGain(Math.PI / 2, 0, { x: 1, z: 0 })).toBeCloseTo(BUMP.sideGain, 9);
  });
});
