import * as THREE from 'three';
import type { CircuitData, Vec2 } from './cityData';
import { MeshBuilder, hash2, vertexColorMaterial } from './meshBuilder';
import { type TrackData, trackPoint } from './track';

/** One spectator: where they stand, the way they face (unit, toward the road), their look and rhythm (0..1). */
export interface Fan {
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  look: number;
}

/** The crowd stands this far past the asphalt's edge (m): two rows, behind the gantry poles, short of the trees. */
const ROWS = [2.2, 3.1];
/** One spot every this many meters along each row; some are left empty. */
const SPACING = 1.15;
const SHIRTS = ['#d23c3c', '#2d6cc4', '#e8b21e', '#3d9a5a', '#8b4fb8', '#e27a2c', '#2fa6a6', '#f2f2f2', '#c2185b', '#ffd21f'];
const SKIN = ['#c68a5b', '#a8704a', '#e0ac7e', '#8d5a3a'];
/** A share of the crowd waves a flag (Ecuador's yellow, blue and red). */
const FLAGS = 0.18;

/**
 * Where the crowd stands along the track from `s0` to `s1`: both sides, on ground about level
 * with the road (never over a drop, nor up a cut), clear of rivers, pipes and buildings
 * (`blocked`). Deterministic.
 */
export function crowdSpots(t: TrackData, s0: number, s1: number, ground: (p: Vec2) => number, blocked: (p: Vec2) => boolean = () => false): Fan[] {
  const fans: Fan[] = [];
  const q = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  for (let s = s0; s <= s1; s += SPACING)
    for (const side of [1, -1])
      ROWS.forEach((row, r) => {
        trackPoint(t, s + (r ? SPACING / 2 : 0), q);
        const off = side * (t.width / 2 + row);
        const p = { x: q.x - q.dz * off, z: q.z + q.dx * off };
        const look = hash2(p.x, p.z, 41);
        if (look < 0.22 + r * 0.25) return;
        const g = ground(p);
        if (Math.abs(g - q.y) > 1 || blocked(p)) return;
        // Facing the road, a little turned toward the start line.
        const fx = q.dz * side;
        const fz = -q.dx * side;
        fans.push({ x: p.x + (hash2(p.x, p.z, 7) - 0.5) * 0.3, y: g, z: p.z + (hash2(p.x, p.z, 9) - 0.5) * 0.3, fx, fz, look: hash2(p.x, p.z, 13) });
      });
  return fans;
}

/** Circuit crowd: dense this far (m) either side of the line, and within the radius of each hot spot (Plaza Foch, the Calama / J. L. Mera / L. Garcia chicane). */
const DENSE_LINE = 60;
const HOT_SPOTS = [
  { x: 272, z: -94, r: 55 },
  { x: 325, z: -205, r: 75 },
];
/** Share of spots filled in a dense stretch and elsewhere (second row: less). */
const DENSE_FILL = 0.8;
const SPARSE_FILL = 0.14;
const MOUTH_FILL = 0.2;
/** Meters between the rows of a circuit crowd. */
const ROW_GAP = 0.9;

/**
 * The circuit's crowd: behind the barrier and its fence, on what is left of the sidewalk or plaza
 * (`free` says a spot is not in a building, on a street or on another part of the course). `cum`
 * = lap distance of each point. Also says where the fence stands: points whose fence spot and
 * first row are free (`fenced`, right side then left, by lap point).
 */
