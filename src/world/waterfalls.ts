import * as THREE from 'three';
import type { Vec2 } from './cityData';
import { type TrackData, type TrackScenery, locateOnTrack } from './track';
import type { Puff } from './mist';

type Fall = NonNullable<TrackScenery['waterfalls']>[number];

/** The ribbon rides this far over the ground (m), and a texture row is this long (m). */
const LIFT = 0.7;
const ROW = 7;
/** Scroll speed of the streaks (texture rows per second). */
const SPEED = 1.6;

/**
 * The real waterfalls as one mesh: a ribbon of falling white water down each one's course over
 * the terrain, its streaks scrolling downhill (one shared texture, moved when the mesh is drawn).
 * Where the course meets the road not on a bridge the ribbon stops short of the asphalt (a culvert).
 */
export function waterfallMesh(race: TrackData, falls: Fall[], ground: (p: Vec2) => number): THREE.Mesh | null {
  if (!falls.length || typeof document === 'undefined') return null;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const hw = race.width / 2;
  const onBridge = (s: number) => (race.bridges ?? []).some((b) => s >= b.s0 - 3 && s <= b.s1 + 3);
  for (const f of falls) {
    // Resampled every 2.5 m along the course.
    const pts: Vec2[] = [];
    for (let i = 0; i + 1 < f.points.length; i++) {
      const [a, b] = [f.points[i], f.points[i + 1]];
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2.5));
      for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    pts.push(f.points[f.points.length - 1]);
    let along = 0;
    const base = pos.length / 3;
    const ok: boolean[] = [];
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const n = { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
      if (i) along += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      // Wider as it falls.
      const half = (f.width / 2) * (0.7 + 0.5 * (i / pts.length));
      for (const side of [-1, 1]) {
        const q = { x: p.x + n.x * half * side, z: p.z + n.z * half * side };
        pos.push(q.x, ground(q) + LIFT, q.z);
        uv.push(side < 0 ? 0 : 1, along / ROW);
      }
      const here = locateOnTrack(race, p);
      ok.push(!(Math.abs(here.off) < hw + 1.5 && !onBridge(here.s) && Math.abs(ground(p) - here.y) < 2));
    });
    for (let i = 1; i < pts.length; i++) {
      if (!ok[i] || !ok[i - 1]) continue;
      const [a, b] = [base + (i - 1) * 2, base + i * 2];
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const tex = streaks();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  mesh.name = 'waterfalls';
  // The water runs down: the streaks move toward increasing rows.
  mesh.onBeforeRender = () => {
    tex.offset.y = -((performance.now() / 1000) * SPEED) % 1;
  };
  return mesh;
}

/** White streaks on pale blue, soft at both edges (faded to transparent), one tile tall. */
function streaks(): THREE.CanvasTexture {
  const W = 64;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b9d8e6';
  g.fillRect(0, 0, W, H);
  // A deterministic scatter of long streaks (wrapping top to bottom so the tile repeats).
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W;
    const w = 1 + rnd() * 3;
    const y = rnd() * H;
    const len = 18 + rnd() * 60;
    g.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.55})`;
    for (const dy of [0, -H]) g.fillRect(x, y + dy, w, len);
  }
  for (let i = 0; i < 25; i++) {
    g.fillStyle = `rgba(90,140,170,${0.15 + rnd() * 0.25})`;
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 10 + rnd() * 30);
  }
  // Edges fade out smoothly: alpha by distance from the middle only (no per-row noise: that sawed the edges).
  const data = g.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = Math.abs(x / (W - 1) - 0.5) * 2;
      const t = Math.max(0, Math.min(1, (0.97 - u) / 0.55));
      data.data[(y * W + x) * 4 + 3] = Math.round(255 * t * t * (3 - 2 * t) * 0.92);
    }
  g.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Spray hanging at each fall's foot and along its course: puffs for the mist system. */
export function waterfallSpray(falls: Fall[], ground: (p: Vec2) => number): Puff[] {
  const out: Puff[] = [];
  for (const f of falls) {
    const n = f.points.length;
    const foot = f.points[n - 1];
    const gy = ground(foot);
    for (let k = 0; k < 4; k++) out.push({ x: foot.x + (k - 1.5) * 4, y: gy + 3 + k, z: foot.z + ((k * 7) % 5) - 2, size: 16 + k * 3, alpha: 0.5 });
    // A thin veil beside the water up the course.
    for (let i = 2; i < n; i += 5) out.push({ x: f.points[i].x, y: ground(f.points[i]) + 4, z: f.points[i].z, size: 10, alpha: 0.18 });
  }
  return out;
}
