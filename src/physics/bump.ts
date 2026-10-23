import type { RAPIER } from './world';
import type { BusPhysics } from '../vehicle/bus';

/**
 * Arcade collisions between vehicles (no three.js: runs in Node tests).
 *
 * Rapier alone makes a vehicle crash plastic (restitution 0, tires scrubbing sideways speed) and
 * a remote player's kinematic bus has infinite mass, so hitting one from behind stopped you dead.
 * Here a vehicle-vehicle hit is a two-body collision with both masses and a bounce:
 *   - two local dynamic vehicles (player and AI): Rapier still solves the contact (they stay
 *     apart), and the bounce it lacks is added right after (`restitution` of the closing speed);
 *   - a local vehicle and a remote one (`BusPhysics.makeRemote`: contacts detected, not solved):
 *     the whole collision is computed from the remote's measured velocity; the local one takes its
 *     share, the remote's share is predicted at once on the screen (`BumpFar.shove`) and sent to
 *     its owner as a bump, who applies it to the real bus.
 * Both ends see the hit from their own view: each applies its own share once, and a pair stays
 * quiet for `cooldown` after a bump was applied or received, so nothing counts twice.
 */
export const BUMP = {
  /** Bounce: share of the closing speed that comes back apart. */
  restitution: 0.45,
  /** Slower closing (m/s) than this is a nudge: no bump. */
  minClosing: 1.5,
  /** A pair stays quiet this long (s) after a bump. */
  cooldown: 0.5,
  /** One bump never changes the lighter vehicle's speed by more than this (m/s). */
  maxDv: 14,
  /** A hit square on the side counts this much more (the tires scrub a sideways shove away, and a bus pushed toward the rail is the point). */
  sideGain: 1.6,
  /** Contacts closer than this (m) count as touching. */
  reach: 0.06,
};

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Impulse (N s) along the normal of two bodies of masses `m1`, `m2` closing at `closing` m/s, with a bounce `e` (0: they stick). 0 when not closing fast enough. */
export function bumpImpulse(m1: number, m2: number, closing: number, e: number = BUMP.restitution): number {
  if (!(closing > BUMP.minClosing) || !(m1 > 0) || !(m2 > 0)) return 0;
  const j = (1 + e) * closing * ((m1 * m2) / (m1 + m2));
  return Math.min(j, BUMP.maxDv * Math.min(m1, m2));
}

/** How square on the side of `a` or `b` the hit along `n` is (1: broadside, 0: nose or tail): the gain it earns. */
export function sideGain(headingA: number, headingB: number, n: { x: number; z: number }): number {
  const sa = Math.abs(n.x * Math.sin(headingA) + n.z * Math.cos(headingA));
  const sb = Math.abs(n.x * Math.sin(headingB) + n.z * Math.cos(headingB));
  return 1 + (BUMP.sideGain - 1) * Math.max(sa, sb);
}

/** A vehicle simulated here. */
export interface BumpOwn {
  key: string;
  bus: BusPhysics;
}

/** A vehicle moved from the network: contacts detected, no force exchanged. */
export interface BumpFar {
  key: string;
  bus: BusPhysics;
  /** Its velocity now (m/s), measured from its poses. */
  vel: V3;
  /** Shows the shove its owner will give it (m/s, immediately, until the real one arrives in its snapshots). */
  shove(dv: V3): void;
}

export type BumpSend = (to: string, from: string, j: V3, at: V3) => void;

interface Mem {
  v: V3;
  v2: V3;
}

