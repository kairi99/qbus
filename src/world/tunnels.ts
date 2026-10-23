import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { Vec2 } from './cityData';
import { type Biome, terrainColors } from './biomes';
import { ChunkedMeshBuilder, hash2, vertexColorMaterial } from './meshBuilder';
import { applyRock } from './rockTexture';
import { BORE_HALF, BORE_RISE, BORE_TOP, BORE_WALL, MOUND_HALF, type TrackData, TUNNEL_TOP_STEP, trackPoint } from './track';

type Tunnel = NonNullable<TrackData['tunnels']>[number];

function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const w = f * f * (3 - 2 * f);
  const a = hash2(i, seed, 71);
  return a + (hash2(i + 1, seed, 71) - a) * w;
}

/**
 * How far the bore's rock stands outward of the plain ring (m, always 0.15..0.5) `s` m along:
 * smooth noise of ~9 and ~19 m wavelength, so the cross-section wanders and the walls lean in and out
 * without ever coming nearer the road than `boreRing`. `k`: 0 left wall, 1 right wall, 2 crown.
 */
export function boreWander(ti: number, s: number, k: 0 | 1 | 2): number {
  const seed = ti * 3 + k;
  return 0.15 + 0.35 * (0.65 * valueNoise(seed, s / 19) + 0.35 * valueNoise(seed + 50, s / 9));
}

/** Rows of the bore and the mound every this many meters along. */
const STEP = 3;
/** Mound columns every this many meters across. */
const COLUMN = 2;
/** The mound stands at least this far over the deck (the bore's top plus rock), then climbs this steeply (rise per meter) from a portal up to the mountain. */
const MOUND_MIN = BORE_TOP + 2.4;
const MOUND_CLIMB = 0.75;
/** Across, the mound's top is flat over the bore's width plus MOUND_CORE m, then its flanks fall MOUND_FLANK m per m out, rough by up to MOUND_ROUGH m. */
export const MOUND_CORE = BORE_HALF + 4;
const MOUND_FLANK = 0.5;
const MOUND_ROUGH = 1.6;
/** Past the flat top the mound is no thicker than this over the ground (m). */
const MOUND_SKIN = 2;
/** The flanks melt into the hillside over this last stretch (m) before MOUND_HALF, not in a few meters: no spine, no step at the edge. */
export const MOUND_BLEND = 22;
/** Width of the concrete frame round each portal's arch (m). */
const FRAME = 0.7;
/** Sodium lamps along the ceiling, on the right side only: first one this far in, then every LAMP_EVERY m. */
const LAMP_FIRST = 8;
const LAMP_EVERY = 12;
const LAMP_U = 2.6;
const LAMP_V = 5.95;
/** The light of a lamp pool (warm sodium orange) and of daylight spilling in. */
const SODIUM: [number, number, number] = [1.15, 0.7, 0.3];
/** Concrete curb on each side of the asphalt: a dark gutter strip first, then the curb. */
const GUTTER = 0.35;
const CURB_W = 0.5;
const CURB_H = 0.2;
/** The road-facing side is a ramp this deep (m) rather than a step, so a wheel rolls up it. */
const CURB_CHAMFER = 0.25;
/** Reflective wall markers every this many m, this high up the wall. */
const MARKER_EVERY = 25;
const MARKER_V = 1.2;
/** Rows per collider / mesh chunk. */
const CHUNK = 20;
/** Length of the concrete hood sticking out of each portal (m, two rows). */
export const HOOD = 6;
/** The hood's outside half width, its roof's height over the deck, and the headwall's: wider and taller, in front of it. */
const HOOD_W = BORE_HALF + 0.8;
const HOOD_TOP = BORE_TOP + 0.9;
const HEAD_W = HOOD_W + 2.2;
const HEAD_TOP = BORE_TOP + 1.9;
/** The name plate on the headwall: half width, height, and its middle over the deck. */
const PLATE_HALF = 3.5;
const PLATE_H = 1.05;
const PLATE_V = 7.55;
const HOOD_CONCRETE = '#7e7b74';

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
 * The most the mound rises over the deck `s` m along (m): the lower of the two hillsides' heights just
 * outside its flat top, never under MOUND_MIN. Over a gully the rock fills the gully's floor to the
 * level of its sides (the mountain over the bore is the hill it runs through), not up to the DEM's
 * peak on the centerline, which stood as a wall over the cut.
 */
