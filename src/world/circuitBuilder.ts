import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { CircuitData, CityData, Vec2 } from './cityData';
import type { BuildingIndex } from './facades';
import { type ChunkedMeshBuilder, ChunkedUVQuadBuilder } from './meshBuilder';
import { railSolid } from './railSolid';
import type { RoadIndex } from './roadIndex';
import { type Fan, circuitFans, crowdMesh } from './spectators';
import { type TrackData } from './track';
import { gantry } from './trackBuilder';

/** Items inside the barrier offsets plus this much (m) are cleared: the barrier's base reaches 0.6 m past its face. */
export const KEEP_PAD = 0.7;

/** Jersey barrier: height, base and top widths (m); the course-side face is at the lap's `left`/`right` offset. */
const BARRIER_H = 0.8;
const BASE_W = 0.6;
const TOP_W = 0.15;
/** Barrier top stripes alternate red and white this often along the lap (m). */
const STRIPE = 2;
const GREY = '#c4c4bf';
const STRIPES = ['#d12a2a', '#f4f4f0'];
/** The barrier's solid is a slab this thick (railSolid's), its course face at the offset. */
const SLAB_HALF = 0.15;
/** Mouth fence: a mesh panel this tall standing on the barrier. */
const MOUTH_FENCE_H = 2;
/** Crowd-control fence behind the barrier: height and distance of its face from the barrier face. */
const SIDE_FENCE_H = 1.2;
const SIDE_FENCE_AT = BASE_W + 0.15;
/** A barrier that steps sideways more than this between two lap points (m) is a diagonal wall across a mouth. */
const STEEP = 0.4;
/** One mesh cell of the fence texture (m). */
const MESH_CELL = 0.4;

/** Jersey profile as (outward distance from the face, height): vertical lip, sloped shoulder, flat top. */
const PROFILE: [number, number][] = [
  [0, -0.1],
  [0, 0.2],
  [((BASE_W - TOP_W) / 2) * 0.5, 0.5],
  [(BASE_W - TOP_W) / 2, BARRIER_H],
  [(BASE_W + TOP_W) / 2, BARRIER_H],
  [BASE_W - ((BASE_W - TOP_W) / 2) * 0.5, 0.5],
  [BASE_W, 0.2],
  [BASE_W, -0.1],
];
/** Profile segments (index of their first point) that carry the red/white stripes. */
const STRIPED = new Set([2, 3, 4]);

/**
 * Is a point on the course: within the barrier offsets (plus `pad`) of the lap's centerline? Used
 * to keep everything else static (trees, lamps, shelters, signals, props) off a circuit race.
 */
export function courseInside(c: CircuitData, pad = 0): (p: Vec2) => boolean {
  const CELL = 16;
  const pts = c.points;
  const n = pts.length - 1;
  const cells = new Map<string, number[]>();
  const key = (x: number, z: number) => `${x},${z}`;
  for (let i = 0; i < n; i++) {
    const r = Math.max(c.left[i], c.right[i], c.left[i + 1], c.right[i + 1]) + pad + 1;
    const x0 = Math.min(pts[i].x, pts[i + 1].x) - r;
    const x1 = Math.max(pts[i].x, pts[i + 1].x) + r;
    const z0 = Math.min(pts[i].z, pts[i + 1].z) - r;
    const z1 = Math.max(pts[i].z, pts[i + 1].z) + r;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = key(cx, cz);
        const list = cells.get(k);
        if (list) list.push(i);
        else cells.set(k, [i]);
      }
  }
  return (p) => {
    for (const i of cells.get(key(Math.floor(p.x / CELL), Math.floor(p.z / CELL))) ?? []) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2;
      // A little past each end: the wedge outside a bend between two segments' normals.
      if (t < -0.25 || t > 1.25) continue;
      const k = Math.max(0, Math.min(1, t));
      const lat = ((p.x - a.x) * -dz + (p.z - a.z) * dx) / Math.sqrt(len2);
      const right = c.right[i] + (c.right[i + 1] - c.right[i]) * k;
      const left = c.left[i] + (c.left[i + 1] - c.left[i]) * k;
      if (lat <= right + pad && lat >= -(left + pad)) return true;
    }
    return false;
  };
}