export function circuitFans(
  c: CircuitData,
  cum: number[],
  o: { ground: (p: Vec2) => number; free: (p: Vec2) => boolean; fenceAt: number; firstRow: number; /** A spot in a side street behind a mouth fence: not in a building, not on the course. */ mouthFree: (p: Vec2) => boolean },
): { fans: Fan[]; fenced: [boolean[], boolean[]] } {
  const n = c.points.length - 1;
  const L = cum[n];
  const out = (i: number, side: number) => {
    const a = c.points[i === 0 || i === n ? n - 1 : i - 1];
    const b = c.points[i === 0 || i === n ? 1 : i + 1];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (-(b.z - a.z) / l) * side, z: ((b.x - a.x) / l) * side };
  };
  const spot = (i: number, side: number, u: number): Vec2 => {
    const d = out(i, side);
    const k = (side > 0 ? c.right[i] : c.left[i]) + u;
    return { x: c.points[i].x + d.x * k, z: c.points[i].z + d.z * k };
  };
  const fenced: [boolean[], boolean[]] = [[], []];
  for (const side of [1, -1])
    for (let i = 0; i <= n; i++) {
      const row = spot(i, side, o.firstRow);
      const base = o.ground(spot(i, side, 0));
      fenced[side > 0 ? 0 : 1].push(o.free(spot(i, side, o.fenceAt)) && o.free(row) && Math.abs(o.ground(row) - base) < 0.6);
    }
  const dense = (s: number, p: Vec2) => {
    const d = Math.abs(((s - c.line) % L + L) % L);
    return Math.min(d, L - d) <= DENSE_LINE || HOT_SPOTS.some((h) => Math.hypot(p.x - h.x, p.z - h.z) < h.r);
  };
  const fans: Fan[] = [];
  let i = 0;
  for (let s = 0; s < L; s += SPACING) {
    while (i < n - 1 && cum[i + 1] <= s) i++;
    for (const side of [1, -1])
      for (let r = 0; r < 2; r++) {
        if (!fenced[side > 0 ? 0 : 1][i]) continue;
        const p = spot(i, side, o.firstRow + r * ROW_GAP);
        if (!o.free(p)) continue;
        const look = hash2(p.x, p.z, 41);
        const fill = dense(s, p) ? DENSE_FILL : SPARSE_FILL;
        if (look > fill * (r ? 0.7 : 1)) continue;
        const d = out(i, side);
        fans.push({ x: p.x + (hash2(p.x, p.z, 7) - 0.5) * 0.3, y: o.ground(p), z: p.z + (hash2(p.x, p.z, 9) - 0.5) * 0.3, fx: -d.x, fz: -d.z, look: hash2(p.x, p.z, 13) });
      }
  }
  // Side streets: behind each mouth's fence, 0.5 to 6 m back, over the opening's width. Sparse, dense at the line, Plaza Foch and the chicane.
  for (const m of c.mouths) {
    for (let along = -m.width / 2 + 0.5; along <= m.width / 2 - 0.5; along += SPACING) {
      let j = 0;
      while (j < n - 1 && cum[j + 1] <= m.s + along) j++;
      for (let r = 0; r < 6; r++) {
        const d = out(j, m.side);
        // At least 1.2 m behind the wall's face, measured square to it (a diagonal wall is nearer along the normal).
        const slope = ((c.right[Math.min(n, j + 1)] - c.right[Math.max(0, j - 1)]) * (m.side > 0 ? 1 : 0) + (c.left[Math.min(n, j + 1)] - c.left[Math.max(0, j - 1)]) * (m.side > 0 ? 0 : 1)) / (cum[Math.min(n, j + 1)] - cum[Math.max(0, j - 1)] || 1);
        const u = 1.2 * Math.sqrt(1 + slope * slope) + r * ROW_GAP;
        const k = (m.side > 0 ? c.right[j] : c.left[j]) + u;
        const p = { x: c.points[j].x + d.x * k, z: c.points[j].z + d.z * k };
        if (!o.mouthFree(p)) continue;
        const look = hash2(p.x, p.z, 43);
        const fill = (dense(m.s + along, p) ? DENSE_FILL : MOUTH_FILL) * (1 - r * 0.1);
        if (look > fill) continue;
        fans.push({ x: p.x + (hash2(p.x, p.z, 7) - 0.5) * 0.3, y: o.ground(p), z: p.z + (hash2(p.x, p.z, 9) - 0.5) * 0.3, fx: -d.x, fz: -d.z, look: hash2(p.x, p.z, 13) });
      }
    }
  }
  return { fans, fenced };
}

const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
const HEAD = at(0, 1.5, 0);
/** The flag's pole in the raised right hand. */
const FLAG = at(0.47, 1.8, 0);

