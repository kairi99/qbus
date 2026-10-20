import * as THREE from 'three';
import { type TrackData, trackPoint } from '../world/track';
import type { Pickups } from './pickups';

/** Canister floats this high over the road (m), bobbing this much, spinning this fast (rad/s). */
const FLOAT = 1.4;
const BOB = 0.15;
const SPIN = 2.4;
/** Seconds a pickup takes to grow back in when it returns. */
const GROW = 0.4;

/**
 * The nitro pickups on the road: a blue canister with a white band and a glowing orange ring
 * around it, floating and spinning over each spot. Two instanced draw calls for all of them; a
 * taken one shrinks away and grows back when it returns.
 */
export class PickupView {
  private cans: THREE.InstancedMesh;
  private rings: THREE.InstancedMesh;
  private base: { x: number; y: number; z: number }[];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3();
  private clock = 0;
  /** How far each has grown back in (0..1). */
  private grown: Float32Array;

  constructor(
    private scene: THREE.Scene,
    track: TrackData,
    private pickups: Pickups,
  ) {
    const can = new THREE.CylinderGeometry(0.45, 0.45, 1.25, 12);
    // Band and cap colors are vertex colors: one material, one draw.
    const pos = can.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const blue = new THREE.Color('#1e6bff');
    const white = new THREE.Color('#f4f6ff');
    for (let i = 0; i < pos.count; i++) (Math.abs(pos.getY(i)) < 0.18 || pos.getY(i) > 0.58 ? white : blue).toArray(colors, i * 3);
    can.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.cans = new THREE.InstancedMesh(can, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: '#0a2a80' }), track.pickups.length);
    this.rings = new THREE.InstancedMesh(
      new THREE.TorusGeometry(0.95, 0.1, 6, 24),
      new THREE.MeshBasicMaterial({ color: '#ffa21f', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      track.pickups.length,
    );
    this.base = track.pickups.map((p) => {
      const q = trackPoint(track, p.s);
      return { x: q.x - q.dz * p.off, y: q.y + FLOAT, z: q.z + q.dx * p.off };
    });
    this.grown = new Float32Array(this.base.length).fill(1);
    for (const mesh of [this.cans, this.rings]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    this.update(0);
  }

  update(dt: number): void {
    this.clock += dt;
    const t = this.clock;
    this.base.forEach((b, i) => {
      // Gone at once when taken; grows back in over GROW seconds once it's back.
      const g = (this.grown[i] = this.pickups.gone[i] > 0 ? 0 : Math.min(1, this.grown[i] + dt / GROW));
      const s = Math.max(1e-4, g * g * (3 - 2 * g));
      this.v.set(b.x, b.y + Math.sin(t * 2 + i) * BOB, b.z);
      this.sc.set(s, s, s);
      this.q.setFromEuler(this.e.set(0.25, t * SPIN + i, 0));
      this.cans.setMatrixAt(i, this.m.compose(this.v, this.q, this.sc));
      this.q.setFromEuler(this.e.set(Math.PI / 2, 0, t * SPIN * 0.5));
      this.rings.setMatrixAt(i, this.m.compose(this.v, this.q, this.sc));
    });
    this.cans.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.cans, this.rings);
  }
}