/** A wall's points minus the ones on the course, as the runs of two or more that remain. */
export function wallRuns(points: Vec2[], out: (p: Vec2) => boolean): Vec2[][] {
  const runs: Vec2[][] = [];
  let run: Vec2[] = [];
  for (const p of points) {
    if (out(p)) {
      if (run.length >= 2) runs.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

export interface CircuitDressing {
  city: CityData;
  race: TrackData;
  /** Drawn sidewalk-level ground height at a point. */
  ground: (p: Vec2) => number;
  roads: RoadIndex;
  buildings: BuildingIndex;
  /** The course itself, no padding (a spot of another part of the lap is not for a crowd). */
  onCourse: (p: Vec2) => boolean;
  solid: ChunkedMeshBuilder;
  paint: ChunkedMeshBuilder;
  scene: THREE.Scene;
  world: RAPIER.World;
  fixed: RAPIER.RigidBody;
}

/** A wire-mesh fence texture: grey wires on clear glass, for alpha-tested panels. */
function fenceMaterial(): THREE.Material {
  const N = 32;
  const px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const wire = x % 16 < 3 || y % 16 < 3;
      px.set(wire ? [150, 156, 162, 255] : [0, 0, 0, 0], (y * N + x) * 4);
    }
  const tex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.2, side: THREE.DoubleSide });
}

/**
 * The circuit's dressing: a jersey barrier along both sides of the whole lap (drawn into the
 * city's merged solid tiles; the solid is one smooth frictionless trimesh per side, which also
 * shuts every side-street mouth, since the course's edge runs straight across it), a 2 m mesh fence
 * on the barrier across each mouth, a 1.2 m crowd-control fence where people can stand behind it,
 * the crowd, and the SALIDA / META gantry. Everything merged or instanced; the fences are alpha
 * tested quads in coarse tiles.
 */
