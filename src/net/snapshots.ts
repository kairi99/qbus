import type { CarState } from './protocol';

/** Pure (no three, no Rapier): buffering and interpolation of other players' snapshots. */

/** Render this far behind the server clock (ms), so there are usually two snapshots to blend. */
export const RENDER_DELAY = 100;
/** Past the newest snapshot, keep moving by its velocity for at most this long (ms), then hold. */
export const MAX_EXTRAPOLATE = 250;
/** Two consecutive snapshots further apart than this (m) are a teleport: no blending across it. */
export const SNAP_DIST = 10;
export const BUFFER_SIZE = 16;

export interface Pose {
  p: [number, number, number];
  q: [number, number, number, number];
  /** [px, py, pz, qx, qy, qz, qw] per rear section; arrays are reused. */
  rears: number[][];
  steer: number;
  speed: number;
  thr: number;
  boost: 0 | 1;
  /** The vehicle is a ghost (from the latest snapshot at or before the sample time). */
  ghost: boolean;
  s: number;
  /** The sample is the far side of a teleport. */
  snapped: boolean;
}

export function newPose(): Pose {
  return { p: [0, 0, 0], q: [0, 0, 0, 1], rears: [], steer: 0, speed: 0, thr: 0, boost: 0, ghost: false, s: 0, snapped: false };
}

interface Entry {
  at: number;
  car: CarState;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Normalized lerp of two unit quaternions along the shortest path, written to out[o..o+3]. */
function nlerp(out: ArrayLike<number> & { [i: number]: number }, o: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, k: number): void {
  const dot = a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2] + a[ai + 3] * b[bi + 3];
  const sg = dot < 0 ? -1 : 1;
  let x = lerp(a[ai], sg * b[bi], k);
  let y = lerp(a[ai + 1], sg * b[bi + 1], k);
  let z = lerp(a[ai + 2], sg * b[bi + 2], k);
  let w = lerp(a[ai + 3], sg * b[bi + 3], k);
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
}

export class SnapshotBuffer {
  private ring: (Entry | undefined)[] = new Array(BUFFER_SIZE);
  private count = 0;
  private head = 0; // next write slot
  private lastAt = -Infinity;

  get length(): number {
    return this.count;
  }

  /** Newest snapshot's server time, -Infinity when empty. */
  get newest(): number {
    return this.lastAt;
  }

  /** Stores a snapshot; out-of-order and duplicate times are dropped (returns false). */
  push(at: number, car: CarState): boolean {
    if (at <= this.lastAt) return false;
    this.lastAt = at;
    this.ring[this.head] = { at, car };
    this.head = (this.head + 1) % BUFFER_SIZE;
    if (this.count < BUFFER_SIZE) this.count++;
    return true;
  }

  /** i-th oldest entry (0 = oldest). */
  private at(i: number): Entry {
    return this.ring[(this.head - this.count + i + BUFFER_SIZE * 2) % BUFFER_SIZE]!;
  }

  /** Pose at server time `t` into `out`; false while the buffer is empty. */
  sample(t: number, out: Pose): boolean {
    const n = this.count;
    if (!n) return false;
    out.snapped = false;
    const first = this.at(0);
    if (t <= first.at) {
      this.write(out, first.car, first.car, 0);
      return true;
    }
    const last = this.at(n - 1);
    if (t >= last.at) {
      this.write(out, last.car, last.car, 0);
      const dt = Math.min(t - last.at, MAX_EXTRAPOLATE) / 1000;
      if (dt > 0) {
        out.p[0] += last.car.v[0] * dt;
        out.p[1] += last.car.v[1] * dt;
        out.p[2] += last.car.v[2] * dt;
        // Rear sections ride along with the same velocity.
        for (const r of out.rears) {
          r[0] += last.car.v[0] * dt;
          r[1] += last.car.v[1] * dt;
          r[2] += last.car.v[2] * dt;
        }
      }
      return true;
    }
    let i = n - 2;
    while (i > 0 && this.at(i).at > t) i--;
    const a = this.at(i);
    const b = this.at(i + 1);
    const dx = b.car.p[0] - a.car.p[0];
    const dy = b.car.p[1] - a.car.p[1];
    const dz = b.car.p[2] - a.car.p[2];
    if (dx * dx + dy * dy + dz * dz > SNAP_DIST * SNAP_DIST) {
      // Teleport: no blending across it, the pose jumps to the later snapshot.
      this.write(out, b.car, b.car, 0);
      out.snapped = true;
      return true;
    }
    this.write(out, a.car, b.car, (t - a.at) / (b.at - a.at));
    return true;
  }

  private write(out: Pose, a: CarState, b: CarState, k: number): void {
    for (let i = 0; i < 3; i++) out.p[i] = lerp(a.p[i], b.p[i], k);
    nlerp(out.q, 0, a.q, 0, b.q, 0, k);
    out.steer = lerp(a.steer, b.steer, k);
    out.speed = lerp(a.speed, b.speed, k);
    out.s = lerp(a.s, b.s, k);
    out.thr = b.thr;
    out.boost = b.boost;
    out.ghost = a.g === 1;
    const ra = a.rears;
    const rb = b.rears;
    const nr = ra && rb ? Math.min(ra.length, rb.length) : 0;
    while (out.rears.length > nr) out.rears.pop();
    while (out.rears.length < nr) out.rears.push([0, 0, 0, 0, 0, 0, 1]);
    for (let i = 0; i < nr; i++) {
      const o = out.rears[i];
      for (let j = 0; j < 3; j++) o[j] = lerp(ra![i][j], rb![i][j], k);
      nlerp(o, 3, ra![i], 3, rb![i], 3, k);
    }
  }
}

/** What `carState` needs of a local bus: structural, so it works without three or Rapier. */
export interface BusLike {
  body: { translation(): { x: number; y: number; z: number }; rotation(): { x: number; y: number; z: number; w: number }; linvel(): { x: number; y: number; z: number } };
  rears: { body: BusLike['body'] }[];
  vehicle: { wheelSteering(i: number): number | undefined | null };
  speed: number;
  boosting: boolean;
  ghost?: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Snapshot of a local bus for sending, rounded to keep the JSON small. */
export function carState(bus: BusLike, who: CarState['who'], s: number, thr: number, out?: CarState): CarState {
  const t = bus.body.translation();
  const q = bus.body.rotation();
  const v = bus.body.linvel();
  const c: CarState = out ?? { who, s, p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], steer: 0, speed: 0, thr: 0, boost: 0 };
  c.who = who;
  c.s = r2(s);
  c.p[0] = r2(t.x); c.p[1] = r2(t.y); c.p[2] = r2(t.z);
  c.q[0] = r4(q.x); c.q[1] = r4(q.y); c.q[2] = r4(q.z); c.q[3] = r4(q.w);
  c.v[0] = r2(v.x); c.v[1] = r2(v.y); c.v[2] = r2(v.z);
  if (bus.rears.length) {
    c.rears = bus.rears.map((r) => {
      const rt = r.body.translation();
      const rq = r.body.rotation();
      return [r2(rt.x), r2(rt.y), r2(rt.z), r4(rq.x), r4(rq.y), r4(rq.z), r4(rq.w)] as [number, number, number, number, number, number, number];
    });
  } else delete c.rears;
  c.steer = r4(bus.vehicle.wheelSteering(0) ?? 0);
  c.speed = r2(bus.speed);
  c.thr = r2(thr);
  c.boost = bus.boosting ? 1 : 0;
  if (bus.ghost) c.g = 1;
  else delete c.g;
  return c;
}
