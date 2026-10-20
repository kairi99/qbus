import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Painted = THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; map?: THREE.Texture | null; flatShading?: boolean };

/**
 * Materials that shade the same draw as one, whatever their color (it goes into the vertices):
 * their kind, shading, transparency, glow. Null for a textured one (a sign): it keeps its mesh.
 */
function lookOf(m: Painted): string | null {
  if (m.map || !m.color) return null;
  return [m.type, m.emissive?.getHexString() ?? '', m.flatShading ? 1 : 0, m.transparent ? m.opacity : 1, m.side, m.depthWrite ? 1 : 0, m.blending].join('|');
}

/**
 * Merges the fixed parts of a vehicle model under `group` into one mesh per look (shading and
 * shadow flags), each part's color baked into its vertices: a bus is dozens of boxes, each a
 * draw call (twice, with the shadow pass), so merged it draws the same in two or three. Children in `keep` (moving parts: wheels, flames, the
 * steering wheel, a rear section posed on its own) and their subtrees are left as they are, as
 * is anything textured. Positions are baked relative to `group`, which must be at its rest
 * pose (identity transforms are not required, only that nothing moves relative to it later).
 */
export function mergeParts(group: THREE.Object3D, keep: ReadonlySet<THREE.Object3D>): void {
  group.updateMatrixWorld(true);
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<string, { material: Painted; cast: boolean; receive: boolean; geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  const visit = (o: THREE.Object3D) => {
    for (const c of o.children) {
      if (keep.has(c) || !c.visible) continue;
      const mesh = c as THREE.Mesh;
      if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh && !Array.isArray(mesh.material)) {
        const mat = mesh.material as Painted;
        const look = lookOf(mat);
        if (look !== null) {
          const key = `${look}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}`;
          let b = buckets.get(key);
          if (!b) buckets.set(key, (b = { material: mat, cast: mesh.castShadow, receive: mesh.receiveShadow, geos: [], meshes: [] }));
          // Same attributes for all (position, normal and color, unindexed) so they merge. The
          // material's color (in working space, as the shader gets it) times any vertex colors.
          let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
          const own = (mat as THREE.MeshBasicMaterial).vertexColors ? g.attributes.color : undefined;
          for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
          if (!g.attributes.normal) g.computeVertexNormals();
          const n = g.attributes.position.count;
          const col = new Float32Array(n * 3);
          const k = mat.color!;
          for (let i = 0; i < n; i++) {
            col[i * 3] = k.r * (own ? own.getX(i) : 1);
            col[i * 3 + 1] = k.g * (own ? own.getY(i) : 1);
            col[i * 3 + 2] = k.b * (own ? own.getZ(i) : 1);
          }
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
          g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toGroup, mesh.matrixWorld));
          // A mirrored part (negative scale) flips its faces: turn them back.
          if (mesh.matrixWorld.determinant() < 0) g = flipWinding(g);
          b.geos.push(g);
          b.meshes.push(mesh);
        }
      }
      visit(c);
    }
  };
  visit(group);
  for (const b of buckets.values()) {
    const merged = b.meshes.length > 1 ? mergeGeometries(b.geos) : null;
    if (!merged) continue;
    for (const m of b.meshes) {
      m.parent!.remove(m);
      // A merged part's children (none in practice) stay with the group.
      for (const child of [...m.children]) group.attach(child);
    }
    const material = b.material.clone() as Painted;
    material.color!.set(0xffffff);
    (material as THREE.MeshBasicMaterial).vertexColors = true;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    group.add(mesh);
  }
  // Groups emptied by the merge go too.
  const prune = (o: THREE.Object3D) => {
    for (const c of [...o.children]) {
      if (keep.has(c)) continue;
      prune(c);
      if (!(c as THREE.Mesh).isMesh && c.type === 'Group' && c.children.length === 0) o.remove(c);
    }
  };
  prune(group);
}

function flipWinding(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of ['position', 'normal', 'color']) {
    const a = g.attributes[name];
    if (!a) continue;
    for (let i = 0; i < a.count; i += 3) {
      const x = a.getX(i + 1), y = a.getY(i + 1), z = a.getZ(i + 1);
      a.setXYZ(i + 1, a.getX(i + 2), a.getY(i + 2), a.getZ(i + 2));
      a.setXYZ(i + 2, x, y, z);
    }
  }
  return g;
}