export function moundCrest(race: TrackData, s: number, ground: (p: Vec2) => number): number {
  const q = trackPoint(race, s);
  const n = { x: -q.dz, z: q.dx };
  const r = MOUND_CORE + 8;
  const left = ground({ x: q.x - n.x * r, z: q.z - n.z * r });
  const right = ground({ x: q.x + n.x * r, z: q.z + n.z * r });
  return Math.max(MOUND_MIN, Math.min(left, right) - q.y);
}

/**
 * Height of the rock over a tunnel at `p` (`across` m right of the centerline, `s` along, deck at
 * `deck`): the mountain's mound over and beside the bore (no higher over the deck than `crest`, see
 * `moundCrest`), its flanks falling to a thin cover of MOUND_SKIN m over the plain `ground` (the
 * terrain, cut for the road) past the flat top, and melting into the ground at MOUND_HALF either
 * side, never under it.
 */
export function moundHeight(t: Tunnel, s: number, across: number, deck: number, ground: number, crest = Infinity): number {
  const a = Math.abs(across);
  // Squared so it flattens out to nothing at the edge: the mound's last meters follow the ground's own slope.
  const melt = (1 - smoothstep(MOUND_HALF - MOUND_BLEND, MOUND_HALF, a)) ** 2;
  // Rocky knobs (never negative: the rock over the bore stays as thick), fading toward the sides.
  const rough = MOUND_ROUGH * hash2(Math.round(s / STEP), Math.round(a / COLUMN), 41) * melt;
  let excess = deck + Math.min(crest, moundRise(t, s)) - MOUND_FLANK * Math.max(0, a - MOUND_CORE) + rough - ground;
  if (a > MOUND_CORE && excess > MOUND_SKIN) excess = MOUND_SKIN + (excess - MOUND_SKIN) * (1 - smoothstep(MOUND_CORE, MOUND_CORE + 8, a));
  return ground + Math.max(0, excess) * melt;
}

/** A hanging fern or vine: hangs `len` m down from `top` (absolute height), `across` m right of the track's centerline at a portal, over a deck `deck` high. */
export interface HoodVine {
  x: number;
  z: number;
  top: number;
  len: number;
  across: number;
  deck: number;
  turn: number;
  shade: number;
}

/**
 * The ferns and vines hanging over each hood's lip and each headwall's top edge, visual only. Over the
 * opening (within the bore's half width + 1 m) they stay at least 0.3 m over the bore's top: the
 * headwall's top is 1.9 m above it, the strands there at most 1.5 m long, and none hang in front of
 * the name plate.
 */
export function hoodVines(race: TrackData): HoodVine[] {
  const out: HoodVine[] = [];
  (race.tunnels ?? []).forEach((tu, ti) => {
    for (const end of [0, 1] as const) {
      const out1 = end ? 1 : -1;
      const sOut = end ? tu.s1 + HOOD : tu.s0 - HOOD;
      const head = frameAt(race, sOut);
      const turn = Math.atan2(head.q.dx * out1, head.q.dz * out1);
      const put = (f: Frame, across: number, top: number, len: number, k: number) => {
        out.push({ x: f.q.x + f.nx * across, z: f.q.z + f.nz * across, top: f.q.y + top, len, across, deck: f.q.y, turn: turn + hash2(k, ti * 2 + end, 61) * 6, shade: hash2(k, ti * 2 + end, 63) });
      };
      // Along the headwall's top edge, except in front of the plate; short over the opening, long beyond it.
      let k = 0;
      for (let u = -HEAD_W + 0.3; u <= HEAD_W - 0.3; u += 0.55) {
        k++;
        if (Math.abs(u) < PLATE_HALF + 0.2 || hash2(k, ti * 2 + end, 65) < 0.25) continue;
        const free = Math.abs(u) > BORE_HALF + 1;
        const len = (free ? 1.1 + 1.9 * hash2(k, ti * 2 + end, 67) : 0.5 + 1.0 * hash2(k, ti * 2 + end, 67));
        put(head, u, HEAD_TOP, len, k);
      }
      // Down the hood's two side lips, outside the opening.
      for (let a = 0.5; a < HOOD; a += 0.9) {
        k++;
        const f = frameAt(race, end ? tu.s1 + a : tu.s0 - a);
        for (const side of [-1, 1]) if (hash2(k, side + ti * 4, 69) > 0.3) put(f, side * (HOOD_W + 0.3), HOOD_TOP, 0.8 + 1.8 * hash2(k, side, 71), k * 2 + side);
      }
    }
  });
  return out;
}

