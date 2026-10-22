import * as THREE from 'three';
import type { BusPhysics } from './bus';

/** Puffs alive at once, for every vehicle together. */
const MAX_PUFFS = 220;
/** Puffs a second off a vehicle at full smoke (both driven wheels together). */
const RATE = 36;
const SMOKE = new THREE.Color('#e4e2de');
const DUST = new THREE.Color('#a08a6a');
const MUD = new THREE.Color('#5a4330');
/** Earth thrown up by a landslide: a little redder than the road's dust. */
const EARTH = new THREE.Color('#8f7757');

/**
 * How hard the tires smoke (0..1): sliding past 10° (a drift, a spin), or spinning on the spot
 * at the launch (`spin`: the throttle against wheels with no grip).
 */
export function smokeOf(slipRad: number, speed: number, spin: number): number {
  const slide = Math.min(1, Math.max(0, ((Math.abs(slipRad) * 180) / Math.PI - 10) / 20)) * Math.min(1, Math.abs(speed) / 8);
  return Math.max(slide, Math.min(1, Math.max(0, spin)));
}

/** Dust kicked up off the asphalt (0..1): `off` m past its edge, faster = more. */
export function dustOf(off: number, speed: number): number {
  return off > 0.2 && Math.abs(speed) > 3 ? Math.min(1, Math.abs(speed) / 15) : 0;
}

/**
 * Tire smoke and dust, every vehicle's in one instanced draw call: soft camera-facing puffs off
 * the driven wheels that grow, rise, drift and fade. Simulated on the CPU (a few hundred floats),
 * drawn like the mist (`mist.ts`).
 */
export class TireSmoke {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(MAX_PUFFS * 3);
  private vel = new Float32Array(MAX_PUFFS * 3);
  private age = new Float32Array(MAX_PUFFS).fill(Infinity);
  private life = new Float32Array(MAX_PUFFS);
  private grow = new Float32Array(MAX_PUFFS);
  private thick = new Float32Array(MAX_PUFFS);
  private center: THREE.InstancedBufferAttribute;
  private shape: THREE.InstancedBufferAttribute;
  private tint: THREE.InstancedBufferAttribute;
  private next = 0;
  private alive = 0;
  /** Each vehicle's share of a puff not yet let out. */
  private owed = new Map<BusPhysics, number>();
  private c = new THREE.Color();

