import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { RAPIER } from '../physics/world';
import type { Building, CityData, Feature, Road, Stop, Vec2 } from './cityData';
import { SIDEWALK_HEIGHT, forward, right } from './cityData';
import { segmentIntersection } from './geom';
import { ChunkedMeshBuilder, MeshBuilder, extrude, vertexColorMaterial, IDENTITY } from './meshBuilder';
import { PropSystem } from './props';
import { buildMountains } from './mountains';

const ROAD_Y = 0.02;
const MARK_Y = 0.05;
const ASPHALT = '#4d5057';
const MARK_WHITE = '#eceae0';
const MARK_YELLOW = '#e8c230';
const SIDEWALK_TOP = '#c9c5bb';
const CURB = '#a19d94';
const PARK_TOP = '#79a651';
const FLOOR_HEIGHT = 3.2;

export interface BuiltCity {
  props: PropSystem;
}

/** Turns CityData into merged low-poly meshes (a handful of draw calls) and static colliders. */
export function buildCity(city: CityData, world: RAPIER.World, scene: THREE.Scene): BuiltCity {
  const ground = new MeshBuilder(); // receives shadows only
  const solid = new ChunkedMeshBuilder(); // casts and receives

  const grass = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: '#86a85f' }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.03;
  grass.receiveShadow = true;
  scene.add(grass);

  for (const r of city.roads) addRoad(ground, r);
  addMarkings(ground, city.roads);

  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const collide = (desc: RAPIER.ColliderDesc | null) => desc && world.createCollider(desc.setFriction(0.8), fixed);

  for (const b of city.blocks) {
    const c = centroid(b.footprint);
    solid.at(c.x, c.z).add(extrude(b.footprint, 0, SIDEWALK_HEIGHT), IDENTITY, b.kind === 'park' ? PARK_TOP : SIDEWALK_TOP, CURB);
    collide(RAPIER.ColliderDesc.convexHull(prismPoints(b.footprint, 0, SIDEWALK_HEIGHT)));
  }
  for (const b of city.buildings) {
    const c = centroid(b.footprint);
    addBuilding(solid.at(c.x, c.z), b);
    collide(RAPIER.ColliderDesc.convexHull(prismPoints(b.footprint, 0, b.height)));
  }
  for (const f of city.features) {
    const pts = featurePoints(f);
    solid.at(f.pos.x, f.pos.z).add(new ConvexGeometry(pts), IDENTITY, f.kind === 'ramp' ? '#e39a2d' : MARK_YELLOW, f.kind === 'ramp' ? '#b8741c' : '#3a3a3a');
    collide(RAPIER.ColliderDesc.convexHull(new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z]))));
  }
  for (const s of city.stops) addShelter(solid.at(s.pos.x, s.pos.z), s, world, fixed);
  for (const t of city.trees) addTree(solid.at(t.x, t.z), t, world, fixed);

  const groundMesh = new THREE.Mesh(ground.build(), vertexColorMaterial({ side: THREE.DoubleSide }));
  groundMesh.receiveShadow = true;
  const solidMeshes = solid.build(vertexColorMaterial({ side: THREE.DoubleSide }));
  for (const m of solidMeshes) m.castShadow = m.receiveShadow = true;
  scene.add(groundMesh, ...solidMeshes, buildMountains());

  return { props: new PropSystem(world, scene, city) };
}

