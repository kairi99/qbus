import { RAPIER } from '../physics/world';
import type { DriveInput } from '../core/input';
import type { BusPreset } from './busPreset';

export interface Spawn {
  x: number;
  y: number;
  z: number;
  /** Rotation about +Y in radians. 0 = facing +X. */
  heading: number;
  /** Nose-up pitch (radians) to match the road's grade there; 0 if left out. */
  pitch?: number;
}

const FRONT = [0, 1];
const REAR = [2, 3];
const COAST_BRAKE = 1.5;

/**
 * Physics side of a bus: chassis rigid body + Rapier raycast vehicle.
 * Chassis space: +X forward, +Y up, +Z right. Has no rendering dependencies,
 * so it runs under Vitest in Node.
 */
export class BusPhysics {
  readonly body: RAPIER.RigidBody;
  readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private steerAngle = 0;
  private rearGrip: number;
  /** Nitro fired on the last update. */
  boosting = false;

  constructor(
    private world: RAPIER.World,
    readonly preset: BusPreset,
    spawn: Spawn,
  ) {
    const { length, width, height } = preset.body;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setAngularDamping(0.4).setLinearDamping(0.05),
    );
    const m = preset.mass;
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(length / 2, height / 2, width / 2)
        .setFriction(0.3)
        .setMassProperties(
          m,
          { x: 0, y: preset.centerOfMassHeight - height / 2, z: 0 },
          {
            x: (m / 12) * (height ** 2 + width ** 2),
            y: (m / 12) * (length ** 2 + width ** 2),
            z: (m / 12) * (length ** 2 + height ** 2),
          },
          { x: 0, y: 0, z: 0, w: 1 },
        ),
      this.body,
    );

    this.rearGrip = preset.wheels.frictionSlip;
    this.vehicle = world.createVehicleController(this.body);
    const w = preset.wheels;
    const s = preset.suspension;
    const mounts = [
      [w.frontOffset, -w.track],
      [w.frontOffset, w.track],
      [w.rearOffset, -w.track],
      [w.rearOffset, w.track],
    ];
    mounts.forEach(([x, z], i) => {
      this.vehicle.addWheel({ x, y: w.mountHeight, z }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, s.restLength, w.radius);
      this.vehicle.setWheelSuspensionStiffness(i, s.stiffness);
      this.vehicle.setWheelSuspensionCompression(i, s.compression);
      this.vehicle.setWheelSuspensionRelaxation(i, s.relaxation);
      this.vehicle.setWheelMaxSuspensionTravel(i, s.maxTravel);
      this.vehicle.setWheelMaxSuspensionForce(i, s.maxForce);
      this.vehicle.setWheelFrictionSlip(i, w.frictionSlip);
      this.vehicle.setWheelSideFrictionStiffness(i, w.sideFrictionStiffness);
    });

    this.reset(spawn);
  }

  /** Signed speed along the bus's forward axis, m/s. */
  get speed(): number {
    return this.vehicle.currentVehicleSpeed();
  }

  get wheelsOnGround(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) if (this.vehicle.wheelIsInContact(i)) n++;
    return n;
  }

  /**
   * Height of the road under the bus: the mean of its wheels' contact points, or (all wheels in
   * the air, or on its side) the chassis center minus its usual ride height. Used to find which
   * level the bus is on where roads pass over each other.
   */
  roadHeight(): number {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      if (!this.vehicle.wheelIsInContact(i)) continue;
      const c = this.vehicle.wheelContactPoint(i, this.contact);
      if (c) (sum += c.y), n++;
    }
    if (n) return sum / n;
    const w = this.preset.wheels;
    return this.body.translation().y - (-w.mountHeight + this.preset.suspension.restLength + w.radius);
  }

  private contact = { x: 0, y: 0, z: 0 };

  update(input: DriveInput, dt: number): void {
    const p = this.preset;
    const speed = this.speed;
    const speedFrac = Math.min(1, Math.abs(speed) / (p.topSpeedKmh / 3.6));

    // Steering: less lock at speed, eased toward the target so keyboard input isn't twitchy.
    const lock = p.steer.maxAngle + (p.steer.highSpeedAngle - p.steer.maxAngle) * speedFrac;
    const target = -input.steer * lock;
    const maxDelta = p.steer.speed * dt;
    this.steerAngle += Math.max(-maxDelta, Math.min(maxDelta, target - this.steerAngle));
    for (const i of FRONT) this.vehicle.setWheelSteering(i, this.steerAngle);

    // Throttle doubles as brake when pushing against the direction of travel.
    let engine = 0;
    let brake = 0;
    if (input.throttle > 0) {
      if (speed < -1) brake = p.brakeForce * input.throttle;
      else if (speedFrac < 1) engine = p.engineForce * input.throttle;
    } else if (input.throttle < 0) {
      if (speed > 1) brake = p.brakeForce * -input.throttle;
      else if (speed > -p.reverseTopSpeedKmh / 3.6) engine = p.reverseForce * input.throttle;
    } else {
      brake = COAST_BRAKE;
    }

    for (const i of FRONT) this.vehicle.setWheelBrake(i, brake);
    for (const i of REAR) {
      this.vehicle.setWheelEngineForce(i, engine);
      this.vehicle.setWheelBrake(i, input.handbrake ? Math.max(brake, p.handbrakeForce) : brake);
    }

    // Drift: the handbrake drops rear grip below what the turn needs, so the tail slides out.
    // On release grip ramps back instead of snapping, which would flick the bus straight.
    this.rearGrip = input.handbrake
      ? p.wheels.handbrakeFrictionSlip
      : Math.min(p.wheels.frictionSlip, this.rearGrip + p.drift.gripRecovery * dt);
    for (const i of REAR) this.vehicle.setWheelFrictionSlip(i, this.rearGrip);

    this.vehicle.updateVehicle(dt);
    this.limitDriftAngle(dt);
    this.boost(!!input.boost, speed, dt);
  }

  /** Nitro: a straight shove along the chassis (not through the tires, so it can't just spin them). */
  private boost(on: boolean, speed: number, dt: number): void {
    const n = this.preset.nitro;
    this.boosting = on && this.wheelsOnGround >= 2 && speed < (this.preset.topSpeedKmh + n.topSpeedBonusKmh) / 3.6;
    if (!this.boosting) return;
    const q = this.body.rotation();
    // Chassis +X in world space.
    const f = { x: 1 - 2 * (q.y * q.y + q.z * q.z), y: 2 * (q.x * q.y + q.w * q.z), z: 2 * (q.x * q.z - q.w * q.y) };
    const j = this.body.mass() * n.accel * dt;
    this.body.applyImpulse({ x: f.x * j, y: f.y * j, z: f.z * j }, true);
  }

  /** Signed angle from the velocity direction to the heading, radians. 0 when not moving. */
  get slipAngle(): number {
    const v = this.body.linvel();
    if (Math.hypot(v.x, v.z) < 2) return 0;
    const d = this.heading - Math.atan2(-v.z, v.x);
    return Math.atan2(Math.sin(d), Math.cos(d));
  }

  /** Arcade assist: past the max slide angle, damp the yaw that would widen it so drifts don't become spins. */
  private limitDriftAngle(dt: number): void {
    const slip = this.slipAngle;
    const excess = Math.abs(slip) - (this.preset.drift.maxAngleDeg * Math.PI) / 180;
    const w = this.body.angvel();
    if (excess <= 0 || Math.sign(w.y) !== Math.sign(slip)) return;
    this.body.setAngvel({ x: w.x, y: w.y * Math.exp(-40 * excess * dt), z: w.z }, true);
  }

  /** Puts the bus upright at `spawn` (y = ground height there), or lifts it where it is. */
  reset(spawn?: Spawn): void {
    const clearance = this.preset.body.height / 2 + 0.6;
    const t = this.body.translation();
    const target = spawn ?? { x: t.x, y: t.y - clearance + 2, z: t.z, heading: this.heading };
    this.body.setTranslation({ x: target.x, y: target.y + clearance, z: target.z }, true);
    // Yaw about +Y, then pitch about the bus's own +Z (right) axis: nose up on an up-ramp.
    const [cy, sy] = [Math.cos(target.heading / 2), Math.sin(target.heading / 2)];
    const pitch = target.pitch ?? 0;
    const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)];
    this.body.setRotation({ x: sy * sp, y: sy * cp, z: cy * sp, w: cy * cp }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.rearGrip = this.preset.wheels.frictionSlip;
    this.boosting = false;
  }

  /** Current yaw, derived from the forward vector projected onto the ground plane. */
  get heading(): number {
    const q = this.body.rotation();
    // Forward (+X) rotated by q, projected to XZ.
    const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const fz = 2 * (q.x * q.z - q.w * q.y);
    return Math.atan2(-fz, fx);
  }
}