const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Detects vehicle-vehicle hits each step (call `before()` ahead of `world.step()`, `after(dt)` behind it). */
export class BumpTracker {
  readonly own: BumpOwn[] = [];
  readonly far: BumpFar[] = [];
  /** Where a remote's share goes (to its owner); unset: only the local share is applied. */
  send: BumpSend | null = null;
  /** Hits applied or received so far (tests, debugging). */
  hits = 0;
  private time = 0;
  private quiet = new Map<string, number>();
  private mem = new Map<string, Mem>();
  // Scratch (no per-step allocation).
  private n: V3 = { x: 0, y: 0, z: 0 };
  private at: V3 = { x: 0, y: 0, z: 0 };
  private j: V3 = { x: 0, y: 0, z: 0 };
  private dv: V3 = { x: 0, y: 0, z: 0 };
  private va: V3 = { x: 0, y: 0, z: 0 };
  private vb: V3 = { x: 0, y: 0, z: 0 };
  private tmp = { x: 0, y: 0, z: 0 };
  private curA: RAPIER.Collider | null = null;
  private curB: RAPIER.Collider | null = null;
  private found = false;
  private bestDist = Infinity;
  private readonly onManifold = (m: RAPIER.TempContactManifold, flipped: boolean): void => {
    for (let i = 0, k = m.numContacts(); i < k; i++) {
      const d = m.contactDist(i);
      if (d > BUMP.reach || d >= this.bestDist) continue;
      const p = m.localContactPoint1(i, this.tmp);
      const c = flipped ? this.curB : this.curA;
      const body = c?.parent();
      if (!p || !body) continue;
      const t = body.translation();
      const q = body.rotation();
      // World point = t + q * local.
      const ux = q.y * p.z - q.z * p.y;
      const uy = q.z * p.x - q.x * p.z;
      const uz = q.x * p.y - q.y * p.x;
      this.at.x = t.x + p.x + 2 * (q.w * ux + q.y * uz - q.z * uy);
      this.at.y = t.y + p.y + 2 * (q.w * uy + q.z * ux - q.x * uz);
      this.at.z = t.z + p.z + 2 * (q.w * uz + q.x * uy - q.y * ux);
      m.normal(this.n);
      this.bestDist = d;
      this.found = true;
    }
  };

  constructor(private world: RAPIER.World) {}

  /** Velocities before the step (a contact solved in the step has already changed them after it). */
  before(): void {
    for (const o of this.own) {
      let m = this.mem.get(o.key);
      if (!m) this.mem.set(o.key, (m = { v: { x: 0, y: 0, z: 0 }, v2: { x: 0, y: 0, z: 0 } }));
      m.v2.x = m.v.x;
      m.v2.y = m.v.y;
      m.v2.z = m.v.z;
      const v = o.bus.body.linvel();
      m.v.x = v.x;
      m.v.y = v.y;
      m.v.z = v.z;
    }
  }

  /** After the step: bumps for every touching pair that is closing. */
  after(dt: number): void {
    this.time += dt;
    const { own, far } = this;
    for (let a = 0; a < own.length; a++) {
      const A = own[a];
      if (A.bus.ghost) continue;
      for (let b = a + 1; b < own.length; b++) {
        const B = own[b];
        if (B.bus.ghost || !this.touching(A.bus, B.bus)) continue;
        this.local(A, B);
      }
      for (const F of far) {
        if (F.bus.ghost || !this.touching(A.bus, F.bus)) continue;
        this.remote(A, F);
      }
    }
  }

  /** Whether any section of `a` touches any of `b`: the deepest contact's normal (a to b, level) and point left in `n`, `at`. */
  private touching(a: BusPhysics, b: BusPhysics): boolean {
    const pa = a.body.translation();
    const pb = b.body.translation();
    const reach = (a.preset.body.length + b.preset.body.length) / 2 + 3 + 9 * (a.rears.length + b.rears.length);
    if ((pa.x - pb.x) ** 2 + (pa.z - pb.z) ** 2 > reach * reach) return false;
    this.found = false;
    this.bestDist = Infinity;
    let ca: RAPIER.Collider | null = null;
    let cb: RAPIER.Collider | null = null;
    let sa: RAPIER.RigidBody | null = null;
    let sb: RAPIER.RigidBody | null = null;
    for (const x of a.bodies) {
      for (const y of b.bodies) {
        this.curA = x.collider(0);
        this.curB = y.collider(0);
        const before = this.bestDist;
        this.world.contactPair(this.curA, this.curB, this.onManifold);
    
        if (this.bestDist < before) (ca = this.curA), (cb = this.curB), (sa = x), (sb = y);
      }
    }
    if (!this.found || !ca || !cb || !sa || !sb) return false;
    // The normal's sign is Rapier's (collider 1 to 2 in its order): point it from a's section to b's, level.
    const ta = sa.translation();
    const tb = sb.translation();
    const n = this.n;
    n.y = 0;
    const len = Math.hypot(n.x, n.z);
    if (len < 1e-3) return false;
    n.x /= len;
    n.z /= len;
    if ((tb.x - ta.x) * n.x + (tb.z - ta.z) * n.z < 0) (n.x = -n.x), (n.z = -n.z);
    this.curA = this.curB = null;
    return true;
  }