function addRoad(mb: MeshBuilder, r: Road): void {
  for (let i = 0; i < r.points.length - 1; i++) {
    const a = r.points[i];
    const b = r.points[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    // Extend by half the width so corners of the grid are fully paved.
    mb.flatQuad({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, dir, len + r.width, r.width, ROAD_Y, ASPHALT);
  }
}

/** Center/lane lines broken at intersections, plus zebra crossings on each approach. */
function addMarkings(mb: MeshBuilder, roads: Road[]): void {
  for (const r of roads) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i];
      const b = r.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const across = { x: -dir.z, z: dir.x };
      const at = (t: number, off = 0): Vec2 => ({ x: a.x + dir.x * t + across.x * off, z: a.z + dir.z * t + across.z * off });

      // Intervals (in distance along the segment) covered by crossing roads.
      const gaps: [number, number][] = [];
      for (const o of roads) {
        if (o === r) continue;
        for (let j = 0; j < o.points.length - 1; j++) {
          const hit = segmentIntersection(a, b, o.points[j], o.points[j + 1]);
          if (!hit) continue;
          const t = Math.hypot(hit.x - a.x, hit.z - a.z);
          gaps.push([t - o.width / 2 - 5, t + o.width / 2 + 5]);
          // Zebra crossings just outside the intersection, on both approaches.
          for (const side of [-1, 1]) {
            const ct = t + side * (o.width / 2 + 2.5);
            if (ct < 0 || ct > len) continue;
            for (let s = -r.width / 2 + 1; s <= r.width / 2 - 1; s += 1.2) mb.flatQuad(at(ct, s), dir, 3, 0.6, MARK_Y, MARK_WHITE);
          }
        }
      }
      const clear = (t: number) => !gaps.some(([g0, g1]) => t > g0 && t < g1);
      const lines: { off: number; color: string; dash: boolean }[] =
        r.kind === 'avenue'
          ? [
              { off: -0.2, color: MARK_YELLOW, dash: false },
              { off: 0.2, color: MARK_YELLOW, dash: false },
              { off: -r.width / 4, color: MARK_WHITE, dash: true },
              { off: r.width / 4, color: MARK_WHITE, dash: true },
            ]
          : [{ off: 0, color: MARK_WHITE, dash: true }];
      for (const l of lines) {
        const step = l.dash ? 6 : 1;
        const piece = l.dash ? 3 : 1.02;
        for (let t = 0; t < len; t += step) {
          if (clear(t)) mb.flatQuad(at(t + piece / 2, l.off), dir, piece, 0.18, MARK_Y, l.color);
        }
      }
    }
  }
}

function addBuilding(mb: MeshBuilder, b: Building): void {
  mb.add(extrude(b.footprint, 0, b.height), IDENTITY, b.roof, b.color);
  const floors = Math.round(b.height / FLOOR_HEIGHT);
  const tall = floors > 3;
  const glass = tall ? '#7d97ad' : '#4f5a63';
  const { x: cx, z: cz } = centroid(b.footprint);
  for (let i = 0; i < b.footprint.length; i++) {
    const p0 = b.footprint[i];
    const p1 = b.footprint[(i + 1) % b.footprint.length];
    const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (len < 3) continue;
    const d = { x: (p1.x - p0.x) / len, z: (p1.z - p0.z) / len };
    let n = { x: -d.z, z: d.x };
    const mx = (p0.x + p1.x) / 2;
    const mz = (p0.z + p1.z) / 2;
    if (n.x * (mx - cx) + n.z * (mz - cz) < 0) n = { x: -n.x, z: -n.z };
    const pt = (t: number, y: number) => ({ x: p0.x + d.x * t + n.x * 0.04, y, z: p0.z + d.z * t + n.z * 0.04 });
    for (let f = 0; f < floors; f++) {
      const y0 = f * FLOOR_HEIGHT + 1;
      const y1 = y0 + (tall ? 1.1 : 1.3);
      if (tall) {
        // Continuous glass band per floor.
        mb.quad(pt(0.8, y0), pt(len - 0.8, y0), pt(len - 0.8, y1), pt(0.8, y1), glass);
      } else {
        // Individual colonial-style windows.
        const n = Math.max(1, Math.floor((len - 1) / 3.2));
        const gap = len / n;
        for (let w = 0; w < n; w++) {
          const t = gap * (w + 0.5);
          mb.quad(pt(t - 0.6, y0), pt(t + 0.6, y0), pt(t + 0.6, y1), pt(t - 0.6, y1), glass);
        }
      }
    }
  }
}

