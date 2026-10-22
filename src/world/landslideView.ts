import * as THREE from 'three';
import { GROUP, RAPIER, groups } from '../physics/world';
import type { Obstacle } from '../gameplay/traffic';
import {
  type BoulderPose,
  FALL,
  type SlideField,
  type SlideSite,
  WARN,
  boulderPose,
  fallProgress,
  mudAt,
  slideLoudness,
  slidePhase,
} from '../gameplay/landslides';
import type { Vec2 } from './cityData';
import { type TrackData, trackPoint } from './track';
import { hash2 } from './meshBuilder';
import type { TireSmoke } from '../vehicle/tireSmoke';

/** Dust, pebbles and sound are only made for slides this near the camera (m). */
const NEAR = 240;
/** Pebbles alive at once. */
const MAX_PEBBLES = 48;
/** Mud quads: along-road and across-road spacing (m). */
const ROW = 1.25;
const MUD_LIFT = 0.04;
/** The collider is this share of the boulder's radius (the mesh's bumps stick out of it). */
const HULL = 0.9;
const MUD_LIGHT = new THREE.Color('#6a5238');
const MUD_DARK = new THREE.Color('#3b2a1c');
const smooth = (a: number, b: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

interface BoulderBody {
  body: RAPIER.RigidBody | null;
  mode: 'none' | 'rolling' | 'fixed';
}

interface Pebble {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  floor: number;
  size: number;
  bounces: number;
}

/**
 * The landslides of a race track on screen and in the physics world (`gameplay/landslides.ts`
 * says what happens when): boulders (one instanced mesh, low-poly rocks), the mud tongues and
 * the always-there mud (one transparent mesh draped on the road deck, its alpha following the
 * fall), dust off the cut (the tire smoke's pool) and pebbles. Each boulder is a kinematic ball
 * moved from the race time while it rolls, then a fixed one in the STATIC group, so it is solid
 * for every vehicle and R reset and nothing wakes.
 */
export class LandslideView {
  /** Landed boulders as boxes for the traffic to keep out of. */
  readonly obstacles: Obstacle[] = [];
  private rocks: THREE.InstancedMesh;
  private mud: THREE.Mesh;
  private pebbles: THREE.InstancedMesh;
  private pool: Pebble[] = [];
  private mudAlpha: Float32Array;
  private mudBase: Float32Array;
  /** Vertex ranges of each mud piece: its site (or -1: an always-there patch) and first/last vertex. */
  private pieces: { site: number; from: number; to: number }[] = [];
  private grown: number[];
  private wetShown = -1;
  private bodies: BoulderBody[][];
  private flat: { site: number; k: number }[] = [];
  private pose: BoulderPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private s3 = new THREE.Vector3();
  private squash: THREE.Vector3[] = [];
  /** Per boulder: its last drawn state (0 hidden, 1 hanging, 2 rolling, 3 at rest), so settled ones aren't rewritten. */
  private drawn: number[] = [];
  private owed = 0;
  private pebbleOwed = 0;
  private seen = 0;
  private loud = { rumble: 0, fall: 0 };
  private ear: Vec2 = { x: 0, z: 0 };

  constructor(
    private scene: THREE.Scene,
    private world: RAPIER.World,
    private track: TrackData,
    private field: SlideField,
    public smoke: TireSmoke | null,
    private ground: (p: Vec2) => number,
    light = 1,
  ) {
    const sites = field.sites;
    this.bodies = sites.map((s) => s.boulders.map(() => ({ body: null, mode: 'none' as const })));
    this.grown = sites.map(() => 0);
    sites.forEach((s, i) => s.boulders.forEach((_, k) => this.flat.push({ site: i, k })));

    // Rocks: an icosahedron with its corners pushed in and out (the same push for a shared corner), flat shaded.
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const k = 0.72 + 0.28 * hash2(Math.round(x * 50), Math.round(y * 50 + z * 90), 3);
      pos.setXYZ(i, x * k, y * k, z * k);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 0.95, metalness: 0 });
    this.rocks = new THREE.InstancedMesh(geo, mat, Math.max(1, this.flat.length));
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;
    this.rocks.frustumCulled = false;
    this.rocks.name = 'landslide-rocks';
    const c = new THREE.Color();
    this.flat.forEach(({ site, k }, i) => {
      const b = field.sites[site].boulders[k];
      const h = hash2(Math.round(b.rest.x), Math.round(b.rest.z), 5);
      c.setHSL(0.07 + 0.03 * h, 0.12 + 0.1 * h, (0.26 + 0.14 * hash2(i, site, 7)) * light);
      this.rocks.setColorAt(i, c);
      this.squash.push(new THREE.Vector3(1, 0.7 + 0.25 * hash2(i, 1, 11), 0.85 + 0.15 * hash2(i, 2, 13)));
      this.drawn.push(0);
      this.hide(i);
    });
    if (this.rocks.instanceColor) this.rocks.instanceColor.needsUpdate = true;
    this.rocks.instanceMatrix.needsUpdate = true;
    scene.add(this.rocks);

    // Pebbles: tiny rocks thrown off the cut.
    this.pebbles = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: new THREE.Color('#6d6458').multiplyScalar(light), flatShading: true, roughness: 1 }), MAX_PEBBLES);
    this.pebbles.frustumCulled = false;
    this.pebbles.visible = false;
    this.pebbles.name = 'landslide-pebbles';
    for (let i = 0; i < MAX_PEBBLES; i++) {
      this.pool.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, floor: 0, size: 0.1, bounces: 0 });
      this.pebbles.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
    }
    scene.add(this.pebbles);

    // Mud: one draped mesh for every tongue and patch.
    const hw = track.width / 2;
    const verts: number[] = [];
    const base: number[] = [];
    const idx: number[] = [];
    const cols: number[] = [];
    const addGrid = (site: number, s0: number, s1: number, side: 1 | -1, u0: number, u1: number, mudOf: (s: number, u: number) => number) => {
      const rows = Math.max(2, Math.ceil((s1 - s0) / ROW));
      const nc = Math.max(2, Math.ceil((u1 - u0) / 0.7));
      const first = base.length;
      for (let r = 0; r <= rows; r++) {
        const s = s0 + ((s1 - s0) * r) / rows;
        for (let cI = 0; cI <= nc; cI++) {
          const u = u0 + ((u1 - u0) * cI) / nc;
          const q = trackPoint(track, s);
          const off = u * side;
          verts.push(q.x - q.dz * off, q.y + MUD_LIFT, q.z + q.dx * off);
          const m = mudOf(s, off);
          base.push(m);
          cols.push(0, 0, 0, 0);
        }
      }
      for (let r = 0; r < rows; r++)
        for (let cI = 0; cI < nc; cI++) {
          const a = first + r * (nc + 1) + cI;
          const b = a + 1;
          const d = a + nc + 1;
          idx.push(a, d, b, b, d, a + nc + 2);
        }
      this.pieces.push({ site, from: first, to: base.length });
    };
    sites.forEach((site, i) => {
      const lo = site.s - site.len / 2 - 3;
      const hi = site.s + site.len / 2 + 3;
      addGrid(i, lo, hi, site.side, -1.9, hw, (s, off) => mudAt({ sites: [site], patches: [] }, 1e9, s, off, 0, hw));
    });
    for (const p of field.patches) addGrid(-1, p.s - p.len / 2 - 4, p.s + p.len / 2 + 4, 1, -hw, hw, (s, off) => mudAt({ sites: [], patches: [p] }, 0, s, off, 0, hw));
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.mudAlpha = new Float32Array(base.length);
    this.mudBase = Float32Array.from(base);
    for (let i = 0; i < base.length; i++) {
      const col = MUD_LIGHT.clone().lerp(MUD_DARK, Math.min(1, base[i])).multiplyScalar(light);
      cols[i * 4] = col.r;
      cols[i * 4 + 1] = col.g;
      cols[i * 4 + 2] = col.b;
    }
    mg.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4).setUsage(THREE.DynamicDrawUsage));
    mg.setIndex(idx);
    mg.computeVertexNormals();
    // Draped flat: the normals all point up (the road's own shading).
    const nrm = mg.getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const mudMat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    this.mud = new THREE.Mesh(mg, mudMat);
    this.mud.renderOrder = 1;
    this.mud.frustumCulled = false;
    this.mud.name = 'landslide-mud';
    this.mud.visible = false;
    scene.add(this.mud);
    this.writeAlpha(0, 0, true);
  }

  private hide(i: number): void {
    this.rocks.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
  }

  /** Mud alphas from how far each site has fallen (`t`) and how wet the road is (the patches). */
  private writeAlpha(t: number, wet: number, force = false): void {
    let changed = force;
    this.field.sites.forEach((s, i) => {
      const g = smooth(s.trigger + WARN, s.trigger + WARN + FALL + 1.5, t);
      if (Math.abs(g - this.grown[i]) > 0.004 || (g !== this.grown[i] && (g === 0 || g === 1))) {
        this.grown[i] = g;
        changed = true;
      }
    });
    if (Math.abs(wet - this.wetShown) > 0.02) {
      this.wetShown = wet;
      changed = true;
    }
    if (!changed) return;
    const color = this.mud.geometry.getAttribute('color') as THREE.BufferAttribute;
    let any = false;
    for (const p of this.pieces) {
      const g = p.site >= 0 ? this.grown[p.site] : 1;
      const k = p.site >= 0 ? 1 : 1 + 0.6 * wet;
      for (let i = p.from; i < p.to; i++) {
        const a = smooth(0.04, 0.45, Math.min(1, this.mudBase[i] * k) * g);
        if (a > 0) any = true;
        this.mudAlpha[i] = a;
        color.setW(i, a);
      }
    }
    color.needsUpdate = true;
    this.mud.visible = any;
  }

  /** The physics step at race time `t`: kinematic boulders to where they are, landed ones turned into fixed ones. */
  step(t: number): void {
    const sites = this.field.sites;
    for (let i = 0; i < this.flat.length; i++) {
      const { site, k } = this.flat[i];
      const s = sites[site];
      const st = this.bodies[site][k];
      const tau = fallProgress(s, k, t);
      const b = s.boulders[k];
      if (tau <= 0 || tau >= 1) {
        const want = tau >= 1 ? 'fixed' : 'none';
        if (st.mode === want) continue;
        this.drop(site, k);
        if (want === 'fixed') this.land(site, k);
        continue;
      }
      boulderPose(this.track, s, k, t, this.pose);
      if (st.mode !== 'rolling') {
        this.drop(site, k);
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pose.x, this.pose.y, this.pose.z));
        this.world.createCollider(RAPIER.ColliderDesc.ball(b.r * HULL).setFriction(0.9).setRestitution(0.1), body);
        st.body = body;
        st.mode = 'rolling';
      }
      st.body!.setNextKinematicTranslation(this.pose);
      st.body!.setNextKinematicRotation({ x: this.pose.qx, y: this.pose.qy, z: this.pose.qz, w: this.pose.qw });
    }
  }

  private drop(site: number, k: number): void {
    const st = this.bodies[site][k];
    if (st.body) this.world.removeRigidBody(st.body);
    st.body = null;
    st.mode = 'none';
    const at = this.obstacles.findIndex((o) => o.id === `rock${site}.${k}`);
    if (at >= 0) this.obstacles.splice(at, 1);
  }

  private land(site: number, k: number): void {
    const b = this.field.sites[site].boulders[k];
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.rest.x, b.rest.y, b.rest.z));
    this.world.createCollider(RAPIER.ColliderDesc.ball(b.r * HULL).setFriction(0.9).setCollisionGroups(groups(GROUP.STATIC, GROUP.ALL)), body);
    const st = this.bodies[site][k];
    st.body = body;
    st.mode = 'fixed';
    this.obstacles.push({ id: `rock${site}.${k}`, pos: { x: b.rest.x, z: b.rest.z }, heading: 0, length: b.r * 1.8, width: b.r * 1.8 });
  }

  /** Each frame: boulders, mud, dust and pebbles at race time `t` for a camera at `ear`; `wet` 0..1 (the always-there mud). */
  update(t: number, dt: number, ear: Vec2, wet: number): void {
    this.ear = ear;
    this.writeAlpha(t, wet);
    const sites = this.field.sites;
    let touched = false;
    for (let i = 0; i < this.flat.length; i++) {
      const { site, k } = this.flat[i];
      const s = sites[site];
      const phase = slidePhase(s, t);
      const tau = fallProgress(s, k, t);
      const state = phase === 'idle' ? 0 : tau <= 0 ? 1 : tau < 1 ? 2 : 3;
      if (state === this.drawn[i] && state !== 2) continue;
      this.drawn[i] = state;
      touched = true;
      if (state === 0) {
        this.hide(i);
        continue;
      }
      boulderPose(this.track, s, k, t, this.pose);
      const p = this.pose;
      const r = s.boulders[k].r;
      this.q.set(p.qx, p.qy, p.qz, p.qw);
      const sq = this.squash[i];
      this.rocks.setMatrixAt(i, this.m4.compose(this.v3.set(p.x, p.y, p.z), this.q, this.s3.set(r * sq.x, r * sq.y, r * sq.z)));
    }
    if (touched) this.rocks.instanceMatrix.needsUpdate = true;
    this.effects(t, dt);
    slideLoudness(sites, t, ear, this.loud);
  }

  /** Sound levels at the camera (0..1): the rumble and the rockfall. */
  get loudness(): { rumble: number; fall: number } {
    return this.loud;
  }

  /** Dust off the cut and the rolling boulders, pebbles flying. */
  private effects(t: number, dt: number): void {
    const smoke = this.smoke;
    let wantPebbles = 0;
    for (let si = 0; si < this.field.sites.length; si++) {
      const site = this.field.sites[si];
      const since = t - site.trigger;
      if (since < 0 || since > WARN + FALL + 4) continue;
      if (Math.hypot(site.at.x - this.ear.x, site.at.z - this.ear.z) > NEAR) continue;
      const warning = since < WARN;
      const falling = since >= WARN && since < WARN + FALL;
      // Dust off the cut: a thin trickle, then more as it lets go, a settling cloud after.
      const rate = warning ? 4 + 14 * (since / WARN) : falling ? 40 : 10 * (1 - (since - WARN - FALL) / 4);
      wantPebbles += warning ? 7 + 8 * (since / WARN) : falling ? 26 : 0;
      this.owed += rate * dt;
      while (this.owed >= 1 && smoke) {
        this.owed -= 1;
        const b = site.boulders[(Math.random() * site.boulders.length) | 0];
        // Anywhere between where it hangs and where it ends up, at the ground.
        const f = warning ? Math.random() * 0.15 : Math.random();
        const x = b.start.x + (b.rest.x - b.start.x) * f;
        const z = b.start.z + (b.rest.z - b.start.z) * f;
        const y = f > 0.85 ? b.rest.y - 0.6 * b.r : this.ground({ x, z }) + 0.3;
        smoke.kick(x + (Math.random() - 0.5) * 3, y, z + (Math.random() - 0.5) * 3, (b.rest.x - b.start.x) * 0.04, 0.5 + Math.random() * 0.8, (b.rest.z - b.start.z) * 0.04, 2.5 + Math.random() * 2.5, 1.8 + Math.random() * 1.6, warning ? 0.32 : 0.5);
      }
      if (since >= WARN && since < WARN + FALL + 0.1) this.landingBursts(site, t, dt);
    }
    this.pebbleOwed += wantPebbles * dt;
    while (this.pebbleOwed >= 1) {
      this.pebbleOwed -= 1;
      // Spawned only near the camera: the site nearest to it that is making any.
      this.throwPebble(t);
    }
    this.stepPebbles(dt);
  }

  /** A puff when a boulder reaches the road (once, as it lands). */
  private landingBursts(site: SlideSite, t: number, dt: number): void {
    const smoke = this.smoke;
    if (!smoke) return;
    for (let k = 0; k < site.boulders.length; k++) {
      const b = site.boulders[k];
      const tau = fallProgress(site, k, t);
      const before = fallProgress(site, k, t - dt);
      if (!(tau >= 1 && before < 1)) continue;
      for (let j = 0; j < 3; j++) smoke.kick(b.rest.x + (Math.random() - 0.5) * b.r, b.rest.y - 0.5 * b.r, b.rest.z + (Math.random() - 0.5) * b.r, (Math.random() - 0.5) * 3, 0.8 + Math.random(), (Math.random() - 0.5) * 3, 3 + b.r * 2, 2.2 + Math.random(), 0.55);
    }
  }

  private throwPebble(t: number): void {
    const near = this.field.sites.filter((s) => t - s.trigger >= 0 && t - s.trigger <= WARN + FALL && Math.hypot(s.at.x - this.ear.x, s.at.z - this.ear.z) < NEAR);
    if (!near.length) return;
    const site = near[(Math.random() * near.length) | 0];
    const p = this.pool.find((q) => q.life <= 0);
    if (!p) return;
    const b = site.boulders[(Math.random() * site.boulders.length) | 0];
    const f = Math.random() * 0.4;
    p.x = b.start.x + (b.rest.x - b.start.x) * f + (Math.random() - 0.5) * 6;
    p.z = b.start.z + (b.rest.z - b.start.z) * f + (Math.random() - 0.5) * 6;
    p.y = this.ground({ x: p.x, z: p.z }) + 0.2;
    const dx = b.rest.x - b.start.x;
    const dz = b.rest.z - b.start.z;
    const d = Math.hypot(dx, dz) || 1;
    const v = 1.5 + Math.random() * 3;
    p.vx = (dx / d) * v + (Math.random() - 0.5);
    p.vz = (dz / d) * v + (Math.random() - 0.5);
    p.vy = 0.5 + Math.random() * 1.5;
    p.life = 2.5;
    p.size = 0.07 + Math.random() * 0.12;
    p.bounces = 0;
    p.floor = trackPoint(this.track, site.s).y;
  }

  private stepPebbles(dt: number): void {
    let alive = 0;
    for (let i = 0; i < MAX_PEBBLES; i++) {
      const p = this.pool[i];
      if (p.life <= 0) {
        if (p.size > 0) {
          this.pebbles.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
          p.size = 0;
        }
        continue;
      }
      alive++;
      p.life -= dt;
      p.vy -= 16 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const g = Math.max(this.ground({ x: p.x, z: p.z }), 0);
      // The road deck stands over the slope's foot: land on whichever is higher near it.
      const floor = Math.abs(p.y - p.floor) < 3 ? Math.max(g, p.floor) : g;
      if (p.y < floor + p.size) {
        p.y = floor + p.size;
        if (p.bounces++ >= 2) p.life = 0;
        p.vy = Math.abs(p.vy) * 0.35;
        p.vx *= 0.6;
        p.vz *= 0.6;
      }
      const h = (p.life * 7 + i) * 0.5;
      this.q.set(Math.sin(h) * 0.5, Math.sin(h * 1.3) * 0.5, 0, 1).normalize();
      this.pebbles.setMatrixAt(i, this.m4.compose(this.v3.set(p.x, p.y, p.z), this.q, this.s3.set(p.size, p.size, p.size)));
    }
    this.pebbles.instanceMatrix.needsUpdate = true;
    this.pebbles.visible = alive > 0;
  }

  /** Back to the start of the race: no body left, boulders hidden (the next `update` and `step` bring it all to the race time). */
  reset(): void {
    for (let site = 0; site < this.bodies.length; site++) for (let k = 0; k < this.bodies[site].length; k++) this.drop(site, k);
    this.obstacles.length = 0;
    this.drawn.fill(-1);
    for (const p of this.pool) p.life = 0;
    this.writeAlpha(0, 0, true);
  }

  dispose(): void {
    this.reset();
    for (const m of [this.rocks, this.mud, this.pebbles]) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
