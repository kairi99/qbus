import { RAPIER } from '../physics/world';
import type { DriveInput } from '../core/input';
import type { BusPreset } from './busPreset';

export interface Spawn {
  /** For an articulated bus, the middle of the whole vehicle (see `BusPhysics.position`). */
  x: number;
  y: number;
  z: number;
  /** Rotation about +Y in radians. 0 = facing +X. */
  heading: number;
  /** Nose-up pitch (radians) to match the road's grade there; 0 if left out. */
  pitch?: number;
}

type V3 = { x: number; y: number; z: number };
type Q4 = { x: number; y: number; z: number; w: number };

const FRONT = [0, 1];
const REAR = [2, 3];
const COAST_BRAKE = 1.5;

/** The rear section of an articulated bus: its own body and trailing axle, hinged to the front section. */
export interface RearSection {
  body: RAPIER.RigidBody;
  vehicle: RAPIER.DynamicRayCastVehicleController;
  joint: RAPIER.ImpulseJoint;
  /** Length of its box (m). */
  length: number;
}

/** Turntable motor: beyond the yaw limit it pushes back hard; inside, a little damping keeps the swing calm. */
const TURNTABLE_STIFFNESS = 600;
const TURNTABLE_DAMPING = 60;
const TURNTABLE_FREE_DAMPING = 4;

/**
 * Position motor on one angular axis of a ball joint. rapier3d-compat 0.20 types a spherical
 * joint as a plain `ImpulseJoint` whose JS class has no motor API, but the raw joint set has it.
 */
function motor(joint: RAPIER.ImpulseJoint, axis: RAPIER.JointAxis, target: number, stiffness: number, damping: number): void {
  (joint as unknown as { rawSet: { jointConfigureMotorPosition(h: number, a: number, t: number, k: number, c: number): void } }).rawSet.jointConfigureMotorPosition(joint.handle, axis, target, stiffness, damping);
}

/**
 * Physics side of a bus: chassis rigid body + Rapier raycast vehicle. An articulated preset
 * (`preset.articulated`) adds a second body with a trailing axle, hinged to the first at a
 * turntable (a ball joint whose motors hold the roll and a soft yaw limit); `body` stays
 * the front section. Chassis space: +X forward, +Y up, +Z right. Has no rendering dependencies,
 * so it runs under Vitest in Node.
 */
export class BusPhysics {
  readonly body: RAPIER.RigidBody;
  readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  /** The rear section of an articulated bus; null for a rigid one. */
  readonly rear: RearSection | null = null;
  /** Length of the front section (the whole vehicle for a rigid bus). */
  readonly frontLength: number;
  private steerAngle = 0;
  private lockedBend: number | null = null;
  private rearGrip: number;
  /** Nitro fired on the last update. */
  boosting = false;

  constructor(
    private world: RAPIER.World,
    readonly preset: BusPreset,
    spawn: Spawn,
  ) {
    const art = preset.articulated;
    this.frontLength = art ? preset.body.length - art.rearLength - art.gap : preset.body.length;
    const w = preset.wheels;
    this.body = this.section(this.frontLength, preset.mass);
    this.vehicle = this.addAxles(this.body, [
      [w.frontOffset, -w.track],
      [w.frontOffset, w.track],
      [w.rearOffset, -w.track],
      [w.rearOffset, w.track],
    ]);
    this.rearGrip = w.frictionSlip;

    if (art) {
      const body = this.section(art.rearLength, art.rearMass);
      const vehicle = this.addAxles(body, [
        [art.rearAxle, -w.track],
        [art.rearAxle, w.track],
      ]);
      // Ball joint in the middle of the gap, free to yaw and nod; its motors hold the roll and
      // the yaw limit. The sections' boxes may overlap on a tight bend, so they ignore each other.
      const data = RAPIER.JointData.spherical({ x: -(this.frontLength / 2 + art.gap / 2), y: 0, z: 0 }, { x: art.rearLength / 2 + art.gap / 2, y: 0, z: 0 });
      const joint = world.createImpulseJoint(data, this.body, body, true) as RAPIER.ImpulseJoint;
      joint.setContactsEnabled(false);
      motor(joint, RAPIER.JointAxis.AngX, 0, TURNTABLE_STIFFNESS, TURNTABLE_DAMPING);
      this.rear = { body, vehicle, joint, length: art.rearLength };
    }

    this.reset(spawn);
  }

