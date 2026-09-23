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

  /** Like flatQuad, but each corner sits at its own height (draped over terrain). */
  drapedQuad(center: Vec2, dir: Vec2, length: number, width: number, yAt: (p: Vec2) => number, color: THREE.ColorRepresentation): void {
    const hx = (dir.x * length) / 2;
    const hz = (dir.z * length) / 2;
    const wx = (-dir.z * width) / 2;
    const wz = (dir.x * width) / 2;
    const p = (sx: number, sw: number) => {
      const q = { x: center.x + hx * sx + wx * sw, z: center.z + hz * sx + wz * sw };
      return { x: q.x, y: yAt(q), z: q.z };
    };
    this.quad(p(-1, -1), p(-1, 1), p(1, 1), p(1, -1), color);
  }

  /**
   * Triangle fan over a convex polygon, each triangle subdivided so no edge is longer than
   * `maxEdge`, every vertex at its own height (drapes large areas over uneven ground).
   */
  fan(poly: Vec2[], yAt: (p: Vec2) => number, color: THREE.ColorRepresentation, maxEdge = Infinity): void {
    this.c.set(color);
    const emit = (a: Vec2, b: Vec2, c: Vec2) => {
      // Wind so the face points up (+Y).
      const tri = [a, c, b];
      if ((tri[1].z - tri[0].z) * (tri[2].x - tri[0].x) - (tri[1].x - tri[0].x) * (tri[2].z - tri[0].z) < 0) [tri[1], tri[2]] = [tri[2], tri[1]];
      for (const q of tri) {
        this.pos.push(q.x, yAt(q), q.z);
        this.col.push(this.c.r, this.c.g, this.c.b);
      }
    };
    for (let i = 1; i < poly.length - 1; i++) {
      const [a, b, c] = [poly[0], poly[i], poly[i + 1]];
      const longest = Math.max(dist2(a, b), dist2(b, c), dist2(c, a));
      const n = Math.max(1, Math.ceil(longest / maxEdge));
      // Barycentric grid: point (i, j) = a + (b - a) i/n + (c - a) j/n.
      const at = (u: number, w: number): Vec2 => ({ x: a.x + ((b.x - a.x) * u + (c.x - a.x) * w) / n, z: a.z + ((b.z - a.z) * u + (c.z - a.z) * w) / n });
      for (let u = 0; u < n; u++)
        for (let w = 0; w < n - u; w++) {
          emit(at(u, w), at(u + 1, w), at(u, w + 1));
          if (u + w < n - 1) emit(at(u + 1, w), at(u + 1, w + 1), at(u, w + 1));
        }
    }
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
    return [...this.chunks.values()].filter((mb) => !mb.empty).map((mb) => new THREE.Mesh(mb.build(), material));
  }

  get empty(): boolean {
    return [...this.chunks.values()].every((mb) => mb.empty);
  }

  // Drawing helpers route each piece to the tile under its first point.
  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like, color: THREE.ColorRepresentation): void {
    this.at(a.x, a.z).quad(a, b, c, d, color);
  }

  drapedQuad(center: Vec2, dir: Vec2, length: number, width: number, yAt: (p: Vec2) => number, color: THREE.ColorRepresentation): void {
    this.at(center.x, center.z).drapedQuad(center, dir, length, width, yAt, color);
  }

  fan(poly: Vec2[], yAt: (p: Vec2) => number, color: THREE.ColorRepresentation, maxEdge = Infinity): void {
    this.at(poly[0].x, poly[0].z).fan(poly, yAt, color, maxEdge);
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

function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
