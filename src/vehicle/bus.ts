import { GROUP, RAPIER, groups } from '../physics/world';
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
/** Floodwater's drag (1/s per meter of depth): half a meter of water holds a bus to a crawl. */
const WADE_DRAG = 1.1;
/** Grip left in water deeper than AQUAPLANE (the tires float on it). */
const WADE_GRIP = 0.6;
const AQUAPLANE = 0.15;
/** The grip of a soaked road (weather.ts's WET_GRIP; physics doesn't import gameplay). */
const WET_GRIP_REF = 0.7;
/** Brakes on a soaked road stop this much less hard (the tires lock and skid). */
const WET_BRAKE = 0.7;

/** A rear section of an articulated bus: its own body and trailing axle, hinged to the section ahead. */
export interface RearSection {
  body: RAPIER.RigidBody;
  vehicle: RAPIER.DynamicRayCastVehicleController;
  joint: RAPIER.ImpulseJoint;
  /** Length of its box (m). */
  length: number;
  /** Bend frozen by the handbrake (`driftLock`), null while free. */
  lockedBend: number | null;
}

/**
 * A train of sections (more than one rear section, the gusanito): its sections never touch each
 * other (on a tight bend the third wagon swings into the first one's box) and its wheels don't
 * stand on them. Each train has a bit of its own: another gusanito (a race's rivals) is solid.
 */
let trains = 0;
const trainGroups = () => {
  const bit = GROUP.TRAIN << trains++ % GROUP.TRAINS;
  return groups(bit, GROUP.ALL & ~bit);
};

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
 * (`preset.articulated`) adds bodies with a trailing axle each (`sections` of them, one by
 * default), each hinged to the one ahead at a turntable (a ball joint whose motors hold the roll
 * and a soft yaw limit); `body` stays the front section. Chassis space: +X forward, +Y up, +Z right. Has no rendering dependencies,
 * so it runs under Vitest in Node.
 */
export class BusPhysics {
  readonly body: RAPIER.RigidBody;
  readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  /** The rear sections of an articulated bus, front to back; empty for a rigid one. */
  readonly rears: RearSection[] = [];
  /** Length of the front section (the whole vehicle for a rigid bus). */
  readonly frontLength: number;
  private steerAngle = 0;
  private rearGrip: number;
  /** Tire grip from the weather (1 dry, less on a wet road): scales every wheel's friction. */
  grip = 1;
  /** Depth of floodwater the bus stands in (m; set by the game, 0 when dry): it drags it back. */
  wade = 0;
  /** Backing up (throttle back, or rolling backwards), for `reverseLock`. */
  private reversing = false;
  /** Ray filter for the wheels of a train (null: the default, everything). */
  private wheelGroups: number | undefined;
  /** Nitro fired on the last update. */
  boosting = false;

