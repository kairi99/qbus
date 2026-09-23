import * as THREE from 'three';
import type { BusPhysics } from '../vehicle/bus';

export type CameraMode = 'chase' | 'cockpit';

const BASE_FOV = 68;
const SPEED_FOV = 14;
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

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  toggle(): CameraMode {
    this.mode = this.mode === 'chase' ? 'cockpit' : 'chase';
    this.first = true;
    return this.mode;
  }

  /** Dev/testing: fixed viewpoint instead of following the bus. */
  debugView: { pos: THREE.Vector3Like; look: THREE.Vector3Like } | null = null;

  update(dt: number, bus: BusPhysics): void {
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

    const speedFrac = Math.min(1, Math.abs(bus.speed) / (bus.preset.topSpeedKmh / 3.6));
    this.camera.fov = BASE_FOV + SPEED_FOV * speedFrac;
    this.camera.updateProjectionMatrix();

    if (this.mode === 'chase') this.chase(dt, bus, speedFrac);
    else this.cockpit(dt, bus);
    this.first = false;
  }

  private chase(dt: number, bus: BusPhysics, speedFrac: number): void {
    const back = bus.preset.body.length * 1.3 + speedFrac * 4;
    const desired = this.tmp.copy(this.busPos).addScaledVector(this.flatFwd, -back);
    desired.y += 7;
    const k = this.first ? 1 : 1 - Math.exp(-dt * 5);
    this.camera.position.lerp(desired, k);
    const look = this.tmp.copy(this.busPos).addScaledVector(this.flatFwd, 10);
    look.y += 1;
    this.lookTarget.lerp(look, this.first ? 1 : 1 - Math.exp(-dt * 10));
    this.camera.lookAt(this.lookTarget);
  }

  private cockpit(dt: number, bus: BusPhysics): void {
    const { length, width, height } = bus.preset.body;
    const seat = this.tmp.set(length / 2 - 1.6, height * 0.32, -width / 2 + 0.75).applyQuaternion(this.busQuat);
    this.camera.position.copy(this.busPos).add(seat);
    // Head lags a little behind the chassis rotation so bumps and turns feel physical.
    const target = this.busQuat.clone().multiply(LOOK_FORWARD);
    if (this.first) this.headQuat.copy(target);
    else this.headQuat.slerp(target, 1 - Math.exp(-dt * 12));
    this.camera.quaternion.copy(this.headQuat);
  }
}
