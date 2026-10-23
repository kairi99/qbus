import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mergeParts } from '../src/vehicle/mergeParts';
import { BusModel } from '../src/vehicle/busModel';
import { VEHICLES } from '../src/vehicle/buses';

const flat = (color: string) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/** Every drawn triangle of a group, as world-space corners and the color it's drawn in (sorted). */
function triangles(root: THREE.Object3D): string[] {
  root.updateMatrixWorld(true);
  const out: string[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshLambertMaterial;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
    const pos = g.attributes.position;
    const col = mat.vertexColors ? g.attributes.color : null;
    for (let i = 0; i < pos.count; i += 3) {
      const corners: string[] = [];
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, i + k).applyMatrix4(m.matrixWorld);
        corners.push(v.toArray().map((x) => x.toFixed(3)).join(','));
      }
      // three.js draws a mirrored mesh's faces flipped: what counts is the side it's seen from.
      if (m.matrixWorld.determinant() < 0) corners.reverse();
      // Rotate so the winding (which way the face points) is kept but the start corner doesn't matter.
      const j = corners.indexOf([...corners].sort()[0]);
      const tri = [...corners.slice(j), ...corners.slice(0, j)].join(' ');
      const c = col ? new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)).multiply(mat.color) : mat.color;
      out.push(`${tri} ${c.getHexString()} ${m.castShadow}`);
    }
  });
  return out.sort();
}

describe('merging a model’s fixed parts', () => {
  it('draws exactly the same triangles in the same colors, mirrored parts included, in fewer meshes', () => {
    const group = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), flat('#ff0000'));
    a.position.set(1, 0, 0);
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 8), flat('#00ff00'));
    b.rotation.set(0.3, 0.2, 0.1);
    const c = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), flat('#0000ff'));
    c.scale.set(-1, 1, 1);
    c.position.z = 2;
    const sub = new THREE.Group();
    sub.position.set(0, 3, 0);
    sub.add(c);
    const moving = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), flat('#ffffff'));
    group.add(a, b, sub, moving);
    const before = triangles(group);
    mergeParts(group, new Set([moving]));
    expect(triangles(group)).toEqual(before);
    let meshes = 0;
    group.traverse((o) => (o as THREE.Mesh).isMesh && meshes++);
    expect(meshes).toBe(2);
    // The moving part is still its own object.
    expect(moving.parent).toBe(group);
  });

  it('every vehicle draws in a handful of meshes', () => {
    const g = globalThis as any;
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
    g.document ??= { createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }) };
    for (const v of VEHICLES) {
      const m = new BusModel(v.preset);
      let n = 0;
      (m as any).exterior.traverse((o: THREE.Object3D) => {
        let p: THREE.Object3D | null = o;
        while (p) {
          if (!p.visible) return;
          p = p.parent;
        }
        if ((o as THREE.Mesh).isMesh) n++;
      });
      expect(n, v.preset.id).toBeLessThanOrEqual(v.preset.articulated?.sections ? 25 : 12);
    }
  });
});
