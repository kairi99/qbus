/** Ray casts against the drawn scene (not physics), for comparing what's drawn with what's solid. */
import * as THREE from 'three';

/** Triangle soup of the meshes that stand for solid things, around one area, in a 2D grid. */
export class DrawnSoup {
  private tris: Float32Array;
  private grid = new Map<string, number[]>();
  readonly count: number;

  constructor(
    scene: THREE.Scene,
    box: { x0: number; x1: number; z0: number; z1: number },
    include: (m: THREE.Mesh) => boolean,
    private cell = 4,
  ) {
    const out: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || !include(m)) return;
      const g = m.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      if (bb.max.x < box.x0 || bb.min.x > box.x1 || bb.max.z < box.z0 || bb.min.z > box.z1) return;
      const pos = g.getAttribute('position');
      const idx = g.index;
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const [i0, i1, i2] = idx ? [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] : [i, i + 1, i + 2];
        a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
        if (Math.max(a.x, b.x, c.x) < box.x0 || Math.min(a.x, b.x, c.x) > box.x1 || Math.max(a.z, b.z, c.z) < box.z0 || Math.min(a.z, b.z, c.z) > box.z1) continue;
        out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    });
    this.tris = new Float32Array(out);
    this.count = out.length / 9;
    for (let t = 0; t < this.count; t++) {
      const o = t * 9;
      const xs = [this.tris[o], this.tris[o + 3], this.tris[o + 6]];
      const zs = [this.tris[o + 2], this.tris[o + 5], this.tris[o + 8]];
      for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.floor(Math.max(...xs) / cell); gx++)
        for (let gz = Math.floor(Math.min(...zs) / cell); gz <= Math.floor(Math.max(...zs) / cell); gz++) {
          const k = `${gx},${gz}`;
          const list = this.grid.get(k);
          if (list) list.push(t);
          else this.grid.set(k, [t]);
        }
    }
  }

  /** Distance to the first drawn triangle along a ray, or null within `reach`. */
  ray(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, reach: number): number | null {
    const x1 = o.x + d.x * reach;
    const z1 = o.z + d.z * reach;
    const seen = new Set<number>();
    let best: number | null = null;
    for (let gx = Math.floor(Math.min(o.x, x1) / this.cell); gx <= Math.floor(Math.max(o.x, x1) / this.cell); gx++)
      for (let gz = Math.floor(Math.min(o.z, z1) / this.cell); gz <= Math.floor(Math.max(o.z, z1) / this.cell); gz++)
        for (const t of this.grid.get(`${gx},${gz}`) ?? []) {
          if (seen.has(t)) continue;
          seen.add(t);
          const hit = this.hit(t, o, d);
          if (hit !== null && hit <= reach && (best === null || hit < best)) best = hit;
        }
    return best;
  }

  /** Möller–Trumbore, both faces. */
  private hit(t: number, o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): number | null {
    const p = this.tris;
    const i = t * 9;
    const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
    const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-9) return null;
    const inv = 1 / det;
    const tx = o.x - p[i], ty = o.y - p[i + 1], tz = o.z - p[i + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return null;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
    if (v < 0 || u + v > 1) return null;
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return dist > 1e-4 ? dist : null;
  }
}

/**
 * Meshes that stand for solid things: everything drawn in the main scene except the ground
 * overlays (asphalt, sidewalks, curbs, paint: thin layers over a collider, drawn with a polygon
 * offset other than the terrain's) and LOD-wrapped decoration (facade detail, trees, lamps; their
 * solid trunks and poles are skipped on the physics side instead, see `SMALL_SOLIDS`).
 */
export function solidLooking(m: THREE.Mesh): boolean {
  if (m.parent && (m.parent as THREE.LOD).isLOD) return false;
  const mat = m.material as THREE.Material;
  if (Array.isArray(mat) || mat.transparent) return false;
  if (mat.polygonOffset) return mat.polygonOffsetFactor === 6 || m.name === 'trenchPatch'; // terrain
  return true;
}

/**
 * Collider shapes that are small solid props drawn by instanced or LOD meshes (trunks, poles:
 * cylinders; bollards: cones) or invisible on purpose (the map edge's tall wall and prop boxes:
 * cuboids). The parity check doesn't hold them against the drawn scene.
 */
export const SMALL_SOLIDS = new Set([1, 10, 11]);
