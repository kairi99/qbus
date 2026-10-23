import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { Vec2 } from './cityData';
import { type Biome, terrainColors } from './biomes';
import { ChunkedMeshBuilder, hash2, vertexColorMaterial } from './meshBuilder';
import { BORE_HALF, BORE_RISE, BORE_TOP, BORE_WALL, MOUND_HALF, type TrackData, TUNNEL_TOP_STEP, trackPoint } from './track';

type Tunnel = NonNullable<TrackData['tunnels']>[number];

/** Rows of the bore and the mound every this many meters along. */
const STEP = 3;
/** Mound columns every this many meters across. */
const COLUMN = 2;
/** The mound stands at least this far over the deck (the bore's top plus rock), then climbs this steeply (rise per meter) from a portal up to the mountain. */
const MOUND_MIN = BORE_TOP + 2.4;
const MOUND_CLIMB = 0.75;
/** Across, the mound's top is a dome: it falls MOUND_DOME x across² m from the centerline, and is rough by up to MOUND_ROUGH m. */
const MOUND_DOME = 0.05;
const MOUND_ROUGH = 1.6;
/** Width of the concrete frame round each portal's arch (m). */
const FRAME = 0.7;
/** Lamps along the ceiling: first one this far in, then every LAMP_EVERY m, on each side. */
const LAMP_FIRST = 8;
const LAMP_EVERY = 15;
const LAMP_U = 2.6;
const LAMP_V = 5.95;
/** Rows per collider / mesh chunk. */
const CHUNK = 20;

/** One point of the bore's cross-section: across (+ right) and up from the deck, with the outward normal. */
export interface RingPoint {
  u: number;
  v: number;
  nu: number;
  nv: number;
}

/**
 * The bore's cross-section from the left side of the floor, up the wall and over the arch, to the
 * right: a shoulder strip each side of the asphalt, walls to `BORE_WALL`, a half-ellipse above.
 */
export function boreRing(asphaltHalf = 4.2, arch = 8): RingPoint[] {
  const out: RingPoint[] = [{ u: -asphaltHalf, v: 0, nu: 0, nv: -1 }, { u: -BORE_HALF, v: 0, nu: -1, nv: 0 }];
  for (let k = 0; k <= arch; k++) {
    const th = Math.PI - (k * Math.PI) / arch;
    const nu = Math.cos(th) / BORE_HALF;
    const nv = Math.sin(th) / BORE_RISE;
    const l = Math.hypot(nu, nv) || 1;
    out.push({ u: BORE_HALF * Math.cos(th), v: BORE_WALL + BORE_RISE * Math.sin(th), nu: nu / l, nv: nv / l });
  }
  out.push({ u: BORE_HALF, v: 0, nu: 1, nv: 0 }, { u: asphaltHalf, v: 0, nu: 0, nv: -1 });
  return out;
}