/**
 * The plate's words, or null for no plate: only a tunnel whose OSM name itself starts with "Tunel" / "Túnel" gets one
 * ("TÚNEL " + the rest in capitals); a name copied from the road ("Ruta de las Cascadas") is no tunnel name.
 */
export function plateText(name?: string): string | null {
  const m = name?.trim().match(/^t[uú]nel\s+(.+)$/i);
  return m ? `TÚNEL ${m[1].trim().toUpperCase()}` : null;
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
  const cliff = biome.cliff ?? { earth: 0.9, rock: 1.3 };
  const ring = boreRing(race.width / 2);
  const faces = new ChunkedMeshBuilder(300);
  const lamps: THREE.Matrix4[] = [];
  const markers: { m: THREE.Matrix4; side: number }[] = [];
  const plates: { text: string; f: Frame; out: number }[] = [];
  const tmp = new THREE.Color();
  const veg = new THREE.Color();
  tunnels.forEach((tu, ti) => {
    // The bore's rows run on through the concrete hood at each end (HOOD m, two rows), whose lining has no rock wander.
    const rows = [tu.s0 - HOOD, tu.s0 - HOOD / 2, ...tunnelRows(tu), tu.s1 + HOOD / 2, tu.s1 + HOOD];
    const frames = rows.map((s) => frameAt(race, s));
    // The lamps, both sides, and what the first one's light reaches.
    const lampAt: number[] = [];
    for (let s = tu.s0 + LAMP_FIRST; s < tu.s1 - LAMP_FIRST + 0.1; s += LAMP_EVERY) lampAt.push(s);
    const m = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    for (const s of lampAt) {
      const f = frameAt(race, s);
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(f.q.dx, f.q.dz));
      m.compose(new THREE.Vector3(f.q.x + f.nx * LAMP_U, f.q.y + LAMP_V + 0.12, f.q.z + f.nz * LAMP_U), quat, new THREE.Vector3(1, 1, 1));
      lamps.push(m.clone());
    }
    const light = (s: number, u: number, v: number, out: [number, number, number]) => {
      let sum = 0;
      const k0 = Math.round((s - tu.s0 - LAMP_FIRST) / LAMP_EVERY);
      for (let k = k0 - 1; k <= k0 + 1; k++) {
        if (k < 0 || k >= lampAt.length) continue;
        const ds = s - lampAt[k];
        const du = u - LAMP_U;
        const dv = v - LAMP_V;
        sum += 1 / (1 + (ds * ds + du * du + dv * dv) / 6);
      }
      // Daylight spilling in from either mouth.
      const spill = Math.exp(-Math.max(0, Math.min(s - tu.s0, tu.s1 - s)) / 11) * (night ? 0.25 : 1);
      const lamp = 1.1 * sum * sum;
      const base = 0.2 + 0.9 * spill;
      for (let c = 0; c < 3; c++) out[c] = Math.min(1.4, base * (0.95 + 0.05 * c) + lamp * SODIUM[c]);
    };
    const lit: [number, number, number] = [0, 0, 0];

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
        const end = Math.min(rows[i] - tu.s0, tu.s1 - rows[i]);
        const hood = end < 0;
        const rock = j >= 2 && j <= M - 3 && !hood;
        // The rock stands out by the cross-section's wander (the solid follows it); the surface is rough on top of it.
        let wander = 0;
        if (rock) {
          const crown = Math.pow(Math.abs(r.nv), 2);
          wander = boreWander(ti, rows[i], r.u < 0 ? 0 : 1) * (1 - crown) + boreWander(ti, rows[i], 2) * crown;
        }
        const rough = rock ? 0.08 + 0.34 * hash2(i, j, 11 + ti) : 0;
        const k = (i * M + j) * 3;
        smooth.set([f.q.x + f.nx * (r.u + r.nu * wander), f.q.y + r.v + r.nv * wander, f.q.z + f.nz * (r.u + r.nu * wander)], k);
        const o = wander + rough;
        pos.set([f.q.x + f.nx * (r.u + r.nu * o), f.q.y + r.v + r.nv * o, f.q.z + f.nz * (r.u + r.nu * o)], k);
        const floor = j <= 1 || j >= M - 2;
        // Rock, grey-brown and mottled; the hood and the first meters inside each mouth are concrete lining.
        if (floor) tmp.set('#6b665e');
        else if (hood) tmp.set(HOOD_CONCRETE).multiplyScalar(0.9 + 0.2 * hash2(i, j, 7 + ti));
        else if (end < 9) tmp.set('#8f8c85');
        else tmp.set('#5a544c').multiplyScalar(0.75 + 0.45 * hash2(i, j, 5 + ti));
        // Wet dark streaks running down the walls and arch, longer where water seeps along a joint.
        if (end >= 9 && r.v < 4.6 && j >= 1 && j <= M - 2) {
          const seep = hash2(i, r.u < 0 ? 1 : 2, 33 + ti);
          const run = hash2(i, r.u < 0 ? 3 : 4, 35 + ti);
          // Dark runs down the lower walls, darkest at the foot; a third of the rows have one.
          if (seep > 0.62) tmp.multiplyScalar(1 - (0.5 + 0.35 * run) * (1 - r.v / 4.6));
        }
        light(rows[i], r.u, r.v, lit);
        col.set([tmp.r * lit[0], tmp.g * lit[1], tmp.b * lit[2]], k);
      }
    }
    // Reflective markers on both walls every MARKER_EVERY m, MARKER_V up, found on the drawn wall between two rows.
    for (let s = tu.s0 + MARKER_EVERY; s < tu.s1 - 10; s += MARKER_EVERY) {
      let i = 0;
      while (i < R - 2 && rows[i + 1] < s) i++;
      const w = (s - rows[i]) / (rows[i + 1] - rows[i]);
      const q = frameAt(race, s);
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(q.q.dx, q.q.dz));
      for (const [side, j0, j1] of [[-1, 1, 2], [1, M - 2, M - 3]] as const) {
        const wall = new THREE.Vector3();
        const tt = MARKER_V / BORE_WALL;
        for (const [row, wt] of [[i, 1 - w], [i + 1, w]] as const) {
          const a = (row * M + j0) * 3;
          const b = (row * M + j1) * 3;
          wall.x += wt * (pos[a] + (pos[b] - pos[a]) * tt);
          wall.y += wt * (pos[a + 1] + (pos[b + 1] - pos[a + 1]) * tt);
          wall.z += wt * (pos[a + 2] + (pos[b + 2] - pos[a + 2]) * tt);
        }
        // A hair out of the wall, toward the middle.
        wall.x -= q.nx * side * 0.04;
        wall.z -= q.nz * side * 0.04;
        m.compose(wall, quat, new THREE.Vector3(1, 1, 1));
        markers.push({ m: m.clone(), side });
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
      const nb = (c1 - c0 + 1) * M;
      // The curbs (4 profile points per side per row) join the same mesh and the same trimesh; the gutters' strips are drawn only.
      const curbs = curbGeometry(frames.slice(c0, c1 + 1), rows.slice(c0, c1 + 1), race.width / 2, nb, (s, u, v, out) => light(s, u, v, out));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(concat(rowsOf(pos), curbs.pos, curbs.gutterPos), 3));
      g.setAttribute('color', new THREE.BufferAttribute(concat(rowsOf(col), curbs.col, curbs.gutterCol), 3));
      g.setIndex([...idx, ...curbs.idx, ...curbs.gutterIdx]);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, boreMaterial());
      mesh.name = 'tunnel-bore';
      scene.add(mesh);
      // Solid: the smooth ring (without the roughness) and the curbs, wound to face into the empty space.
      world.createCollider(
        RAPIER.ColliderDesc.trimesh(concat(rowsOf(smooth), curbs.pos), new Uint32Array([...inward(idx), ...curbs.solidIdx]), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
        fixed,
      );
    }

    // The mound over the bore, across the road's cut: ground height plus the rock on top.
    // The mound spans the tunnel itself only (the hood in front of each portal is outside it).
    const mrows = rows.slice(2, R - 2);
    const mframes = frames.slice(2, R - 2);
    const MR = mrows.length;
    const cols: number[] = [];
    for (let u = -MOUND_HALF; u <= MOUND_HALF + 0.01; u += COLUMN) cols.push(u);
    const C = cols.length;
    const mp = new Float32Array(MR * C * 3);
    const mc = new Float32Array(MR * C * 3);
    const crests = mrows.map((s) => moundCrest(race, s, ground));
    const at = (i: number, c: number): [number, number, number] => {
      const f = mframes[i];
      const p = { x: f.q.x + f.nx * cols[c], z: f.q.z + f.nz * cols[c] };
      return [p.x, moundHeight(tu, mrows[i], cols[c], f.q.y, ground(p), crests[i]), p.z];
    };
    for (let i = 0; i < MR; i++) for (let c = 0; c < C; c++) mp.set(at(i, c), (i * C + c) * 3);
    const normals = new Float32Array(MR * C * 3);
    for (let i = 0; i < MR; i++)
      for (let c = 0; c < C; c++) {
        const a = (Math.max(0, i - 1) * C + c) * 3;
        const b = (Math.min(MR - 1, i + 1) * C + c) * 3;
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
        // Colored like the hillside it belongs to: grass and forest floor, earth then rock as it gets steep (the terrain's own rule).
        const grain = hash2(Math.floor(x / 40), Math.floor(z / 40), 3) * 0.5 + hash2(x, z, 9) * 0.15;
        tmp.copy(pal.low).lerp(veg.copy(pal.high), Math.max(0, Math.min(1, grain * 0.6 + 0.2)));
        if (slope > cliff.earth) tmp.lerp(slope > cliff.rock ? pal.rock : pal.earth, Math.min(1, (slope - cliff.earth) * 2));
        mc.set([tmp.r, tmp.g, tmp.b], (i * C + c) * 3);
      }
    for (let c0 = 0; c0 < MR - 1; c0 += CHUNK) {
      const c1 = Math.min(MR - 1, c0 + CHUNK);
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
      const mesh = new THREE.Mesh(g, moundMaterial());
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
      // The hood's three frames, from the portal outward.
      const hf = end ? [frames[R - 3], frames[R - 2], frames[R - 1]] : [frames[2], frames[1], frames[0]];
      portal(race, faces, tu, s, f, out, ground, pal.rock, pal.earth, hf, ti);
      glowCard(scene, ring, hf[2], out);
      const text = plateText(tu.name);
      if (text) plates.push({ text, f: hf[2], out });
    }
  });

  // Portal rock and concrete get the rock grain too (concrete less so); the mound's steep flanks as well.
  const faceMat = vertexColorMaterial({ side: THREE.DoubleSide });
  applyRock(faceMat, { slopeOnly: false, strength: 0.45 });
  scene.add(...faces.build(faceMat));
  addPlates(scene, plates);
  addVines(scene, hoodVines(race));
  if (markers.length) {
    const mk = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.34, 0.22), new THREE.MeshBasicMaterial({ color: '#ffffff' }), markers.length);
    const white = new THREE.Color('#f2f0e6');
    const amber = new THREE.Color('#ffb04a');
    markers.forEach((k, i) => {
      mk.setMatrixAt(i, k.m);
      mk.setColorAt(i, k.side < 0 ? white : amber);
    });
    mk.name = 'tunnel-markers';
    mk.frustumCulled = false;
    scene.add(mk);
  }
  if (lamps.length) {
    // Each fitting: a small dark housing and a smaller warm emissive lens under it (two instanced draws).
    const housing = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.12, 0.6), new THREE.MeshBasicMaterial({ color: '#1b1a19' }), lamps.length);
    const lens = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.04, 0.4).translate(0, -0.08, 0), new THREE.MeshBasicMaterial({ color: night ? '#ffb858' : '#ffa848', fog: false }), lamps.length);
    lamps.forEach((m, i) => {
      housing.setMatrixAt(i, m);
      lens.setMatrixAt(i, m);
    });
    housing.name = 'tunnel-lamps';
    lens.name = 'tunnel-lamp-lenses';
    for (const o of [housing, lens]) {
      o.frustumCulled = false;
      scene.add(o);
    }
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
/** The bore's colors carry their own light (baked): nothing in a tunnel is lit by the sun. The rock grain is laid over them. */
function boreMaterial(): THREE.Material {
  if (!shared) {
    shared = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    applyRock(shared, { slopeOnly: false, strength: 0.8 });
  }
  return shared;
}