/**
 * The crowd, three instanced draws (bodies with their arms up, heads, flags), cheering: some
 * jump, the rest bounce on their feet, flags swing. Posed only while in view (`onBeforeRender`).
 */
export function crowdMesh(fans: Fan[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'crowd';
  if (!fans.length) return group;
  const mb = new MeshBuilder();
  mb.add(new THREE.BoxGeometry(0.34, 0.78, 0.22), at(0, 0.39, 0), '#2f3440');
  mb.add(new THREE.BoxGeometry(0.42, 0.58, 0.26), at(0, 1.07, 0), '#ffffff');
  // Arms up in a V.
  for (const side of [-1, 1]) {
    const arm = new THREE.BoxGeometry(0.11, 0.6, 0.11);
    arm.translate(0, 0.3, 0);
    arm.rotateZ(side * -0.45);
    mb.add(arm, at(side * 0.22, 1.3, 0), '#ffffff');
  }
  const body = new THREE.InstancedMesh(mb.build(), vertexColorMaterial(), fans.length);
  const head = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.15, 0), new THREE.MeshLambertMaterial({ flatShading: true }), fans.length);
  const fb = new MeshBuilder();
  fb.add(new THREE.CylinderGeometry(0.015, 0.015, 1.1, 4), at(0, 0.55, 0), '#d8d8d8');
  // Yellow over half the flag, then blue and red.
  for (const [h, y, color] of [[0.26, 0.97, '#f5d10f'], [0.13, 0.775, '#1e4fa8'], [0.13, 0.645, '#d12a2a']] as const) fb.add(new THREE.PlaneGeometry(0.75, h), at(0.38, y, 0), color);
  const waving = fans.filter((f) => f.look < FLAGS);
  const flags = new THREE.InstancedMesh(fb.build(), vertexColorMaterial({ side: THREE.DoubleSide }), Math.max(1, waving.length));
  flags.count = waving.length;
  const c = new THREE.Color();
  fans.forEach((f, i) => {
    body.setColorAt(i, c.set(SHIRTS[Math.floor(f.look * SHIRTS.length)]));
    head.setColorAt(i, c.set(SKIN[Math.floor(((f.look * 7.3) % 1) * SKIN.length)]));
  });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sway = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3(0, 0, 1);
  const flagSwing = new THREE.Matrix4();
  const fm = new THREE.Matrix4();
  let posed = -1;
  const pose = (time: number) => {
    let k = 0;
    fans.forEach((f, i) => {
      const beat = time * (5 + f.look * 3) + f.look * 40;
      // A third jump, the rest bounce and sway.
      const jumper = f.look > 0.66;
      const lift = jumper ? Math.max(0, Math.sin(beat)) * 0.32 : Math.abs(Math.sin(beat)) * 0.05;
      q.setFromAxisAngle(up, Math.atan2(f.fx, f.fz)).multiply(sway.setFromAxisAngle(fwd, jumper ? 0 : Math.sin(beat * 0.5) * 0.08));
      m.compose(p.set(f.x, f.y + lift, f.z), q, one);
      body.setMatrixAt(i, m);
      if (f.look < FLAGS) {
        flagSwing.makeRotationZ(Math.sin(beat * 0.7) * 0.5);
        flags.setMatrixAt(k++, fm.copy(m).multiply(FLAG).multiply(flagSwing));
      }
      head.setMatrixAt(i, m.multiply(HEAD));
    });
    for (const mesh of [body, head, flags]) mesh.instanceMatrix.needsUpdate = true;
  };
  pose(0);
  for (const mesh of [body, head, flags]) {
    mesh.computeBoundingSphere();
    mesh.boundingSphere!.radius += 3;
    mesh.castShadow = true;
    group.add(mesh);
  }
  // The pose shows a frame late (the matrices are uploaded before this runs), which no one sees.
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  body.onBeforeRender = () => {
    // Once a frame (the shadow pass draws it too).
    const now = (performance.now() - t0) / 1000;
    if (now - posed < 0.008) return;
    posed = now;
    pose(now);
  };
  return group;
}
