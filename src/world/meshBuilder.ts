import * as THREE from 'three';
import type { Vec2 } from './cityData';

/**
 * Accumulates flat-colored triangles into one BufferGeometry so a whole layer of the city
 * (roads, buildings, ...) is a single draw call.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private c = new THREE.Color();
  private v = new THREE.Vector3();

  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like, color: THREE.ColorRepresentation): void {
    this.c.set(color);
    for (const p of [a, b, c, a, c, d]) {
      this.pos.push(p.x, p.y, p.z);
      this.col.push(this.c.r, this.c.g, this.c.b);
    }
  }

  /** Horizontal quad centered at `center`, `length` along `dir`, `width` across it. */
  flatQuad(center: Vec2, dir: Vec2, length: number, width: number, y: number, color: THREE.ColorRepresentation): void {
    const hx = (dir.x * length) / 2;
    const hz = (dir.z * length) / 2;
    const wx = (-dir.z * width) / 2;
    const wz = (dir.x * width) / 2;
    const p = (sx: number, sw: number) => ({ x: center.x + hx * sx + wx * sw, y, z: center.z + hz * sx + wz * sw });
    // Wound so the face points up (+Y).
    this.quad(p(-1, -1), p(-1, 1), p(1, 1), p(1, -1), color);
  }

  /**
   * Appends an existing geometry, transformed by `matrix`. Faces pointing up get `top`,
   * the rest `side` (or everything gets `top` when `side` is omitted).
   */
  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, top: THREE.ColorRepresentation, side = top): void {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
    const p = g.getAttribute('position');
    const topC = new THREE.Color(top);
    const sideC = new THREE.Color(side);
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(p, i);
      e1.fromBufferAttribute(p, i + 1).sub(a);
      e2.fromBufferAttribute(p, i + 2).sub(a);
      const up = this.v.crossVectors(e1, e2).normalize().y > 0.5;
      const color = up ? topC : sideC;
      for (let k = 0; k < 3; k++) {
        this.pos.push(p.getX(i + k), p.getY(i + k), p.getZ(i + k));
        this.col.push(color.r, color.g, color.b);
      }
    }
    g.dispose();
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Spatially bucketed MeshBuilders. One mesh per tile lets three.js frustum-cull the city,
 * which matters most for the shadow pass (it only covers the area around the bus).
 */
export class ChunkedMeshBuilder {
  private chunks = new Map<string, MeshBuilder>();

  constructor(private size = 110) {}

  at(x: number, z: number): MeshBuilder {
    const key = `${Math.floor(x / this.size)},${Math.floor(z / this.size)}`;
    let mb = this.chunks.get(key);
    if (!mb) this.chunks.set(key, (mb = new MeshBuilder()));
    return mb;
  }

  build(material: THREE.Material): THREE.Mesh[] {
    return [...this.chunks.values()].map((mb) => new THREE.Mesh(mb.build(), material));
  }
}

/** Prism from a ground footprint, from `y0` to `y1`, in world coordinates. */
export function extrude(footprint: Vec2[], y0: number, y1: number): THREE.BufferGeometry {
  // Shape lives in XY; with rotateX(-90°) shape-y maps to world -z, so feed it -z.
  const shape = new THREE.Shape(footprint.map((p) => new THREE.Vector2(p.x, -p.z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0, 0);
  return geo;
}

export const vertexColorMaterial = (opts: THREE.MeshLambertMaterialParameters = {}) =>
  new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, ...opts });

export const IDENTITY = new THREE.Matrix4();