let mound: THREE.Material | null = null;
/** The mound's rock: grain on its steep flanks, the grassy top stays plain. */
function moundMaterial(): THREE.Material {
  if (!mound) {
    mound = vertexColorMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 3 });
    applyRock(mound, { slopeOnly: true });
  }
  return mound;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of parts) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/**
 * The concrete curbs (CURB_W wide, CURB_H high) a gutter's width off the asphalt on both sides, along
 * the given rows, plus the dark gutter strips between asphalt and curb (drawn only, flush with the
 * deck). Curb vertices are 4 per side per row (front foot, front top, back top, back foot) and
 * start at index `base`; gutters start after them. `idx` draws them, `solidIdx` is the curbs only,
 * wound so every face's normal points out of the curb into the empty bore (a one-sided trimesh is
 * solid behind its normals).
 */
function curbGeometry(frames: Frame[], rows: number[], half: number, base: number, shade: (s: number, u: number, v: number, out: [number, number, number]) => void) {
  const n = frames.length;
  const a0 = half + GUTTER;
  const prof: [number, number][] = [[a0, 0], [a0 + CURB_CHAMFER, CURB_H], [a0 + CURB_W, CURB_H], [a0 + CURB_W, 0]];
  const pos = new Float32Array(n * 8 * 3);
  const col = new Float32Array(n * 8 * 3);
  const gPos = new Float32Array(n * 4 * 3);
  const gCol = new Float32Array(n * 4 * 3);
  const lit: [number, number, number] = [0, 0, 0];
  const concrete = new THREE.Color('#9a968c');
  const gutter = new THREE.Color('#0b0b0a');
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    for (let sd = 0; sd < 2; sd++) {
      const side = sd ? 1 : -1;
      for (let p = 0; p < 4; p++) {
        const u = side * prof[p][0];
        const k = (i * 8 + sd * 4 + p) * 3;
        pos.set([f.q.x + f.nx * u, f.q.y + prof[p][1], f.q.z + f.nz * u], k);
        shade(rows[i], u, prof[p][1], lit);
        const top = p === 1 || p === 2 ? 1 : 0.8;
        col.set([concrete.r * top * lit[0], concrete.g * top * lit[1], concrete.b * top * lit[2]], k);
      }
      for (let e = 0; e < 2; e++) {
        const u = side * (half + e * GUTTER);
        const k = (i * 4 + sd * 2 + e) * 3;
        gPos.set([f.q.x + f.nx * u, f.q.y + 0.03, f.q.z + f.nz * u], k);
        shade(rows[i], u, 0, lit);
        gCol.set([gutter.r * lit[0], gutter.g * lit[1], gutter.b * lit[2]], k);
      }
    }
  }
  const idx: number[] = [];
  const solidIdx: number[] = [];
  const gutterIdx: number[] = [];
  const gBase = base + n * 8;
  for (let sd = 0; sd < 2; sd++) {
    // Which winding turns the top face up, tried on the first row (both sides may differ: the profile is mirrored).
    const A = (sd * 4 + 1) * 3;
    const B = (sd * 4 + 2) * 3;
    const D = (8 + sd * 4 + 2) * 3;
    const e1 = [pos[B] - pos[A], pos[B + 1] - pos[A + 1], pos[B + 2] - pos[A + 2]];
    const e2 = [pos[D] - pos[A], pos[D + 1] - pos[A + 1], pos[D + 2] - pos[A + 2]];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const flipSide = n > 1 && ny < 0;
    for (let i = 0; i < n - 1; i++) {
      for (let p = 0; p < 3; p++) {
        const a = base + i * 8 + sd * 4 + p;
        const [b, c, d] = [a + 1, a + 8, a + 9];
        const tri = flipSide ? [a, d, b, a, c, d] : [a, b, d, a, d, c];
        idx.push(...tri);
        solidIdx.push(...tri);
      }
      const g = gBase + i * 4 + sd * 2;
      // Up-facing too (the render is double sided; it is not solid).
      gutterIdx.push(g, g + 1, g + 5, g, g + 5, g + 4);
    }
  }
  return { pos, col, idx, solidIdx, gutterPos: gPos, gutterCol: gCol, gutterIdx };
}