  private section(length: number, m: number): RAPIER.RigidBody {
    const { width, height } = this.preset.body;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setAngularDamping(0.4).setLinearDamping(0.05));
    // Articulated sections have their lower ends chamfered (approach and departure angles), or
    // the nose digs into the road where a ramp flattens out (a box 9 m long high-centers there).
    const bevel = this.preset.articulated?.bevel ?? 0;
    const hull = bevel ? this.chamferedBox(length, width, height, bevel, bevel * 0.35) : null;
    this.world.createCollider(
      (hull ?? RAPIER.ColliderDesc.cuboid(length / 2, height / 2, width / 2))
        .setFriction(0.3)
        .setMassProperties(
          m,
          { x: 0, y: this.preset.centerOfMassHeight - height / 2, z: 0 },
          {
            x: (m / 12) * (height ** 2 + width ** 2),
            y: (m / 12) * (length ** 2 + width ** 2),
            z: (m / 12) * (length ** 2 + height ** 2),
          },
          { x: 0, y: 0, z: 0, w: 1 },
        ),
      body,
    );
    return body;
  }

  /** A box whose bottom edges at both ends are cut back by `run` along x and up by `rise`. */
  private chamferedBox(length: number, width: number, height: number, run: number, rise: number): RAPIER.ColliderDesc | null {
    const [hx, hy, hz] = [length / 2, height / 2, width / 2];
    const pts: number[] = [];
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        pts.push(sx * hx, hy, sz * hz, sx * hx, -hy + rise, sz * hz, sx * (hx - run), -hy, sz * hz);
      }
    return RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
  }

  private addAxles(body: RAPIER.RigidBody, mounts: number[][]): RAPIER.DynamicRayCastVehicleController {
    const vehicle = this.world.createVehicleController(body);
    const w = this.preset.wheels;
    const s = this.preset.suspension;
    mounts.forEach(([x, z], i) => {
      vehicle.addWheel({ x, y: w.mountHeight, z }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, s.restLength, w.radius);
      vehicle.setWheelSuspensionStiffness(i, s.stiffness);
      vehicle.setWheelSuspensionCompression(i, s.compression);
      vehicle.setWheelSuspensionRelaxation(i, s.relaxation);
      vehicle.setWheelMaxSuspensionTravel(i, s.maxTravel);
      vehicle.setWheelMaxSuspensionForce(i, s.maxForce);
      vehicle.setWheelFrictionSlip(i, w.frictionSlip);
      vehicle.setWheelSideFrictionStiffness(i, w.sideFrictionStiffness);
    });
    return vehicle;
  }

  /** Every rigid body of the vehicle: the front section, then the rear one. */
  get bodies(): RAPIER.RigidBody[] {
    return this.rear ? [this.body, this.rear.body] : [this.body];
  }

  /** Chassis colliders, for contact tests (traffic hits) and to exclude from queries. */
  get colliders(): RAPIER.Collider[] {
    return this.bodies.map((b) => b.collider(0));
  }

  private ax: V3 = { x: 0, y: 0, z: 0 };

  /**
   * Middle of the whole vehicle (nose to tail): the point stops, traffic and the R reset treat
   * as "the bus". For a rigid bus it's the body's center. Written into `out` (per-frame callers
   * pass a scratch object; omitted, a new one).
   */
  position(out: V3 = { x: 0, y: 0, z: 0 }): V3 {
    const t = this.body.translation();
    const c = out;
    c.x = t.x;
    c.y = t.y;
    c.z = t.z;
    if (!this.rear) return c;
    const r = this.rear.body.translation();
    const f = this.forwardOf(this.body.rotation(), this.frontLength / 2);
    c.x = t.x + f.x;
    c.y = t.y + f.y;
    c.z = t.z + f.z;
    const b = this.forwardOf(this.rear.body.rotation(), -this.rear.length / 2);
    c.x = (c.x + r.x + b.x) / 2;
    c.y = (c.y + r.y + b.y) / 2;
    c.z = (c.z + r.z + b.z) / 2;
    return c;
  }

  /** Each section's center, heading and length (one for a rigid bus), e.g. for the boxes traffic steers around. */
  sections(): { pos: { x: number; y: number; z: number }; heading: number; length: number }[] {
    const out = [{ pos: this.body.translation(), heading: this.heading, length: this.frontLength }];
    if (this.rear) out.push({ pos: this.rear.body.translation(), heading: this.headingOf(this.rear.body.rotation()), length: this.rear.length });
    return out;
  }

  /** The middle of the front bumper, at chassis height (into `out`, or a new object). */
  nose(out: V3 = { x: 0, y: 0, z: 0 }): V3 {
    const t = this.body.translation();
    const f = this.forwardOf(this.body.rotation(), this.frontLength / 2);
    out.x = t.x + f.x;
    out.y = t.y + f.y;
    out.z = t.z + f.z;
    return out;
  }

  /** The body's +X axis scaled by `k` (shared object). */
  private forwardOf(q: Q4, k: number): V3 {
    const a = this.ax;
    a.x = k * (1 - 2 * (q.y * q.y + q.z * q.z));
    a.y = k * 2 * (q.x * q.y + q.w * q.z);
    a.z = k * 2 * (q.x * q.z - q.w * q.y);
    return a;
  }

  /** Bend between the sections (rear heading minus front heading), radians. 0 for a rigid bus. */
  get bend(): number {
    if (!this.rear) return 0;
    const h = this.headingOf(this.body.rotation());
    const d = this.headingOf(this.rear.body.rotation()) - h;
    return Math.atan2(Math.sin(d), Math.cos(d));
  }

  private headingOf(q: Q4): number {
    const a = this.forwardOf(q, 1);
    return Math.atan2(-a.z, a.x);
  }

  /** Signed speed along the bus's forward axis, m/s. */
  get speed(): number {
    return this.vehicle.currentVehicleSpeed();
  }

  get wheelsOnGround(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) if (this.vehicle.wheelIsInContact(i)) n++;
    if (this.rear) for (let i = 0; i < 2; i++) if (this.rear.vehicle.wheelIsInContact(i)) n++;
    return n;
  }

  /** Number of wheels (4, or 6 for an articulated bus). */
  get wheelCount(): number {
    return this.rear ? 6 : 4;
  }

  /**
   * Height of the road under the bus: the mean of its wheels' contact points, or (all wheels in
   * the air, or on its side) the chassis center minus its usual ride height. Used to find which
   * level the bus is on where roads pass over each other.
   */
  roadHeight(): number {
    let sum = 0;
    let n = 0;
    for (const v of this.rear ? [this.vehicle, this.rear.vehicle] : [this.vehicle]) {
      for (let i = 0, k = v.numWheels(); i < k; i++) {
        if (!v.wheelIsInContact(i)) continue;
        const c = v.wheelContactPoint(i, this.contact);
        if (c) (sum += c.y), n++;
      }
    }
    if (n) return sum / n;
    const w = this.preset.wheels;
    return this.position().y - (-w.mountHeight + this.preset.suspension.restLength + w.radius);
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
    const fg = p.articulated?.driftFrontGrip;
    if (fg) for (const i of FRONT) this.vehicle.setWheelFrictionSlip(i, input.handbrake ? Math.min(p.wheels.frictionSlip, this.rearGrip * fg) : p.wheels.frictionSlip);

    this.vehicle.updateVehicle(dt);
    if (this.rear) this.updateRear(brake, !!input.handbrake, dt);
    this.driftAssist(input, speed, dt);
    this.limitDriftAngle(dt);
    this.boost(!!input.boost, speed, dt);
  }

  /** The trailing axle only brakes (no engine, no steering); the turntable gets its limits. */
  private updateRear(brake: number, handbrake: boolean, dt: number): void {
    const rear = this.rear!;
    const p = this.preset;
    const art = p.articulated!;
    const b = handbrake ? Math.max(brake, p.handbrakeForce) : brake;
    for (let i = 0; i < 2; i++) {
      rear.vehicle.setWheelBrake(i, b * (p.articulated!.rearMass / p.mass));
      // The handbrake lets go of the trailing axle too, or it would hold the whole bus in line.
      rear.vehicle.setWheelFrictionSlip(i, this.rearGrip);
    }
    rear.vehicle.updateVehicle(dt);
    const lim = (p.articulated!.yawLimitDeg * Math.PI) / 180;
    const bend = this.bend;
    // Handbrake: the turntable freezes at the bend it had, so the whole bus swings out as one
    // body (a hinged tail would just fold) and a drift builds a real slip angle.
    if (handbrake && art.driftLock) {
      this.lockedBend ??= Math.max(-lim, Math.min(lim, bend));
      motor(rear.joint, RAPIER.JointAxis.AngY, this.lockedBend, art.driftLock, TURNTABLE_DAMPING);
      return;
    }
    this.lockedBend = null;
    if (Math.abs(bend) > lim) motor(rear.joint, RAPIER.JointAxis.AngY, Math.sign(bend) * lim, TURNTABLE_STIFFNESS, TURNTABLE_DAMPING);
    else motor(rear.joint, RAPIER.JointAxis.AngY, 0, 0, TURNTABLE_FREE_DAMPING);
  }

  /**
   * Arcade assist for an articulated bus: its long wheelbase keeps the nose on the front tires'
   * line, so the handbrake alone never opens a slip angle. While it's held and the wheel is turned,
   * both sections are eased toward a yaw rate (the rear grip is already low, so the velocity lags).
   */
  private driftAssist(input: DriveInput, speed: number, dt: number): void {
    const rate = this.preset.articulated?.driftYawRate;
    if (!rate || !input.handbrake || Math.abs(speed) < 5 || !input.steer) return;
    // The push fades out as the slide nears the drift limit, so it opens a drift but never a spin.
    const fade = 1 - Math.abs(this.slipAngle) / (this.preset.drift.maxAngleDeg * (Math.PI / 180));
    // (past the limit it turns negative and pulls the bus back toward it)
    const fadeC = Math.max(-1, fade);
    const k = Math.min(1, 12 * dt);
    const target = -input.steer * rate * Math.sign(speed) * fadeC;
    for (const b of this.bodies) {
      const w = b.angvel();
      b.setAngvel({ x: w.x, y: w.y + (target - w.y) * k, z: w.z }, true);
    }
  }

  /** Nitro: a straight shove along the chassis (not through the tires, so it can't just spin them). */
  private boost(on: boolean, speed: number, dt: number): void {
    const n = this.preset.nitro;
    this.boosting = on && this.wheelsOnGround >= 2 && speed < (this.preset.topSpeedKmh + n.topSpeedBonusKmh) / 3.6;
    if (!this.boosting) return;
    // Each section is shoved along its own +X in proportion to its mass.
    for (const b of this.bodies) {
      const f = this.forwardOf(b.rotation(), 1);
      const j = b.mass() * n.accel * dt;
      b.applyImpulse({ x: f.x * j, y: f.y * j, z: f.z * j }, true);
    }
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

  /**
   * Puts the bus upright at `spawn` (y = ground height there; for an articulated bus x/z is the
   * middle of the whole vehicle, both sections in line), or lifts it where it is.
   */
  reset(spawn?: Spawn): void {
    const clearance = this.preset.body.height / 2 + 0.6;
    const c = this.position();
    const target = spawn ?? { x: c.x, y: c.y - clearance + 2, z: c.z, heading: this.heading };
    // Yaw about +Y, then pitch about the bus's own +Z (right) axis: nose up on an up-ramp.
    const [cy, sy] = [Math.cos(target.heading / 2), Math.sin(target.heading / 2)];
    const pitch = target.pitch ?? 0;
    const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)];
    const rot = { x: sy * sp, y: sy * cp, z: cy * sp, w: cy * cp };
    // Forward along the (pitched) road.
    const f = { x: Math.cos(target.heading) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.sin(target.heading) * Math.cos(pitch) };
    const L = this.preset.body.length;
    const place = (b: RAPIER.RigidBody, shift: number) => {
      b.setTranslation({ x: target.x + f.x * shift, y: target.y + clearance + f.y * shift, z: target.z + f.z * shift }, true);
      b.setRotation(rot, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    };
    place(this.body, L / 2 - this.frontLength / 2);
    if (this.rear) place(this.rear.body, -(L / 2 - this.rear.length / 2));
    this.steerAngle = 0;
    this.lockedBend = null;
    this.rearGrip = this.preset.wheels.frictionSlip;
    this.boosting = false;
  }

  /** Current yaw, derived from the forward vector projected onto the ground plane. */
  get heading(): number {
    return this.headingOf(this.body.rotation());
  }
}