/** Rows (meters along) of a tunnel, `STEP` apart from end to end. */
export function tunnelRows(t: Tunnel): number[] {
  const out: number[] = [];
  const n = Math.max(1, Math.round((t.s1 - t.s0) / STEP));
  for (let k = 0; k <= n; k++) out.push(t.s0 + ((t.s1 - t.s0) * k) / n);
  return out;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The mountain over the deck `s` m along (the mound's top on the centerline): at least MOUND_MIN, climbing from a portal up to the DEM's height. */
export function moundRise(t: Tunnel, s: number): number {
  const f = Math.max(0, (s - t.s0) / TUNNEL_TOP_STEP);
  const i = Math.min(t.top.length - 1, Math.floor(f));
  const top = t.top[i] + ((t.top[Math.min(t.top.length - 1, i + 1)] - t.top[i]) * (f - i));
  return Math.max(MOUND_MIN, Math.min(top, MOUND_MIN + MOUND_CLIMB * Math.min(s - t.s0, t.s1 - s)));
}

/**
 * Height of the rock over a tunnel at `p` (`across` m right of the centerline, `s` along, deck at
 * `deck`): the mountain's mound near the road, blending into the plain `ground` (the terrain, cut
 * for the road) at MOUND_HALF either side, never under it.
 */
export function moundHeight(t: Tunnel, s: number, across: number, deck: number, ground: number): number {
  const a = Math.abs(across);
  // Rocky knobs (never negative: the rock over the bore stays as thick), fading toward the sides.
  const rough = MOUND_ROUGH * hash2(Math.round(s / STEP), Math.round(a / COLUMN), 41) * (1 - smoothstep(MOUND_HALF - 8, MOUND_HALF, a));
  const top = deck + moundRise(t, s) - MOUND_DOME * a * a + rough;
  return ground + Math.max(0, top - ground) * (1 - smoothstep(MOUND_HALF - 8, MOUND_HALF, a));
}

interface Frame {
  q: { x: number; z: number; y: number; dx: number; dz: number };
  /** Right of travel. */
  nx: number;
  nz: number;
}

function frameAt(race: TrackData, s: number): Frame {
  const q = trackPoint(race, s);
  return { q: { ...q }, nx: -q.dz, nz: q.dx };
}

/**
 * Draws and builds the solid of every tunnel on a track: the bore (rough rock walls and arch, dark,
 * lit by lamps baked into its colors and a row of lamp fittings), the mound of rock over it joining
 * the cut terrain, the two portals (concrete frame round the arch in a rock face). The bore and the
 * mound are smooth frictionless-walled trimeshes a vehicle slides along. The terrain itself is
 * only the road's ordinary cut, under the deck across the bore: the game's ground logic never sees a tunnel.
 */
export function buildTunnels(race: TrackData, ground: (p: Vec2) => number, world: RAPIER.World, fixed: RAPIER.RigidBody, scene: THREE.Scene, biome: Biome, night: boolean): void {
  const tunnels = race.tunnels;
  if (!tunnels?.length) return;
  const pal = terrainColors(biome);
  const ring = boreRing(race.width / 2);
  const faces = new ChunkedMeshBuilder(300);
  const lamps: THREE.Matrix4[] = [];
  const tmp = new THREE.Color();
  const veg = new THREE.Color();
  tunnels.forEach((tu, ti) => {
    const rows = tunnelRows(tu);
    const frames = rows.map((s) => frameAt(race, s));
    // The lamps, both sides, and what the first one's light reaches.
    const lampAt: number[] = [];
    for (let s = tu.s0 + LAMP_FIRST; s < tu.s1 - LAMP_FIRST + 0.1; s += LAMP_EVERY) lampAt.push(s);
    const m = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    for (const s of lampAt) {
      const f = frameAt(race, s);
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.q.dx, f.q.dz));
      for (const side of [-1, 1]) {
        m.compose(new THREE.Vector3(f.q.x + f.nx * side * LAMP_U, f.q.y + LAMP_V + 0.12, f.q.z + f.nz * side * LAMP_U), quat, new THREE.Vector3(1, 1, 1));
        lamps.push(m.clone());
      }
    }
    const light = (s: number, u: number, v: number) => {
      let sum = 0;
      const k0 = Math.round((s - tu.s0 - LAMP_FIRST) / LAMP_EVERY);
      for (let k = k0 - 1; k <= k0 + 1; k++) {
        if (k < 0 || k >= lampAt.length) continue;
        const ds = s - lampAt[k];
        const du = Math.abs(u) - LAMP_U;
        const dv = v - LAMP_V;
        sum += 1 / (1 + (ds * ds + du * du + dv * dv) / 10);
      }
      // Daylight spilling in from either mouth.
      const spill = Math.exp(-Math.min(s - tu.s0, tu.s1 - s) / 11) * (night ? 0.25 : 1);
      return Math.min(1.25, 0.1 + 0.95 * sum + 0.9 * spill);
    };

    // The bore: one vertex per ring point per row; rough outward (never into the swept space).
    const R = rows.length;
    const M = ring.length;
    const pos = new Float32Array(R * M * 3);
    const col = new Float32Array(R * M * 3);
    const smooth = new Float32Array(R * M * 3);
    for (let i = 0; i < R; i++) {
      const f = frames[i];
      for (let j = 0; j < M; j++) {
        const r = ring[j];
        const rough = j >= 2 && j <= M - 3 ? 0.08 + 0.34 * hash2(i, j, 11 + ti) : 0;
        const k = (i * M + j) * 3;
        smooth.set([f.q.x + f.nx * r.u, f.q.y + r.v, f.q.z + f.nz * r.u], k);
        pos.set([f.q.x + f.nx * (r.u + r.nu * rough), f.q.y + r.v + r.nv * rough, f.q.z + f.nz * (r.u + r.nu * rough)], k);
        const end = Math.min(rows[i] - tu.s0, tu.s1 - rows[i]);
        const floor = j <= 1 || j >= M - 2;
        // Rock, grey-brown and mottled; the first meters inside each mouth are concrete lining.
        if (floor) tmp.set('#6b665e');
        else if (end < 9) tmp.set('#8f8c85');
        else tmp.copy(pal.rock).multiplyScalar(0.5 + 0.35 * hash2(i, j, 5 + ti));
        tmp.multiplyScalar(light(rows[i], r.u, r.v));
        col.set([tmp.r, tmp.g, tmp.b], k);
      }
    }
    for (let c0 = 0; c0 < R - 1; c0 += CHUNK) {
      const c1 = Math.min(R - 1, c0 + CHUNK);
      const idx: number[] = [];
      for (let i = 0; i < c1 - c0; i++)
        for (let j = 0; j < M - 1; j++) {
          const a = i * M + j;
          idx.push(a, a + 1, a + M + 1, a, a + M + 1, a + M);
        }
      const rowsOf = (v: Float32Array) => v.slice(c0 * M * 3, (c1 + 1) * M * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(rowsOf(pos), 3));
      g.setAttribute('color', new THREE.BufferAttribute(rowsOf(col), 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, boreMaterial());
      mesh.name = 'tunnel-bore';
      scene.add(mesh);
      // Solid: the smooth ring (without the roughness).
      world.createCollider(
        RAPIER.ColliderDesc.trimesh(rowsOf(smooth), new Uint32Array(inward(idx)), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
        fixed,
      );
    }

    // The mound over the bore, across the road's cut: ground height plus the rock on top.
    const cols: number[] = [];
    for (let u = -MOUND_HALF; u <= MOUND_HALF + 0.01; u += COLUMN) cols.push(u);
    const C = cols.length;
    const mp = new Float32Array(R * C * 3);
    const mc = new Float32Array(R * C * 3);
    const at = (i: number, c: number): [number, number, number] => {
      const f = frames[i];
      const p = { x: f.q.x + f.nx * cols[c], z: f.q.z + f.nz * cols[c] };
      return [p.x, moundHeight(tu, rows[i], cols[c], f.q.y, ground(p)), p.z];
    };
    for (let i = 0; i < R; i++) for (let c = 0; c < C; c++) mp.set(at(i, c), (i * C + c) * 3);
    const normals = new Float32Array(R * C * 3);
    for (let i = 0; i < R; i++)
      for (let c = 0; c < C; c++) {
        const a = (Math.max(0, i - 1) * C + c) * 3;
        const b = (Math.min(R - 1, i + 1) * C + c) * 3;
        const l = (i * C + Math.max(0, c - 1)) * 3;
        const r = (i * C + Math.min(C - 1, c + 1)) * 3;
        const t1 = [mp[b] - mp[a], mp[b + 1] - mp[a + 1], mp[b + 2] - mp[a + 2]];
        const t2 = [mp[r] - mp[l], mp[r + 1] - mp[l + 1], mp[r + 2] - mp[l + 2]];
        // t1 along the road, t2 across: the surface normal points up.
        let n = [t1[1] * t2[2] - t1[2] * t2[1], t1[2] * t2[0] - t1[0] * t2[2], t1[0] * t2[1] - t1[1] * t2[0]];
        if (n[1] < 0) n = n.map((x) => -x);
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        normals.set([n[0] / len, n[1] / len, n[2] / len], (i * C + c) * 3);
        const ny = n[1] / len;
        const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(0.05, ny);
        const x = mp[(i * C + c) * 3];
        const z = mp[(i * C + c) * 3 + 2];
        // Bare rock mottled with earth; plant green only creeps in where the mound melts into the hillside.
        const grain = hash2(Math.floor(x / 5), Math.floor(z / 5), 3) * 0.5 + hash2(x, z, 9) * 0.5;
        tmp.copy(pal.rock).lerp(pal.earth, 0.45 * grain).multiplyScalar(0.7 + 0.5 * hash2(Math.floor(x / 2), Math.floor(z / 2), 17));
        const green = smoothstep(MOUND_HALF - 9, MOUND_HALF, Math.abs(cols[c])) * Math.max(0, 1 - slope * 1.5);
        if (green > 0) tmp.lerp(veg.copy(pal.low).lerp(pal.high, Math.min(1, grain + 0.2)), green);
        mc.set([tmp.r, tmp.g, tmp.b], (i * C + c) * 3);
      }
    for (let c0 = 0; c0 < R - 1; c0 += CHUNK) {
      const c1 = Math.min(R - 1, c0 + CHUNK);
      const idx: number[] = [];
      for (let i = 0; i < c1 - c0; i++)
        for (let c = 0; c < C - 1; c++) {
          const a = i * C + c;
          idx.push(a, a + C, a + 1, a + 1, a + C, a + C + 1);
        }
      const rowsOf = (v: Float32Array) => v.slice(c0 * C * 3, (c1 + 1) * C * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(rowsOf(mp), 3));
      g.setAttribute('color', new THREE.BufferAttribute(rowsOf(mc), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(rowsOf(normals), 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, vertexColorMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 }));
      mesh.receiveShadow = true;
      mesh.name = 'tunnel-mound';
      scene.add(mesh);
      world.createCollider(RAPIER.ColliderDesc.trimesh(rowsOf(mp), new Uint32Array(up(idx)), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(1), fixed);
    }

    // The portals.
    for (const end of [0, 1] as const) {
      const s = end ? tu.s1 : tu.s0;
      const f = frameAt(race, s);
      const out = end ? 1 : -1;
      portal(faces, tu, s, f, out, ground, pal.rock, pal.earth);
      glowCard(scene, ring, f, out);
    }
  });

  scene.add(...faces.build(vertexColorMaterial({ side: THREE.DoubleSide })));
  if (lamps.length) {
    const fit = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.1, 1.3), new THREE.MeshBasicMaterial({ color: night ? '#fff2c4' : '#ffeebb' }), lamps.length);
    lamps.forEach((m, i) => fit.setMatrixAt(i, m));
    fit.name = 'tunnel-lamps';
    fit.frustumCulled = false;
    scene.add(fit);
  }
}

/**
 * Rapier's internal-edge fix makes a trimesh one-sided (solid behind the faces' winding normals). The
 * bore's triangles are wound so their normals point outward, into the rock: turned round, the empty
 * bore is the front and the wall is solid from inside. (The mound's, wound downward, likewise.)
 */
const flip = (idx: number[]): number[] => idx.map((_, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]]);
const inward = flip;
const up = flip;

