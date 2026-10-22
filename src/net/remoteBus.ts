import { BusPhysics, type Spawn } from '../vehicle/bus';
import type { BusPreset } from '../vehicle/busPreset';
import type { WheelPose } from '../vehicle/busModel';
import type { RAPIER } from '../physics/world';
import type { CarState } from './protocol';
import { RENDER_DELAY, SnapshotBuffer, newPose } from './snapshots';

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
  private removed = false;
  readonly wheels: WheelPose;
  private pose = newPose();
  private spins: number[][] = [];
  private radius: number;
  private rest: number;

  constructor(world: RAPIER.World, preset: BusPreset, spawn: Spawn) {
    this.bus = new BusPhysics(world, preset, spawn);
    this.bus.makeRemote();
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

  dispose(world: RAPIER.World): void {
    if (this.removed) return;
    this.removed = true;
    this.bus.remove(world);
  }
}
