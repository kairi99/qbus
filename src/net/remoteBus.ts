import { BusPhysics, type Spawn } from '../vehicle/bus';
import type { BusPreset } from '../vehicle/busPreset';
import type { WheelPose } from '../vehicle/busModel';
import type { RAPIER } from '../physics/world';
import type { CarState } from './protocol';
import type { CameraTarget } from '../camera/cameraRig';
import { RENDER_DELAY, SnapshotBuffer, newPose } from './snapshots';

/** A predicted shove (`RemoteBus.shove`) is shown for this long (s) at the speed it was given... */
const SHOVE_PREDICT = 0.4;
/** ...and the displacement it built fades with this time constant (s) as the real one arrives in the snapshots. */
const SHOVE_FADE = 0.6;
/** Share of a new velocity sample kept in `vel`. */
const VEL_SMOOTH = 0.35;

/**
 * Another player's bus: a kinematic, solid `BusPhysics` moved each frame from interpolated
 * snapshots. Rapier only (no three.js) so it runs in Node tests; `wheels` feeds `BusModel.sync`.
 */
export class RemoteBus {
  readonly bus: BusPhysics;
  readonly buffer = new SnapshotBuffer();
  steer = 0;
  speed = 0;
  throttle = 0;
  /** Meters along the track, interpolated. */
  s = 0;
  /** Set when the last sample jumped (a respawn). */
  snapped = false;
  /** The last sample was a ghost (the bus passes through the others). */
  ghost = false;
  /** The player's horn is down (as of the last snapshot sampled). */
  horn = false;
  /** Set from outside (its player left, or went silent): a ghost whatever the snapshots say. */
  forceGhost = false;
  /** Its velocity (m/s), measured from the poses it was moved to (for collisions: `physics/bump.ts`). */
  readonly vel = { x: 0, y: 0, z: 0 };
  // Predicted shove after a bump we dealt: speed given, time left on it, and the displacement so far.
  private shoveV = { x: 0, z: 0 };
  private shoveT = 0;
  private shoveOff = { x: 0, z: 0 };
  private lastP = { x: 0, y: 0, z: 0, ok: false };
  private removed = false;
  readonly wheels: WheelPose;
  /** What the spectator camera follows: the bus, with the speed from the snapshots (a kinematic body reports none). */
  readonly view: CameraTarget;
  private pose = newPose();
  private spins: number[][] = [];
  private radius: number;
  private rest: number;

  constructor(world: RAPIER.World, preset: BusPreset, spawn: Spawn) {
    this.bus = new BusPhysics(world, preset, spawn);
    this.bus.makeRemote();
    const bus = this.bus;
    const self = this;
    this.view = {
      body: bus.body,
      preset: bus.preset,
      frontLength: bus.frontLength,
      get heading() {
        return bus.heading;
      },
      get boosting() {
        return bus.boosting;
      },
      get speed() {
        return self.speed;
      },
      position: (out) => bus.position(out),
    };
    this.radius = preset.wheels.radius;
    this.rest = preset.suspension.restLength;
    const sections = 1 + this.bus.rears.length;
    for (let i = 0; i < sections; i++) this.spins.push([0, 0, 0, 0]);
    this.wheels = {
      susp: () => this.rest,
      // Only the front axle (wheels 0 and 1) steers.
      steer: (section, i) => (section === 0 && i < 2 ? this.steer : 0),
      spin: (section, i) => this.spins[section]?.[i] ?? 0,
    };
  }

  push(at: number, car: CarState): void {
    this.buffer.push(at, car);
  }

  /** Moves the bus to where the snapshots say it was `RENDER_DELAY` ago. No-op before any snapshot. */
  apply(serverNow: number, dt: number): void {
    if (this.removed) return;
    if (this.forceGhost && this.bus.ghost === false) this.bus.setGhost(true);
    const pose = this.pose;
    if (!this.buffer.sample(serverNow - RENDER_DELAY, pose)) return;
    this.displace(pose, dt);
    this.bus.setPose(pose, pose.rears.length ? pose.rears : undefined);
    this.bus.boosting = pose.boost === 1;
    this.ghost = pose.ghost || this.forceGhost;
    if (this.bus.ghost !== this.ghost) this.bus.setGhost(this.ghost);
    this.steer = pose.steer;
    this.speed = pose.speed;
    this.throttle = pose.thr;
    this.s = pose.s;
    this.snapped = pose.snapped;
    this.horn = pose.horn;
    const d = (pose.speed / this.radius) * dt;
    for (const sec of this.spins) for (let i = 0; i < sec.length; i++) sec[i] += d;
  }

  /**
   * A bump we dealt it: its owner will push it by `dv` (m/s), but that reaches the snapshots a
   * moment later. Meanwhile the bus we collide with is moved on by that much here, so we don't
   * drive into it where the real one is already pulling away; the offset fades as the real shove shows.
   */
  shove(dv: { x: number; z: number }): void {
    this.shoveV.x += dv.x;
    this.shoveV.z += dv.z;
    this.shoveT = SHOVE_PREDICT;
  }

  /** Adds the predicted shove to the pose and measures the velocity of the result. */
  private displace(pose: ReturnType<typeof newPose>, dt: number): void {
    const o = this.shoveOff;
    if (this.shoveT > 0) {
      o.x += this.shoveV.x * dt;
      o.z += this.shoveV.z * dt;
      this.shoveT -= dt;
      if (this.shoveT <= 0) this.shoveV.x = this.shoveV.z = 0;
    }
    const fade = 1 / (1 + dt / SHOVE_FADE);
    o.x *= fade;
    o.z *= fade;
    if (Math.abs(o.x) + Math.abs(o.z) > 1e-4) {
      pose.p[0] += o.x;
      pose.p[2] += o.z;
      for (const r of pose.rears) (r[0] += o.x), (r[2] += o.z);
    }
    const l = this.lastP;
    if (l.ok && !pose.snapped && dt > 0) {
      const k = VEL_SMOOTH;
      const vx = (pose.p[0] - l.x) / dt;
      const vy = (pose.p[1] - l.y) / dt;
      const vz = (pose.p[2] - l.z) / dt;
      if (Math.hypot(vx, vz) < 90) {
        this.vel.x += (vx - this.vel.x) * k;
        this.vel.y += (vy - this.vel.y) * k;
        this.vel.z += (vz - this.vel.z) * k;
      }
    } else this.vel.x = this.vel.y = this.vel.z = 0;
    l.x = pose.p[0];
    l.y = pose.p[1];
    l.z = pose.p[2];
    l.ok = true;
  }

  dispose(world: RAPIER.World): void {
    if (this.removed) return;
    this.removed = true;
    this.bus.remove(world);
  }
}
