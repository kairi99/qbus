import * as THREE from 'three';
import type { BusPhysics } from '../vehicle/bus';

export type CameraMode = 'chase' | 'cockpit';

const BASE_FOV = 68;
const SPEED_FOV = 14;
/** Extra widening while the nitro burns. */
const NITRO_FOV = 10;
// Camera looks down -Z; the bus faces +X, so rotate -90° about Y to look forward.
const LOOK_FORWARD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);

/** Third-person chase camera and first-person driver-seat camera, toggled at runtime. */
export class CameraRig {
  mode: CameraMode = 'chase';
  private lookTarget = new THREE.Vector3();
  private busPos = new THREE.Vector3();
  private busQuat = new THREE.Quaternion();
  private flatFwd = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private headQuat = new THREE.Quaternion();
  private first = true;
  private lastBus = new THREE.Vector3(Infinity, 0, 0);
  private lookingBack = false;
  private nitroFov = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  toggle(): CameraMode {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    this.first = true;
    return this.mode;
  }

  /** Dev/testing: fixed viewpoint instead of following the bus. */
  debugView: { pos: THREE.Vector3Like; look: THREE.Vector3Like } | null = null;

  /** `lookBack`: camera in front of the bus, facing it (held button). Works from either mode. */
  update(dt: number, bus: BusPhysics, lookBack = false): void {
    if (this.debugView) {
      this.camera.position.copy(this.debugView.pos);
      this.camera.lookAt(this.debugView.look.x, this.debugView.look.y, this.debugView.look.z);
      return;
    }
    const t = bus.body.translation();
    const q = bus.body.rotation();
    this.busPos.set(t.x, t.y, t.z);
    // A teleport (reset, restart) snaps the camera instead of gliding through buildings.
    if (this.busPos.distanceTo(this.lastBus) > 15) this.first = true;
    this.lastBus.copy(this.busPos);
    this.busQuat.set(q.x, q.y, q.z, q.w);
    const h = bus.heading;
    this.flatFwd.set(Math.cos(h), 0, -Math.sin(h));

    // Switching views cuts instantly rather than swinging the camera through the bus.
    if (lookBack !== this.lookingBack) this.first = true;
    this.lookingBack = lookBack;
    if (lookBack) {
      this.camera.fov = BASE_FOV;
      this.camera.updateProjectionMatrix();
      const ahead = bus.preset.body.length / 2 + 11;
      this.camera.position.copy(this.busPos).addScaledVector(this.flatFwd, ahead);
      this.camera.position.y += 4.5;
      this.lookTarget.copy(this.busPos).addScaledVector(this.flatFwd, -bus.preset.body.length * 0.3);
      this.lookTarget.y += 1;
      this.camera.lookAt(this.lookTarget);
      return;
    }

    const speedFrac = Math.min(1, Math.abs(bus.speed) / (bus.preset.topSpeedKmh / 3.6));
    this.nitroFov += ((bus.boosting ? NITRO_FOV : 0) - this.nitroFov) * Math.min(1, dt * (bus.boosting ? 8 : 3));
    this.camera.fov = BASE_FOV + SPEED_FOV * speedFrac + this.nitroFov;
    this.camera.updateProjectionMatrix();

    if (this.mode === 'chase') this.chase(dt, bus, speedFrac);
    else this.cockpit(dt, bus);
    this.first = false;
  }

  private chase(dt: number, bus: BusPhysics, speedFrac: number): void {
    // Scaled to the vehicle: high and far behind a bus, lower and closer behind a car.
    const { length, height } = bus.preset.body;
    const back = Math.max(7, length * 1.3) + speedFrac * 4;
    const desired = this.tmp.copy(this.busPos).addScaledVector(this.flatFwd, -back);
    desired.y += Math.min(7, 2 + height * 1.8);
    const k = this.first ? 1 : 1 - Math.exp(-dt * 5);
    this.camera.position.lerp(desired, k);
    const look = this.tmp.copy(this.busPos).addScaledVector(this.flatFwd, 10);
    look.y += 1;
    this.lookTarget.lerp(look, this.first ? 1 : 1 - Math.exp(-dt * 10));
    this.camera.lookAt(this.lookTarget);
  }

  private cockpit(dt: number, bus: BusPhysics): void {
    const { length, width, height } = bus.preset.body;
    const [sx, sy, sz] = bus.preset.cockpit?.seat ?? [length / 2 - 1.6, height * 0.32, -width / 2 + 0.75];
    const seat = this.tmp.set(sx, sy, sz).applyQuaternion(this.busQuat);
    this.camera.position.copy(this.busPos).add(seat);
    // Head lags a little behind the chassis rotation so bumps and turns feel physical.
    const target = this.busQuat.clone().multiply(LOOK_FORWARD);
    if (this.first) this.headQuat.copy(target);
    else this.headQuat.slerp(target, 1 - Math.exp(-dt * 12));
    this.camera.quaternion.copy(this.headQuat);
  }
}
