import * as THREE from 'three';
import type { Vec2 } from './cityData';

/** Parsed colors by CSS string: the city build sets the same few colors millions of times. */
const parsed = new Map<string, THREE.Color>();
const scratch = new THREE.Color();
/** The linear color for `c` (shared: read it, never modify it). */
function rgb(c: THREE.ColorRepresentation): THREE.Color {
  if (typeof c !== 'string') return scratch.set(c);
  let out = parsed.get(c);
  if (!out) parsed.set(c, (out = new THREE.Color(c)));
  return out;
}

/**
 * Accumulates flat-colored triangles into one BufferGeometry so a whole layer of the city
 * (roads, buildings, ...) is a single draw call.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private v = new THREE.Vector3();

  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like, color: THREE.ColorRepresentation): void {
    const { r, g, b: bl } = rgb(color);
    const pos = this.pos;
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    this.col.push(r, g, bl, r, g, bl, r, g, bl, r, g, bl, r, g, bl, r, g, bl);
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
    const col = rgb(color);
    const emit = (a: Vec2, b: Vec2, c: Vec2) => {
      // Wind so the face points up (+Y).
      const tri = [a, c, b];
      if ((tri[1].z - tri[0].z) * (tri[2].x - tri[0].x) - (tri[1].x - tri[0].x) * (tri[2].z - tri[0].z) < 0) [tri[1], tri[2]] = [tri[2], tri[1]];
      for (const q of tri) {
        this.pos.push(q.x, yAt(q), q.z);
        this.col.push(col.r, col.g, col.b);
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
    const topC = rgb(top).clone();
    const sideC = rgb(side).clone();
    const a = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i);
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

  /** Vertex count so far. */
  get count(): number {
    return this.pos.length / 3;
  }

  /** Copies the triangles into `pos`/`col` from vertex `at` on. */
  copyTo(pos: Float32Array, col: Float32Array, at: number): void {
    pos.set(this.pos, at * 3);
    col.set(this.col, at * 3);
  }
}

/**
 * A directional light's shadow camera is orthographic: its frustum's side planes come in
 * exactly opposite pairs, which a perspective view's never do.
 */
function isShadowFrustum(f: THREE.Frustum): boolean {
  return f.planes[0].normal.dot(f.planes[1].normal) < -0.999999;
}

/** Bounding sphere of vertices [start, start + count) of a position attribute. */
function rangeSphere(pos: Float32Array, start: number, count: number): THREE.Sphere {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = start; i < start + count; i++) box.expandByPoint(v.fromArray(pos, i * 3));
  const sphere = new THREE.Sphere();
  box.getCenter(sphere.center);
  let r2 = 0;
  for (let i = start; i < start + count; i++) r2 = Math.max(r2, sphere.center.distanceToSquared(v.fromArray(pos, i * 3)));
  sphere.radius = Math.sqrt(r2);
  return sphere;
}

/**
 * Spatially bucketed MeshBuilders. One mesh per tile lets three.js frustum-cull the city,
 * which matters most for the shadow pass (it only covers the area around the bus).
 */
export class ChunkedMeshBuilder {
  private chunks = new Map<string, { mb: MeshBuilder; cx: number; cz: number }>();

  constructor(private size = 110) {}

  at(x: number, z: number): MeshBuilder {
    const cx = Math.floor(x / this.size);
    const cz = Math.floor(z / this.size);
    const key = `${cx},${cz}`;
    let chunk = this.chunks.get(key);
    if (!chunk) this.chunks.set(key, (chunk = { mb: new MeshBuilder(), cx, cz }));
    return chunk.mb;
  }

  /**
   * The meshes, one per tile. With `merge` > 1, each merge × merge block of tiles is drawn as
   * one mesh (far fewer draw calls for the main view; nothing changes on screen). With
   * `shadows`, the meshes receive shadows, and cast them through one proxy per tile that shares
   * the merged buffers and only the sun's shadow pass draws: the shadow map, which covers just
   * the area around the bus, still skips the tiles outside it.
   */
  build(material: THREE.Material, opts: { merge?: number; shadows?: boolean } = {}): THREE.Mesh[] {
    const merge = opts.merge ?? 1;
    const blocks = new Map<string, MeshBuilder[]>();
    for (const { mb, cx, cz } of this.chunks.values()) {
      if (mb.empty) continue;
      const key = `${Math.floor(cx / merge)},${Math.floor(cz / merge)}`;
      const list = blocks.get(key);
      if (list) list.push(mb);
      else blocks.set(key, [mb]);
    }
    const out: THREE.Mesh[] = [];
    for (const tiles of blocks.values()) {
      const total = tiles.reduce((n, mb) => n + mb.count, 0);
      const pos = new Float32Array(total * 3);
      const col = new Float32Array(total * 3);
      const ranges: [number, number][] = [];
      let at = 0;
      for (const mb of tiles) {
        mb.copyTo(pos, col, at);
        ranges.push([at, mb.count]);
        at += mb.count;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, material);
      out.push(mesh);
      if (!opts.shadows) continue;
      mesh.receiveShadow = true;
      if (merge === 1) {
        mesh.castShadow = true;
        continue;
      }
      for (const [start, count] of ranges) {
        const tile = new THREE.BufferGeometry();
        for (const name of ['position', 'color', 'normal']) tile.setAttribute(name, g.getAttribute(name));
        tile.setDrawRange(start, count);
        tile.boundingSphere = rangeSphere(pos, start, count);
        const proxy = new THREE.Mesh(tile, material);
        proxy.castShadow = true;
        proxy.intersectsFrustum = (f) => f instanceof THREE.Frustum && isShadowFrustum(f) && f.intersectsObject(proxy);
        out.push(proxy);
      }
    }
    return out;
  }

  get empty(): boolean {
    return [...this.chunks.values()].every((c) => c.mb.empty);
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