export function dressCircuit(d: CircuitDressing): { fans: number } {
  const c = d.race.circuit!.data;
  const n = c.points.length - 1;
  const pts = c.points;
  // Lap distance of each point and the unit normal toward the right side (miter of its neighbors).
  const cum: number[] = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const L = cum[n];
  const normal = (i: number): Vec2 => {
    const a = pts[i === 0 || i === n ? n - 1 : i - 1];
    const b = pts[i === 0 || i === n ? 1 : i + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  };
  const nrm = Array.from({ length: n + 1 }, (_, i) => normal(i));
  /** Outward direction (away from the course) and face position of ring `i` on `side`. */
  const outward = (i: number, side: 1 | -1): Vec2 => ({ x: nrm[i].x * side, z: nrm[i].z * side });
  const offset = (i: number, side: 1 | -1) => (side > 0 ? c.right[i] : c.left[i]);
  const face = (i: number, side: 1 | -1, u = 0): Vec2 => {
    const o = outward(i, side);
    const k = offset(i, side) + u;
    return { x: pts[i].x + o.x * k, z: pts[i].z + o.z * k };
  };

  const mesh: THREE.Mesh[] = [];
  const fences = new ChunkedUVQuadBuilder(250);
  const gy = Array.from({ length: n + 1 }, (_, i) => [d.ground(face(i, 1)), d.ground(face(i, -1))]);
  const baseY = (i: number, side: 1 | -1) => gy[i][side > 0 ? 0 : 1];

  for (const side of [1, -1] as const) {
    // The solid: one closed run, its slab's course face at the offset (the lap's first ring repeated at the end so the ends overlap).
    const line: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i <= n + 1; i++) {
      const k = i % n;
      const f = face(k, side, SLAB_HALF);
      line.push({ x: f.x, z: f.z, y: baseY(k, side) });
    }
    railSolid(line, BARRIER_H - 0.15, d.world, d.fixed);

    // The drawn jersey: the profile swept along the lap.
    const rings = Array.from({ length: n + 1 }, (_, i) => {
      const o = outward(i, side);
      const f = face(i, side);
      return PROFILE.map(([u, h]) => new THREE.Vector3(f.x + o.x * u, baseY(i, side) + h, f.z + o.z * u));
    });
    for (let i = 0; i < n; i++) {
      const stripe = STRIPES[Math.floor((cum[i] + cum[i + 1]) / 2 / STRIPE) % 2];
      const mb = d.solid.at(pts[i].x, pts[i].z);
      for (let j = 0; j + 1 < PROFILE.length; j++) mb.quad(rings[i][j], rings[i + 1][j], rings[i + 1][j + 1], rings[i][j + 1], STRIPED.has(j) ? stripe : GREY);
    }
  }

  // Fences: panels in coarse tiles, alpha tested. `wire(a, b, y0, y1, u0, u1)`: a panel between two ground points.
  const panel = (a: Vec2, b: Vec2, ya: number, yb: number, h: number, ua: number, ub: number) => {
    fences.at(a.x, a.z).quad(
      new THREE.Vector3(a.x, ya, a.z),
      new THREE.Vector3(b.x, yb, b.z),
      new THREE.Vector3(b.x, yb + h, b.z),
      new THREE.Vector3(a.x, ya + h, a.z),
      [ua / MESH_CELL, 0, ub / MESH_CELL, h / MESH_CELL],
    );
  };

  // Mouths: a 2 m fence on the barrier across the opening.
  for (const m of c.mouths) {
    const side = m.side as 1 | -1;
    // The wall: the mouth's span, grown along the lap while the barrier steps sideways (a diagonal wall across a skewed street is longer than the opening).
    const lo = m.s - m.width / 2 - 1;
    const hi = m.s + m.width / 2 + 1;
    const lapLen = cum[n];
    // A mouth within its width of the lap seam is also covered at the other end of the lap.
    for (const shift of [0, lapLen, -lapLen]) {
      if (shift > 0 && lo >= 0) continue;
      if (shift < 0 && hi <= lapLen) continue;
      let a = cum.findIndex((v) => v >= lo + shift);
      let b = cum.findIndex((v) => v >= hi + shift);
      if (a < 0) a = 0;
      if (b < 0) b = n;
      const step = (i: number) => Math.abs(offset(Math.min(n, i + 1), side) - offset(Math.max(0, i), side)) > STEEP;
      while (a > 0 && step(a - 1)) a--;
      while (b < n && step(b)) b++;
      for (let i = a; i < b; i++) panel(face(i, side, BASE_W / 2), face(i + 1, side, BASE_W / 2), baseY(i, side) + BARRIER_H, baseY(i + 1, side) + BARRIER_H, MOUTH_FENCE_H, cum[i], cum[i + 1]);
    }
  }

  // The crowd, and the fence it stands behind.
  const { fans, fenced } = circuitFans(c, cum, {
    ground: d.ground,
    free: (p) => d.buildings.distance(p) > 0.4 && d.roads.clearance(p) > 0.4 && !d.onCourse(p),
    mouthFree: (p) => d.buildings.distance(p) > 0.4 && !d.onCourse(p),
    fenceAt: SIDE_FENCE_AT,
    firstRow: SIDE_FENCE_AT + 0.55,
  });
  for (const side of [1, -1] as const)
    for (let i = 0; i < n; i++) {
      if (!fenced[side > 0 ? 0 : 1][i] || !fenced[side > 0 ? 0 : 1][i + 1]) continue;
      panel(face(i, side, SIDE_FENCE_AT), face(i + 1, side, SIDE_FENCE_AT), baseY(i, side), baseY(i + 1, side), SIDE_FENCE_H, cum[i], cum[i + 1]);
    }
  const mat = fenceMaterial();
  for (const m of fences.build(mat)) {
    m.receiveShadow = false;
    mesh.push(m);
  }
  d.scene.add(...mesh);

  // Crowd in coarse cells, so far ones are not posed: a few instanced draws each.
  const cells = new Map<string, Fan[]>();
  for (const f of fans) {
    const k = `${Math.floor(f.x / 250)},${Math.floor(f.z / 250)}`;
    const list = cells.get(k);
    if (list) list.push(f);
    else cells.set(k, [f]);
  }
  for (const list of cells.values()) d.scene.add(crowdMesh(list));

  // SALIDA / META: one gantry over the line (start and finish are the same place), legs outside the barriers.
  const li = Math.min(n - 1, Math.round((c.line / L) * n));
  gantry(d.race, d.race.start, 'SALIDA / META', d.solid, d.paint, d.scene, d.world, d.fixed, {
    left: c.left[li] + BASE_W + 0.9,
    right: c.right[li] + BASE_W + 0.9,
    line: c.halfRoad[li],
  });
  return { fans: fans.length };
}
