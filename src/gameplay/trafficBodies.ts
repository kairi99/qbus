import { RAPIER } from '../physics/world';
import type { Vec2 } from '../world/cityData';
import type { Obstacle, TrafficSim } from './traffic';

/** Chasing a sim pose that drifts this far away means something physical is in the way. */
const MAX_DEVIATION = 1.5;
const MAX_SPEED = 30;
const RECOVER_AFTER = 5;
const RECOVER_FORCE = 12;
const RESPAWN_DISTANCE = 90;

/**
 * Physics side of traffic. While driving, each car is a dynamic box steered by velocity toward
 * its TrafficSim pose, so the bus can shove it with real mass. When the bus hits it (or it gets
 * pushed off its pose) it's released to free physics; a few seconds later it respawns far away.
 */
export class TrafficBodies {
  readonly bodies: RAPIER.RigidBody[];
  private colliders: RAPIER.Collider[];
  private byHandle = new Map<number, number>();
  private freeFor: number[];
  private generation: number[];

  constructor(
    private world: RAPIER.World,
    private sim: TrafficSim,
  ) {
    this.bodies = sim.cars.map((c) => {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(c.pos.x, c.kind.height / 2 + 0.02, c.pos.z)
          .setRotation(yaw(c.heading))
          .setCanSleep(false),
      );
      body.setEnabledRotations(false, true, false, true);
      return body;
    });
    this.colliders = sim.cars.map((c, i) => {
      const col = world.createCollider(
        RAPIER.ColliderDesc.cuboid(c.kind.length / 2, c.kind.height / 2, c.kind.width / 2).setMass(c.kind.mass).setFriction(0),
        this.bodies[i],
      );
      this.byHandle.set(col.handle, i);
      return col;
    });
    this.freeFor = sim.cars.map(() => 0);
    this.generation = sim.cars.map((c) => c.generation);
    this.syncEnabled();
  }

  /** Before world.step: set velocities that carry each driving car onto its new sim pose. */
  steer(dt: number): void {
    this.syncEnabled();
    this.sim.cars.forEach((c, i) => {
      if (c.state !== 'driving') return;
      if (c.generation !== this.generation[i]) this.drive(i); // relocated by the sim: teleport
      const b = this.bodies[i];
      const t = b.translation();
      let vx = (c.pos.x - t.x) / dt;
      let vz = (c.pos.z - t.z) / dt;
      const v = Math.hypot(vx, vz);
      if (v > MAX_SPEED) (vx *= MAX_SPEED / v), (vz *= MAX_SPEED / v);
      b.setLinvel({ x: vx, y: b.linvel().y, z: vz }, true);
      const turn = wrap(c.heading - heading(b));
      b.setAngvel({ x: 0, y: Math.max(-6, Math.min(6, turn / dt)), z: 0 }, true);
    });
  }

  /**
   * After world.step: release cars the bus touched or that got pushed off course, and bring
   * settled wrecks back into traffic. Returns ids of cars the bus just hit.
   */
  afterStep(dt: number, busCollider: RAPIER.Collider, busPos: Vec2): number[] {
    const hit = new Set<number>();
    this.world.contactPairsWith(busCollider, (other) => {
      const i = this.byHandle.get(other.handle);
      if (i === undefined || this.sim.cars[i].state !== 'driving') return;
      this.world.contactPair(busCollider, other, (m) => {
        if (m.numContacts() > 0) hit.add(i);
      });
    });
    this.sim.cars.forEach((c, i) => {
      const b = this.bodies[i];
      if (c.state === 'driving') {
        const t = b.translation();
        if (hit.has(i) || Math.hypot(t.x - c.pos.x, t.z - c.pos.z) > MAX_DEVIATION) this.free(i);
      } else if (c.state === 'free') {
        this.freeFor[i] += dt;
        const v = b.linvel();
        const settled = Math.hypot(v.x, v.y, v.z) < 0.5 && this.freeFor[i] > RECOVER_AFTER;
        if (settled || this.freeFor[i] > RECOVER_FORCE) {
          this.sim.respawn(i, busPos, RESPAWN_DISTANCE);
          // respawn() may fail to find a free spot and park the car instead.
          if (this.sim.cars[i].state === 'driving') this.drive(i);
        }
      }
    });
    return [...hit];
  }

  /** Wrecked cars, for the sim to steer around. */
  obstacles(): Obstacle[] {
    const out: Obstacle[] = [];
    this.sim.cars.forEach((c, i) => {
      if (c.state !== 'free') return;
      const t = this.bodies[i].translation();
      out.push({ id: `wreck${i}`, pos: { x: t.x, z: t.z }, heading: heading(this.bodies[i]), length: c.kind.length, width: c.kind.width });
    });
    return out;
  }

  private free(i: number): void {
    this.sim.release(i);
    this.freeFor[i] = 0;
    const b = this.bodies[i];
    b.setEnabledRotations(true, true, true, true);
    b.setLinearDamping(0.4);
    b.setAngularDamping(0.4);
    this.colliders[i].setFriction(0.8);
  }

  /** Snap a (re)spawned car onto its sim pose, upright and under lane control. */
  private drive(i: number): void {
    const c = this.sim.cars[i];
    this.generation[i] = c.generation;
    const b = this.bodies[i];
    b.setEnabled(true);
    b.setTranslation({ x: c.pos.x, y: c.kind.height / 2 + 0.02, z: c.pos.z }, true);
    b.setRotation(yaw(c.heading), true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.setEnabledRotations(false, true, false, true);
    b.setLinearDamping(0);
    b.setAngularDamping(0);
    this.colliders[i].setFriction(0);
  }

  /** Parked cars (over the performance budget) are taken out of the physics world. */
  private syncEnabled(): void {
    this.sim.cars.forEach((c, i) => {
      const b = this.bodies[i];
      const want = c.state !== 'parked';
      if (want === b.isEnabled()) return;
      if (want) this.drive(i);
      else b.setEnabled(false);
    });
  }
}

function yaw(h: number) {
  return { x: 0, y: Math.sin(h / 2), z: 0, w: Math.cos(h / 2) };
}

function heading(b: RAPIER.RigidBody): number {
  const q = b.rotation();
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  return Math.atan2(-fz, fx);
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