let shared: THREE.Material | null = null;
/** The bore's colors carry their own light (baked): nothing in a tunnel is lit by the sun. */
function boreMaterial(): THREE.Material {
  return (shared ??= new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

/**
 * One portal: the concrete frame round the arch and a rock face from it up to the mound's top, out
 * across the cut's slopes to where the mound meets the ground. `out`: which way is outside (-1 at
 * the entrance, +1 at the exit), along the track.
 */
function portal(mb: ChunkedMeshBuilder, tu: Tunnel, s: number, f: Frame, out: number, ground: (p: Vec2) => number, rock: THREE.Color, earth: THREE.Color): void {
  const deck = f.q.y;
  const P = (u: number, y: number, nudge = 0) => ({ x: f.q.x + f.nx * u + f.q.dx * out * nudge, y, z: f.q.z + f.nz * u + f.q.dz * out * nudge });
  const outer = (u: number) => {
    const a = BORE_HALF + FRAME;
    const x = Math.abs(u);
    return x >= a ? BORE_WALL : BORE_WALL + (BORE_RISE + FRAME) * Math.sqrt(Math.max(0, 1 - (x / a) ** 2));
  };
  const at = mb.at(f.q.x, f.q.z);
  const concrete = ['#9a978f', '#8f8c85'];
  // The frame: between the arch's ellipse and the one FRAME wider, plus a strip down each wall.
  const N = 14;
  for (let k = 0; k < N; k++) {
    const t0 = Math.PI - (k * Math.PI) / N;
    const t1 = Math.PI - ((k + 1) * Math.PI) / N;
    const e = (th: number, grow: number) => P((BORE_HALF + grow) * Math.cos(th), deck + BORE_WALL + (BORE_RISE + grow) * Math.sin(th), 0.04);
    at.quad(e(t0, 0), e(t1, 0), e(t1, FRAME), e(t0, FRAME), concrete[k % 2]);
  }
  for (const side of [-1, 1]) at.quad(P(side * BORE_HALF, deck - 0.8, 0.04), P(side * (BORE_HALF + FRAME), deck - 0.8, 0.04), P(side * (BORE_HALF + FRAME), deck + BORE_WALL, 0.04), P(side * BORE_HALF, deck + BORE_WALL, 0.04), concrete[0]);
  // The face: columns across the cut, from the frame's outside (or the cut's floor) up to the mound.
  const base = new THREE.Color();
  const bottom = (u: number) => (Math.abs(u) <= BORE_HALF + FRAME ? deck + outer(u) : Math.min(ground(P(u, 0, 2)), deck) - 0.8);
  const top = (u: number) => moundHeight(tu, s, u, deck, ground(P(u, 0, 0)));
  for (let u = -MOUND_HALF; u < MOUND_HALF; u += 1) {
    const [b0, b1, t0, t1] = [bottom(u), bottom(u + 1), top(u), top(u + 1)];
    if (t0 - b0 < 0.03 && t1 - b1 < 0.03) continue;
    base.copy(rock).lerp(earth, 0.4 * hash2(u, s, 21)).multiplyScalar(0.95 + 0.4 * hash2(Math.round(u), s, 4) + 0.12 * Math.sin((b0 + t0) * 1.7));
    at.quad(P(u, b0), P(u + 1, b1), P(u + 1, Math.max(b1, t1)), P(u, Math.max(b0, t0)), `#${base.getHexString()}`);
  }
}

/**
 * The daylight seen through a far mouth from inside the bore: an unfogged bright card filling the arch,
 * just inside the portal and facing into the bore (culled from outside). `RainView` shows it and
 * colors it like the sky while the camera is in a tunnel (`userData.tunnelGlow`).
 */
function glowCard(scene: THREE.Scene, ring: RingPoint[], f: Frame, out: number): void {
  const n = ring.length;
  const pos: number[] = [];
  const at = (u: number, v: number) => [f.q.x + f.nx * u - f.q.dx * out * 0.25, f.q.y + v, f.q.z + f.nz * u - f.q.dz * out * 0.25];
  // A fan from the middle of the opening round the ring (the floor strip's ends close it).
  for (let j = 1; j < n - 2; j++) pos.push(...at(0, 2), ...at(ring[j].u, ring[j].v), ...at(ring[j + 1].u, ring[j + 1].v));
  pos.push(...at(0, 2), ...at(ring[n - 2].u, ring[n - 2].v), ...at(ring[1].u, ring[1].v));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Wound to face into the bore (toward -out); fix by the first triangle's normal.
  const a = new THREE.Vector3().fromArray(pos, 0);
  const b = new THREE.Vector3().fromArray(pos, 3);
  const c = new THREE.Vector3().fromArray(pos, 6);
  const nrm = b.sub(a).cross(c.sub(a));
  if (nrm.x * f.q.dx * out + nrm.z * f.q.dz * out > 0) {
    const arr = g.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < arr.count; k += 3) {
      const [x, y, z] = [arr.getX(k + 1), arr.getY(k + 1), arr.getZ(k + 1)];
      arr.setXYZ(k + 1, arr.getX(k + 2), arr.getY(k + 2), arr.getZ(k + 2));
      arr.setXYZ(k + 2, x, y, z);
    }
  }
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#dfeaf0', fog: false }));
  mesh.name = 'tunnel-glow';
  mesh.userData.tunnelGlow = true;
  mesh.visible = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
}