/**
 * One portal: the rock face from the bore's mouth up to the mound's top, out across the cut's slopes
 * to where the mound meets the ground, with a concrete hood in front of it (`HOOD` m long, a roof slab
 * and two walls round the arch, the arch itself being the bore's own extra rows) ending in a headwall
 * with mossy streaks, taller and wider than the hood. `out`: which way is outside (-1 at the
 * entrance, +1 at the exit), along the track. `hf`: the frames at the mouth, mid hood and hood end.
 */
function portal(race: TrackData, mb: ChunkedMeshBuilder, tu: Tunnel, s: number, f: Frame, out: number, ground: (p: Vec2) => number, rock: THREE.Color, earth: THREE.Color, hf: Frame[], ti: number): void {
  const deck = f.q.y;
  const P = (u: number, y: number, nudge = 0) => ({ x: f.q.x + f.nx * u + f.q.dx * out * nudge, y, z: f.q.z + f.nz * u + f.q.dz * out * nudge });
  const H = (k: number, u: number, y: number) => ({ x: hf[k].q.x + hf[k].nx * u, y: hf[k].q.y + y, z: hf[k].q.z + hf[k].nz * u });
  const at = mb.at(f.q.x, f.q.z);
  const tone = (k: number, g = 1) => `#${new THREE.Color(HOOD_CONCRETE).multiplyScalar(g * (0.92 + 0.16 * hash2(k, ti, 81))).getHexString()}`;
  // The hood: two walls (down to under the deck) and a roof with a lip, along its two spans.
  for (let k = 0; k < 2; k++) {
    for (const side of [-1, 1]) at.quad(H(k, side * HOOD_W, -0.8), H(k + 1, side * HOOD_W, -0.8), H(k + 1, side * HOOD_W, HOOD_TOP), H(k, side * HOOD_W, HOOD_TOP), tone(k + side * 3));
    at.quad(H(k, -HOOD_W - 0.3, HOOD_TOP), H(k + 1, -HOOD_W - 0.3, HOOD_TOP), H(k + 1, HOOD_W + 0.3, HOOD_TOP), H(k, HOOD_W + 0.3, HOOD_TOP), tone(k + 9, 1.08));
  }
  // The headwall: columns round the arch's opening, in bands from the bottom up to its top; moss runs down from the top in streaks, the foot is grimy.
  const arch = (u: number) => (Math.abs(u) >= BORE_HALF ? BORE_WALL : BORE_WALL + BORE_RISE * Math.sqrt(1 - (u / BORE_HALF) ** 2));
  const moss = new THREE.Color('#4f6e30');
  const col = new THREE.Color();
  const BAND = 0.5;
  const STEPU = 0.5;
  for (let u = -HEAD_W; u < HEAD_W - 0.01; u += STEPU) {
    const um = u + STEPU / 2;
    const bottom = Math.abs(um) < BORE_HALF ? arch(um) : -0.8;
    const streak = hash2(Math.round(u * 2), ti, 83) > 0.4 ? 0.8 + 3.6 * hash2(Math.round(u * 2), ti, 85) : 0;
    for (let y = bottom; y < HEAD_TOP - 0.01; y += BAND) {
      const y1 = Math.min(HEAD_TOP, y + BAND);
      const depth = HEAD_TOP - (y + y1) / 2;
      col.set(HOOD_CONCRETE).multiplyScalar(1.06 * (0.9 + 0.2 * hash2(Math.round(u * 2), Math.round(y * 2), 87)));
      // Dirt gathers at the foot and under the lip.
      col.multiplyScalar(0.78 + 0.22 * Math.min(1, (y + 0.8) / 2.5));
      if (depth < streak) col.lerp(moss, Math.min(0.85, 0.85 * (1 - depth / streak) + 0.1));
      at.quad(H(2, u, y), H(2, u + STEPU, y), H(2, u + STEPU, y1), H(2, u, y1), `#${col.getHexString()}`);
    }
  }
  // The headwall's top edge, half a meter deep.
  const Hc = (u: number) => {
    const [a, b] = [H(2, u, HEAD_TOP), H(1, u, HEAD_TOP)];
    return { x: a.x + (b.x - a.x) * 0.17, y: a.y, z: a.z + (b.z - a.z) * 0.17 };
  };
  at.quad(H(2, -HEAD_W, HEAD_TOP), H(2, HEAD_W, HEAD_TOP), Hc(HEAD_W), Hc(-HEAD_W), tone(11, 1.1));
  // The rock face behind: columns across the cut, from the hood's outside (or the cut's floor) up to the mound.
  const base = new THREE.Color();
  const bottom = (u: number) => (Math.abs(u) <= HOOD_W + 0.3 ? deck + HOOD_TOP - 0.1 : Math.min(ground(P(u, 0, 2)), deck) - 0.8);
  const crest = moundCrest(race, s, ground);
  const top = (u: number) => moundHeight(tu, s, u, deck, ground(P(u, 0, 0)), crest);
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

/**
 * One instanced draw for every hanging fern and vine: a tapered strand of two crossed cards, one meter
 * tall hanging from its origin (scaled to `len`), tinted per instance. Visual only.
 */
function addVines(scene: THREE.Scene, vines: HoodVine[]): void {
  if (!vines.length) return;
  const pos: number[] = [];
  const col: number[] = [];
  const leaf = new THREE.Color('#ffffff');
  // Each card: a leafy fan narrowing to a tip; three bands so it droops in a curve.
  for (const rot of [0, Math.PI / 2]) {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const seg = (w0: number, y0: number, w1: number, y1: number, sh: number) => {
      const v = (w: number, y: number) => [w * c, y, w * sn];
      for (const p of [v(-w0, y0), v(w0, y0), v(w1, y1), v(-w0, y0), v(w1, y1), v(-w1, y1)]) {
        pos.push(...p);
        col.push(leaf.r * sh, leaf.g * sh, leaf.b * sh);
      }
    };
    seg(0.2, 0, 0.16, -0.4, 1);
    seg(0.16, -0.4, 0.1, -0.75, 0.88);
    seg(0.1, -0.75, 0, -1, 0.75);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), vines.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color();
  vines.forEach((v, i) => {
    q.setFromAxisAngle(up, v.turn);
    m.compose(new THREE.Vector3(v.x, v.top, v.z), q, new THREE.Vector3(1.3, v.len, 1.3));
    mesh.setMatrixAt(i, m);
    // Fern green to dull vine green.
    tint.setHSL(0.24 + 0.06 * v.shade, 0.5, 0.3 + 0.12 * v.shade);
    mesh.setColorAt(i, tint);
  });
  mesh.name = 'tunnel-vines';
  mesh.frustumCulled = false;
  scene.add(mesh);
}

/**
 * The name plates ("TÚNEL …", white on green) on the headwalls: one small canvas holds every
 * distinct name, one mesh draws them all. Nothing without a DOM (Node tests) or a name.
 */
function addPlates(scene: THREE.Scene, plates: { text: string; f: Frame; out: number }[]): void {
  if (!plates.length || typeof document === 'undefined') return;
  const texts = [...new Set(plates.map((p) => p.text))];
  const W = 1024;
  const RH = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = RH * texts.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  texts.forEach((t, r) => {
    const y = r * RH;
    ctx.fillStyle = '#0f6b3c';
    ctx.fillRect(0, y, W, RH);
    ctx.strokeStyle = '#f4f4ee';
    ctx.lineWidth = 6;
    ctx.strokeRect(6, y + 6, W - 12, RH - 12);
    ctx.fillStyle = '#f4f4ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 72;
    ctx.font = `bold ${size}px sans-serif`;
    while (ctx.measureText(t).width > W - 70 && size > 16) ctx.font = `bold ${(size -= 4)}px sans-serif`;
    ctx.fillText(t, W / 2, y + RH / 2 + 4);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const pos: number[] = [];
  const uv: number[] = [];
  for (const p of plates) {
    const r = texts.indexOf(p.text);
    // Text reads left to right as seen from outside: along +across at an entrance, against it at an exit.
    const dir = p.out < 0 ? 1 : -1;
    const P = (a: number, v: number) => [p.f.q.x + p.f.nx * a * dir - p.f.q.dx * p.out * -0.03, p.f.q.y + v, p.f.q.z + p.f.nz * a * dir - p.f.q.dz * p.out * -0.03];
    const v0 = 1 - (r + 1) / texts.length;
    const v1 = 1 - r / texts.length;
    const lo = PLATE_V - PLATE_H / 2;
    const hi = PLATE_V + PLATE_H / 2;
    pos.push(...P(-PLATE_HALF, lo), ...P(PLATE_HALF, lo), ...P(PLATE_HALF, hi), ...P(-PLATE_HALF, lo), ...P(PLATE_HALF, hi), ...P(-PLATE_HALF, hi));
    uv.push(0, v0, 1, v0, 1, v1, 0, v0, 1, v1, 0, v1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  mesh.name = 'tunnel-plates';
  mesh.frustumCulled = false;
  scene.add(mesh);
}