  constructor(
    private world: RAPIER.World,
    readonly preset: BusPreset,
    spawn: Spawn,
  ) {
    const art = preset.articulated;
    const n = art ? (art.sections ?? 1) : 0;
    this.frontLength = art ? preset.body.length - n * (art.rearLength + art.gap) : preset.body.length;
    const train = n > 1 ? trainGroups() : undefined;
    this.wheelGroups = train;
    const w = preset.wheels;
    this.body = this.section(this.frontLength, preset.mass);
    this.vehicle = this.addAxles(this.body, [
      [w.frontOffset, -w.track],
      [w.frontOffset, w.track],
      [w.rearOffset, -w.track],
      [w.rearOffset, w.track],
    ]);
    this.rearGrip = w.frictionSlip;

    for (let i = 0; i < n; i++) {
      const ahead = i ? this.rears[i - 1] : null;
      const body = this.section(art!.rearLength, art!.rearMass);
      const vehicle = this.addAxles(body, [
        [art!.rearAxle, -w.track],
        [art!.rearAxle, w.track],
      ]);
      // Ball joint in the middle of the gap, free to yaw and nod; its motors hold the roll and
      // the yaw limit. The sections' boxes may overlap on a tight bend, so they ignore each other.
      const data = RAPIER.JointData.spherical({ x: -((ahead?.length ?? this.frontLength) / 2 + art!.gap / 2), y: 0, z: 0 }, { x: art!.rearLength / 2 + art!.gap / 2, y: 0, z: 0 });
      const joint = world.createImpulseJoint(data, ahead?.body ?? this.body, body, true) as RAPIER.ImpulseJoint;
      joint.setContactsEnabled(false);
      motor(joint, RAPIER.JointAxis.AngX, 0, TURNTABLE_STIFFNESS, TURNTABLE_DAMPING);
      this.rears.push({ body, vehicle, joint, length: art!.rearLength, lockedBend: null });
    }
    if (train !== undefined) for (const c of this.colliders) c.setCollisionGroups(train);

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

  /** The first rear section (the only one of an articulated bus); null for a rigid one. */
  get rear(): RearSection | null {
    return this.rears[0] ?? null;
  }

  /** Every rigid body of the vehicle: the front section, then the rear ones. */
  get bodies(): RAPIER.RigidBody[] {
    return [this.body, ...this.rears.map((r) => r.body)];
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
    const last = this.rears[this.rears.length - 1];
    if (!last) return c;
    const r = last.body.translation();
    const f = this.forwardOf(this.body.rotation(), this.frontLength / 2);
    c.x = t.x + f.x;
    c.y = t.y + f.y;
    c.z = t.z + f.z;
    const b = this.forwardOf(last.body.rotation(), -last.length / 2);
    c.x = (c.x + r.x + b.x) / 2;
    c.y = (c.y + r.y + b.y) / 2;
    c.z = (c.z + r.z + b.z) / 2;
    return c;
  }

  /** Each section's center, heading and length (one for a rigid bus), e.g. for the boxes traffic steers around. */
  sections(): { pos: { x: number; y: number; z: number }; heading: number; length: number }[] {
    const out = [{ pos: this.body.translation(), heading: this.heading, length: this.frontLength }];
    for (const r of this.rears) out.push({ pos: r.body.translation(), heading: this.headingOf(r.body.rotation()), length: r.length });
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

  /** Bend between the front section and the one behind it (rear heading minus front heading), radians. 0 for a rigid bus. */
  get bend(): number {
    return this.rears.length ? this.bendAt(0) : 0;
  }

  /** Bend at the `i`th turntable: rear section `i`'s heading minus the heading of the section ahead of it. */
  bendAt(i: number): number {
    const h = this.headingOf((i ? this.rears[i - 1].body : this.body).rotation());
    const d = this.headingOf(this.rears[i].body.rotation()) - h;
    return Math.atan2(Math.sin(d), Math.cos(d));
  }

  private headingOf(q: Q4): number {
    const a = this.forwardOf(q, 1);
    return Math.atan2(-a.z, a.x);
  }

  /** Signed speed along the bus's forward axis, m/s. */
  get speed(): number {
    // Asleep it's standing still, but the controller keeps reporting its last (stale) speed.
    return this.body.isSleeping() ? 0 : this.vehicle.currentVehicleSpeed();
  }

  get wheelsOnGround(): number {
    let n = 0;
    for (let i = 0; i < 4; i++) if (this.vehicle.wheelIsInContact(i)) n++;
    for (const r of this.rears) for (let i = 0; i < 2; i++) if (r.vehicle.wheelIsInContact(i)) n++;
    return n;
  }

  /** Number of wheels (4, plus 2 per rear section of an articulated bus). */
  get wheelCount(): number {
    return 4 + 2 * this.rears.length;
  }

  /**
   * Height of the road under the bus: the mean of its wheels' contact points, or (all wheels in
   * the air, or on its side) the chassis center minus its usual ride height. Used to find which
   * level the bus is on where roads pass over each other.
   */
  roadHeight(): number {
    let sum = 0;
    let n = 0;
    for (const v of [this.vehicle, ...this.rears.map((r) => r.vehicle)]) {
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
    brake *= 1 - (1 - WET_BRAKE) * Math.min(1, this.wetness);
    if (input.parked) (engine = 0), (brake = p.brakeForce);

    for (const i of FRONT) this.vehicle.setWheelBrake(i, brake);
    for (const i of REAR) {
      this.vehicle.setWheelEngineForce(i, engine);
      this.vehicle.setWheelBrake(i, input.handbrake && !input.parked ? Math.max(brake, p.handbrakeForce) : brake);
    }

    // Drift: the handbrake drops rear grip below what the turn needs, so the tail slides out.
    // On release grip ramps back instead of snapping, which would flick the bus straight.
    this.rearGrip = input.handbrake
      ? p.wheels.handbrakeFrictionSlip
      : Math.min(p.wheels.frictionSlip, this.rearGrip + p.drift.gripRecovery * dt);
    for (const i of REAR) this.vehicle.setWheelFrictionSlip(i, this.rearGrip);
    const fg = p.articulated?.driftFrontGrip;
    if (fg) for (const i of FRONT) this.vehicle.setWheelFrictionSlip(i, input.handbrake ? Math.min(p.wheels.frictionSlip, this.rearGrip * fg) : p.wheels.frictionSlip);

    this.wetTires(this.vehicle);
    this.vehicle.updateVehicle(dt, undefined, this.wheelGroups);
    this.reversing = input.throttle < 0 || speed < -1;
    this.rears.forEach((r, i) => this.updateRear(r, i, brake, !!input.handbrake, dt));
    this.driftAssist(input, speed, dt);
    this.limitDriftAngle(dt);
    this.boost(!!input.boost, speed, dt);
    this.wading(dt);
  }

  /**
   * A wet road caps the tires' friction (the friction already set for this step: handbrake and
   * drift values stay when lower) at the preset's `wet` values on a soaked road (at `grip` 1
   * nothing changes). The presets' dry friction is far over what a turn needs, so how low the cap
   * must go to slide depends on the vehicle (its weight on each axle): tuned per preset, the rear
   * lower than the front so the tail steps out rather than the nose plowing on. In water deeper
   * than AQUAPLANE the tires float and lose more.
   */
  private wetTires(v: RAPIER.DynamicRayCastVehicleController): void {
    const wet = this.wetness;
    if (wet <= 0) return;
    const dry = this.preset.wheels.frictionSlip;
    const caps = this.preset.wet ?? { front: dry, rear: dry };
    for (let i = 0, n = v.numWheels(); i < n; i++) {
      const soaked = v === this.vehicle && i < 2 ? caps.front : caps.rear;
      const cap = dry + (Math.min(dry, soaked) - dry) * wet;
      v.setWheelFrictionSlip(i, Math.max(0.2, Math.min(v.wheelFrictionSlip(i) ?? 0, cap)));
    }
  }

  /** 0 on a dry road, 1 soaked (`grip` WET_GRIP_REF), up to 1.5 in floodwater. */
  private get wetness(): number {
    const grip = this.wade > AQUAPLANE ? this.grip * WADE_GRIP : this.grip;
    return Math.min(1.5, (1 - grip) / (1 - WET_GRIP_REF));
  }

  /** Floodwater drags every section back, more the deeper and faster it goes (a splash, then a crawl). */
  private wading(dt: number): void {
    if (this.wade <= 0) return;
    const k = Math.min(1, WADE_DRAG * Math.min(1, this.wade) * dt);
    for (const b of this.bodies) {
      const v = b.linvel();
      const m = b.mass();
      b.applyImpulse({ x: -v.x * m * k, y: 0, z: -v.z * m * k }, true);
    }
  }

  /** A trailing axle only brakes (no engine, no steering); its turntable gets its limits. */
  private updateRear(rear: RearSection, index: number, brake: number, handbrake: boolean, dt: number): void {
    const p = this.preset;
    const art = p.articulated!;
    const b = handbrake ? Math.max(brake, p.handbrakeForce) : brake;
    for (let i = 0; i < 2; i++) {
      rear.vehicle.setWheelBrake(i, b * (art.rearMass / p.mass));
      // The handbrake lets go of the trailing axle too, or it would hold the whole bus in line.
      rear.vehicle.setWheelFrictionSlip(i, this.rearGrip);
    }
    this.wetTires(rear.vehicle);
    rear.vehicle.updateVehicle(dt, undefined, this.wheelGroups);
    const lim = (art.yawLimitDeg * Math.PI) / 180;
    const bend = this.bendAt(index);
    // Handbrake: the turntable freezes at the bend it had, so the whole bus swings out as one
    // body (a hinged tail would just fold) and a drift builds a real slip angle.
    if (handbrake && art.driftLock) {
      rear.lockedBend ??= Math.max(-lim, Math.min(lim, bend));
      motor(rear.joint, RAPIER.JointAxis.AngY, rear.lockedBend, art.driftLock, TURNTABLE_DAMPING);
      return;
    }
    rear.lockedBend = null;
    // Backing up a train of trailers folds it (each pushes the one ahead sideways): the
    // turntables pull straight instead, and it reverses like one long rigid bus.
    if (art.reverseLock && this.speed < 0.5 && this.reversing) {
      motor(rear.joint, RAPIER.JointAxis.AngY, 0, art.reverseLock, TURNTABLE_DAMPING);
      return;
    }
    if (Math.abs(bend) > lim) motor(rear.joint, RAPIER.JointAxis.AngY, Math.sign(bend) * lim, art.yawLimitStiffness ?? TURNTABLE_STIFFNESS, TURNTABLE_DAMPING);
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
    let at = L / 2 - this.frontLength;
    for (const r of this.rears) {
      at -= (this.preset.articulated?.gap ?? 0) + r.length;
      place(r.body, at + r.length / 2);
      r.lockedBend = null;
    }
    this.steerAngle = 0;
    this.rearGrip = this.preset.wheels.frictionSlip;
    this.boosting = false;
    this.wade = 0;
  }

  /** Current yaw, derived from the forward vector projected onto the ground plane. */
  get heading(): number {
    return this.headingOf(this.body.rotation());
  }
}
