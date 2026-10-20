import * as THREE from 'three';
import type { Vec2 } from './cityData';
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