/** Bus shelter ("parada"): back panel, roof, bench and a blue sign, behind the waiting spot. */
function addShelter(mb: MeshBuilder, s: Stop, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const r = right(s.heading);
  const center = { x: s.pos.x + r.x * 0.9, z: s.pos.z + r.z * 0.9 };
  const base = SIDEWALK_HEIGHT;
  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(center.x, base, center.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.heading),
    new THREE.Vector3(1, 1, 1),
  );
  const part = (w: number, h: number, d: number, x: number, y: number, z: number, color: string, side = color) => {
    const m = new THREE.Matrix4().makeTranslation(x, y, z).premultiply(frame);
    mb.add(new THREE.BoxGeometry(w, h, d), m, color, side);
  };
  part(4, 2.3, 0.08, 0, 1.15, 0.8, '#a9c7d6'); // back glass
  part(4.4, 0.12, 1.9, 0, 2.4, 0, '#2c5aa0'); // roof
  part(3.2, 0.08, 0.45, 0, 0.5, 0.45, '#8a6a45'); // bench
  for (const x of [-1.95, 1.95]) part(0.1, 2.35, 0.1, x, 1.18, 0.8, '#555');
  part(0.08, 3.2, 0.08, 2.5, 1.6, -0.4, '#666'); // sign pole
  part(0.7, 0.7, 0.06, 2.5, 3.0, -0.4, '#1f5fbf', '#1f5fbf'); // sign
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.heading);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(2.1, 1.25, 0.12)
      .setTranslation(center.x + r.x * 0.8, base + 1.25, center.z + r.z * 0.8)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    fixed,
  );
}

function addTree(mb: MeshBuilder, p: Vec2, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const base = SIDEWALK_HEIGHT;
  const s = 0.8 + (Math.abs(Math.sin(p.x * 12.9898 + p.z * 78.233)) % 0.6);
  mb.add(new THREE.CylinderGeometry(0.2, 0.3, 2.4 * s, 6), new THREE.Matrix4().makeTranslation(p.x, base + 1.2 * s, p.z), '#6b4a2f');
  const crown = new THREE.IcosahedronGeometry(1.8 * s, 0);
  mb.add(crown, new THREE.Matrix4().makeTranslation(p.x, base + 3.4 * s, p.z), '#4f8a3a', '#3f7430');
  world.createCollider(RAPIER.ColliderDesc.cylinder(1.2 * s, 0.3).setTranslation(p.x, base + 1.2 * s, p.z), fixed);
}

function prismPoints(footprint: Vec2[], y0: number, y1: number): Float32Array {
  return new Float32Array(footprint.flatMap((p) => [p.x, y0, p.z, p.x, y1, p.z]));
}

/** Convex hull points for a ramp (wedge) or speed hump (arched profile), in world space. */
function featurePoints(f: Feature): THREE.Vector3[] {
  const fw = forward(f.heading);
  const rt = right(f.heading);
  const w = (along: number, y: number, across: number) =>
    new THREE.Vector3(f.pos.x + fw.x * along + rt.x * across, y, f.pos.z + fw.z * along + rt.z * across);
  const pts: THREE.Vector3[] = [];
  const half = f.length / 2;
  for (const side of [-f.width / 2, f.width / 2]) {
    if (f.kind === 'ramp') {
      pts.push(w(-half, 0, side), w(half, 0, side), w(half, f.height, side));
    } else {
      for (let k = 0; k <= 8; k++) {
        const t = -half + (k / 8) * f.length;
        pts.push(w(t, (f.height * (1 + Math.cos((Math.PI * t) / half))) / 2, side));
      }
    }
  }
  return pts;
}

function centroid(poly: Vec2[]): Vec2 {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, z: poly.reduce((s, p) => s + p.z, 0) / poly.length };
}