  private quietFor(a: string, b: string): boolean {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    return this.time - (this.quiet.get(k) ?? -Infinity) < BUMP.cooldown;
  }

  private mark(a: string, b: string): void {
    this.quiet.set(a < b ? `${a}|${b}` : `${b}|${a}`, this.time);
  }

  /** Two vehicles simulated here: Rapier solved the contact; add the bounce. */
  private local(A: BumpOwn, B: BumpOwn): void {
    if (this.quietFor(A.key, B.key)) return;
    const n = this.n;
    const ma = this.mem.get(A.key);
    const mb = this.mem.get(B.key);
    if (!ma || !mb) return;
    const closing = Math.max(this.rel(ma.v, mb.v, n), this.rel(ma.v2, mb.v2, n));
    const m1 = A.bus.totalMass;
    const m2 = B.bus.totalMass;
    // Only the bounce: the solver already took the closing speed out of the pair.
    const j = bumpImpulse(m1, m2, closing, BUMP.restitution) * sideGain(A.bus.heading, B.bus.heading, n) - bumpImpulse(m1, m2, closing, 0);
    if (j <= 0) return;
    this.mark(A.key, B.key);
    this.hits++;
    this.j.x = n.x * j;
    this.j.y = 0;
    this.j.z = n.z * j;
    this.dv.x = -this.j.x;
    this.dv.y = 0;
    this.dv.z = -this.j.z;
    A.bus.shove(this.dv, this.at);
    B.bus.shove(this.j, this.at);
  }

  /** `v1 - v2` along `n`. */
  private rel(v1: V3, v2: V3, n: V3): number {
    return (v1.x - v2.x) * n.x + (v1.z - v2.z) * n.z;
  }

  /** A vehicle simulated here against a remote one: the full collision, the remote's share sent on. */
  private remote(A: BumpOwn, F: BumpFar): void {
    if (this.quietFor(A.key, F.key)) return;
    const n = this.n;
    const v = A.bus.body.linvel();
    const closing = this.rel(v, F.vel, n);
    const m1 = A.bus.totalMass;
    const m2 = F.bus.totalMass;
    const j = bumpImpulse(m1, m2, closing) * sideGain(A.bus.heading, F.bus.heading, n);
    if (j <= 0) return;
    this.mark(A.key, F.key);
    this.hits++;
    this.dv.x = -n.x * j;
    this.dv.y = 0;
    this.dv.z = -n.z * j;
    A.bus.shove(this.dv, this.at);
    this.j.x = n.x * j;
    this.j.y = 0;
    this.j.z = n.z * j;
    F.shove({ x: this.j.x / m2, y: 0, z: this.j.z / m2 });
    this.send?.(F.key, A.key, this.j, this.at);
  }

  /** A bump from another client: its impulse `j` (N s) on our vehicle `to`, at world point `at`. False when ignored. */
  receive(from: string, to: string, j: V3, at: V3): boolean {
    const o = this.own.find((x) => x.key === to);
    if (!o || o.bus.ghost) return false;
    if (![j.x, j.y, j.z, at.x, at.y, at.z].every(Number.isFinite)) return false;
    const mag = Math.hypot(j.x, j.z);
    if (mag <= 0 || mag > BUMP.maxDv * BUMP.sideGain * o.bus.totalMass) return false;
    // Already bumped by this one in our own view.
    if (this.quietFor(from, to)) return false;
    this.mark(from, to);
    this.hits++;
    this.va.x = j.x;
    this.va.y = 0;
    this.va.z = j.z;
    this.vb.x = at.x;
    this.vb.y = at.y;
    this.vb.z = at.z;
    o.bus.shove(this.va, this.vb);
    return true;
  }

  /** Forget a vehicle (it left). */
  drop(key: string): void {
    this.mem.delete(key);
    for (const k of [...this.quiet.keys()]) if (k.split('|').includes(key)) this.quiet.delete(k);
  }
}
