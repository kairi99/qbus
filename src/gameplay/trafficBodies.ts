import { GROUP, RAPIER, groups } from '../physics/world';

/** In its lane a car only meets the bus and other cars (the sim keeps it on the road); a freed wreck meets everything. */
const IN_LANE = groups(GROUP.TRAFFIC, GROUP.ALL & ~GROUP.STATIC);
const WRECK = groups(GROUP.ALL, GROUP.ALL);
import type { CityData, Vec2 } from '../world/cityData';
import { groundHeightAt } from '../world/cityData';
import { surfaceY } from '../world/elevation';
import { type RoadGraph, edgeLift, edgeY, projectOnPath } from '../world/roadGraph';
import type { Obstacle, TrafficSim } from './traffic';

const STATIC_ONLY = groups(GROUP.ALL, GROUP.STATIC);
/** Lanes within this of a bridge, underpass or ramp check the solid road under them (m). */
const NEAR_GRADE = 20;
/** The solid road is looked for this far above and below the computed surface (m). */
const PROBE = 0.6;

/**
 * Road surface under car `i` at `p`: on a ramp, bridge or underpass its road's own surface
 * there (the same `surfaceY` the road and its collider are built from, cross slope and all),
 * mid-turn the junction's height, else the ground. With `world`, on and near grade-separated
 * roads (where the ground is dug or patched) it's the solid surface found by a short ray
 * down within `PROBE` of that, so cars ride exactly what the bus drives on.
 */
export function laneSurface(city: CityData, graph: RoadGraph, sim: TrafficSim, world?: RAPIER.World): (p: Vec2, i: number) => number {
  // Edges on or near a lifted road (by their centerline points against every lifted point).
  const cell = (x: number, z: number) => `${Math.floor(x / NEAR_GRADE)},${Math.floor(z / NEAR_GRADE)}`;
  const lifted = new Set<string>();
  for (const e of graph.edges) if (e.lift) e.center.pts.forEach((q, k) => Math.abs(e.lift![k]) > 0.3 && lifted.add(cell(q.x, q.z)));
  const nearCell = (q: Vec2) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (lifted.has(cell(q.x + dx * NEAR_GRADE, q.z + dz * NEAR_GRADE))) return true;
    return false;
  };
  const near = graph.edges.map((e) => !!world && e.center.pts.some(nearCell));
  const nodeNear = graph.nodes.map((n) => [...n.in, ...n.out].some((id) => near[id]));
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const solid = (p: Vec2, y: number) => {
    ray.origin.x = p.x;
    ray.origin.y = y + PROBE;
    ray.origin.z = p.z;
    const hit = world!.castRay(ray, 2 * PROBE, true, undefined, STATIC_ONLY);
    return hit ? y + PROBE - hit.timeOfImpact : y;
  };
  return (p, i) => {
    const car = sim.cars[i];
    if (car.turn) {
      const y = graph.nodes[car.turn.node].y ?? groundHeightAt(city, p);
      return nodeNear[car.turn.node] ? solid(p, y) : y;
    }
    const e = graph.edges[car.edge];
    let y: number;
    if (e.y) {
      const s = projectOnPath(e.center, p).s;
      y = surfaceY(city, { y: edgeY(e, s)!, lift: edgeLift(e, s) }, p);
    } else y = groundHeightAt(city, p);
    return near[e.id] ? solid(p, y) : y;
  };
}

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
    /** Road surface height under car `i` at `p` (the ground, or a bridge/underpass it's on). */
    private groundAt: (p: Vec2, i: number) => number = () => 0,
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
        RAPIER.ColliderDesc.cuboid(c.kind.length / 2, c.kind.height / 2, c.kind.width / 2).setMass(c.kind.mass).setFriction(0).setCollisionGroups(IN_LANE),
        this.bodies[i],
      );
      this.byHandle.set(col.handle, i);
      return col;
    });
    this.freeFor = sim.cars.map(() => 0);
    this.generation = sim.cars.map((c) => c.generation);
    // On the road from the first frame (at its height and pitch), not risen from y = 0.
    sim.cars.forEach((c, i) => c.state === 'driving' && this.drive(i));
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
      this.ride(i);
      b.setLinvel({ x: vx, y: (this.rideY - t.y) / dt, z: vz }, true);
      b.setRotation(yawPitch(c.heading, this.ridePitch), true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
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

  isCar(c: RAPIER.Collider): boolean {
    return this.byHandle.has(c.handle);
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
    this.colliders[i].setCollisionGroups(WRECK);
  }

  /** Snap a (re)spawned car onto its sim pose, upright and under lane control. */
  private drive(i: number): void {
    const c = this.sim.cars[i];
    this.generation[i] = c.generation;
    const b = this.bodies[i];
    b.setEnabled(true);
    this.ride(i);
    b.setTranslation({ x: c.pos.x, y: this.rideY, z: c.pos.z }, true);
    b.setRotation(yawPitch(c.heading, this.ridePitch), true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.setEnabledRotations(false, true, false, true);
    b.setLinearDamping(0);
    b.setAngularDamping(0);
    this.colliders[i].setFriction(0);
    this.colliders[i].setCollisionGroups(IN_LANE);
  }

  private rideY = 0;
  private ridePitch = 0;
  private wheel = { x: 0, z: 0 };

  /**
   * Ride on the road: body height (`rideY`) and nose-up/down pitch (`ridePitch`) of car `i`
   * from the surface under its front and back.
   */
  private ride(i: number): void {
    const c = this.sim.cars[i];
    const fx = Math.cos(c.heading);
    const fz = -Math.sin(c.heading);
    const half = c.kind.length / 2;
    const w = this.wheel;
    (w.x = c.pos.x + fx * half), (w.z = c.pos.z + fz * half);
    const front = this.groundAt(w, i);
    (w.x = c.pos.x - fx * half), (w.z = c.pos.z - fz * half);
    const back = this.groundAt(w, i);
    this.rideY = (front + back) / 2 + c.kind.height / 2 + 0.02;
    this.ridePitch = Math.atan2(front - back, c.kind.length);
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

/** Yaw about +Y, then pitch about the car's own +Z (right) axis: positive = nose up. */
function yawPitch(h: number, pitch: number) {
  const cy = Math.cos(h / 2);
  const sy = Math.sin(h / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  // q = qYaw * qPitch with qYaw = (0, sy, 0, cy), qPitch = (0, 0, sp, cp)
  return { x: sy * sp, y: sy * cp, z: cy * sp, w: cy * cp };
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