  /** `light`: how bright the smoke looks (dim after dark). */
  constructor(scene: THREE.Scene, private light = 1) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.center = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.shape = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAX_PUFFS; i++) this.shape.setZ(i, (i * 0.618034) % 1);
    geo.setAttribute('center', this.center);
    geo.setAttribute('shape', this.shape);
    geo.setAttribute('tint', this.tint);
    geo.instanceCount = MAX_PUFFS;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute vec3 center; attribute vec3 shape; attribute vec3 tint;
        varying vec2 vUv; varying float vAlpha; varying float vSeed; varying vec3 vTint;
        void main() {
          vec4 mv = modelViewMatrix * vec4(center, 1.0);
          mv.xy += position.xy * shape.x;
          vUv = uv; vSeed = shape.z; vTint = tint;
          // Thinner with the camera right in it.
          vAlpha = shape.y * smoothstep(0.3, 2.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec2 vUv; varying float vAlpha; varying float vSeed; varying vec3 vTint;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float a = atan(p.y, p.x);
          float r = 0.8 + 0.12 * sin(a * 3.0 + vSeed * 31.0) + 0.06 * sin(a * 5.0 + vSeed * 13.0);
          float k = 1.0 - smoothstep(r * 0.2, r, length(p));
          if (k * vAlpha < 0.004) discard;
          gl_FragColor = vec4(vTint * (0.85 + 0.15 * vUv.y), k * k * vAlpha);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'tire-smoke';
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** One puff of earth dust at a point, with its own velocity, growth (m of radius), life (s) and thickness (0..1): landslides. */
  kick(x: number, y: number, z: number, vx: number, vy: number, vz: number, grow: number, life: number, thick: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PUFFS;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.grow[i] = grow;
    this.thick[i] = thick;
    const c = this.c.copy(EARTH).multiplyScalar(this.light);
    this.tint.setXYZ(i, c.r, c.g, c.b);
    this.alive = MAX_PUFFS;
  }

  /**
   * This frame's smoke and dust (0..1 each) off `bus`'s driven wheels; `mud` (0..1: how deep in
   * it the wheels are) flings brown spatter instead, the faster the more.
   */
  emit(bus: BusPhysics, smoke: number, dust: number, dt: number, mud = 0): void {
    const flung = mud > 0.1 ? Math.min(1, mud * Math.abs(bus.speed) / 10) : 0;
    const muddy = flung > dust && flung > smoke;
    if (muddy) dust = flung;
    const k = Math.max(smoke, dust);
    if (k <= 0.02) return;
    let owed = (this.owed.get(bus) ?? 0) + RATE * k * dt;
    if (owed < 1) return void this.owed.set(bus, owed);
    const w = bus.preset.wheels;
    const t = bus.body.translation();
    const h = bus.heading;
    const fx = Math.cos(h);
    const fz = -Math.sin(h);
    const v = bus.body.linvel();
    const y = bus.roadHeight() + 0.35;
    const color = this.c.copy(muddy ? MUD : dust > smoke ? DUST : SMOKE).multiplyScalar(this.light);
    for (let side = 0; owed >= 1; owed--, side ^= 1) {
      const across = side ? w.track : -w.track;
      const i = this.next;
      this.next = (this.next + 1) % MAX_PUFFS;
      const j = random();
      this.pos[i * 3] = t.x + fx * w.rearOffset - fz * across + (j - 0.5) * 0.4;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = t.z + fz * w.rearOffset + fx * across + (random() - 0.5) * 0.4;
      // Left behind the vehicle, carried a little along, spreading out and up.
      this.vel[i * 3] = v.x * 0.25 + (random() - 0.5) * 1.6;
      this.vel[i * 3 + 1] = 0.5 + random() * 0.6;
      this.vel[i * 3 + 2] = v.z * 0.25 + (random() - 0.5) * 1.6;
      this.age[i] = 0;
      this.life[i] = 1.1 + random() * 0.9 + k * 0.6;
      this.grow[i] = 2.4 + k * 2.6;
      this.thick[i] = (dust > smoke ? 0.6 : 0.55) * (0.6 + 0.4 * k);
      this.tint.setXYZ(i, color.r, color.g, color.b);
    }
    this.owed.set(bus, owed);
    this.alive = MAX_PUFFS;
  }

  /** Each frame: the puffs move on and fade. */
  update(dt: number): void {
    if (!this.alive) return;
    let alive = 0;
    for (let i = 0; i < MAX_PUFFS; i++) {
      if (this.age[i] >= this.life[i]) {
        this.shape.setY(i, 0);
        continue;
      }
      alive++;
      const a = (this.age[i] += dt);
      const u = Math.min(1, a / this.life[i]);
      const drag = Math.exp(-2.2 * dt);
      for (let k = 0; k < 3; k++) {
        this.vel[i * 3 + k] *= drag;
        this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      }
      this.center.setXYZ(i, this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.shape.setX(i, 0.9 + this.grow[i] * Math.sqrt(u));
      // In fast, then a long fade.
      this.shape.setY(i, this.thick[i] * Math.min(1, u * 8) * (1 - u) * (1 - u));
    }
    this.alive = alive;
    this.center.needsUpdate = true;
    this.shape.needsUpdate = true;
    this.tint.needsUpdate = true;
    this.mesh.visible = alive > 0;
  }

  /** Everything gone (a restart). */
  clear(): void {
    this.age.fill(Infinity);
    this.owed.clear();
    this.alive = 0;
    this.mesh.visible = false;
  }
}

const random = Math.random;
