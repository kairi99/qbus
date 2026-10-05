import * as THREE from 'three';
import type { Building, Vec2 } from './cityData';
import { distToSegment, pointInPolygon } from './geom';
import { type ChunkedMeshBuilder, type ChunkedUVQuadBuilder, type MeshBuilder, hash2 } from './meshBuilder';
import type { RoadIndex } from './roadIndex';
import type { Lighting } from './sky';
import { pickSign, signUV } from './signAtlas';

export const FLOOR_HEIGHT = 3.2;

/**
 * How a building looks: old houses with pastel paint (2–4 floors), apartment towers with
 * balconies, glass offices along the main avenues, plain institutional blocks (campus,
 * schools, hospitals, churches: no shops or balconies).
 */
type Style = 'house' | 'tower' | 'glass' | 'civic';

export interface BuildingLook {
  style: Style;
  wall: string;
  roof: string;
  trim: string;
  glass: string;
}

export interface FacadeContext {
  /** Facade detail: windows, balconies, shopfronts (the plain prisms are drawn elsewhere). */
  detail: ChunkedMeshBuilder;
  /** Lit from inside, unshaded (only filled when it's dark enough for lights). */
  glow: ChunkedMeshBuilder;
  /** Shop signs, mapped onto the sign atlas (null: no atlas, e.g. headless). */
  signs: ChunkedUVQuadBuilder | null;
  /** Terrain height. */
  ground: (p: Vec2) => number;
  roads: RoadIndex;
  /** Avenues only ("Av. ..." in Quito): glass offices and more shops along them. */
  avenues: RoadIndex;
  buildings: BuildingIndex;
  light: Lighting;
}

/** Grid-hashed building footprints: inside tests and distance to the nearest wall. */
export class BuildingIndex {
  private cells = new Map<string, Vec2[][]>();

  constructor(
    footprints: Vec2[][],
    private cell = 40,
  ) {
    for (const f of footprints) {
      const xs = f.map((p) => p.x);
      const zs = f.map((p) => p.z);
      for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++)
        for (let z = Math.floor(Math.min(...zs) / cell); z <= Math.floor(Math.max(...zs) / cell); z++) {
          const key = `${x},${z}`;
          const list = this.cells.get(key);
          if (list) list.push(f);
          else this.cells.set(key, [f]);
        }
    }
  }

  private near(p: Vec2): Vec2[][] {
    return this.cells.get(`${Math.floor(p.x / this.cell)},${Math.floor(p.z / this.cell)}`) ?? [];
  }

  contains(p: Vec2): boolean {
    return this.near(p).some((f) => pointInPolygon(p, f));
  }

  /** Distance to the nearest building wall (0 inside one), looking no further than the cell around `p`. */
  distance(p: Vec2): number {
    let best = Infinity;
    for (const dx of [-1, 0, 1])
      for (const dz of [-1, 0, 1])
        for (const f of this.cells.get(`${Math.floor(p.x / this.cell) + dx},${Math.floor(p.z / this.cell) + dz}`) ?? []) {
          if (pointInPolygon(p, f)) return 0;
          for (let i = 0; i < f.length; i++) best = Math.min(best, distToSegment(p, f[i], f[(i + 1) % f.length]));
        }
    return best;
  }
}

// Paint by neighborhood: a slow pattern over the map picks warm pastels, cool pastels or
// whites, so a block reads as a whole and the next one differs.
const HOUSE_PAINT = [
  ['#f3d9a4', '#f2c1a0', '#efb7b0', '#f6e3c5', '#e8c07a', '#f0a98c', '#f7d27c'],
  ['#bfd9d2', '#b9cde6', '#cfc4e3', '#d7e6c3', '#a8d0dc', '#e7eef0', '#c3dbb4'],
  ['#f4efe4', '#ebe3d0', '#f7f4ec', '#e2d6bf', '#d9c9a8', '#efe6d6', '#e9dcc6'],
];
const TOWER_PAINT = ['#e8e4da', '#d6d2c8', '#c9b8a0', '#b89a7c', '#dcd7cf', '#a9a59c', '#c8cdd2', '#a8644a', '#e4d9c4', '#9fa7ad'];
const GLASS_FRAME = ['#5d7488', '#3f5566', '#7a8f9e', '#4d6b6a', '#8aa0ad', '#2f3e4c', '#6c7a86'];
const GLASS_PANE = ['#8fb3cf', '#6f95ad', '#9fc1c7', '#a7b9c9', '#7fa6b8', '#5f8aa6'];
const CIVIC_PAINT = ['#e6e1d3', '#d9d4c6', '#cfc9b8', '#bfb6a2', '#e0dccf'];
const TILE_ROOF = ['#b5563a', '#a84f36', '#c0643f', '#9e4a34'];
const AWNING = ['#c0392b', '#1e7a4f', '#2b5fa8', '#e3a21a', '#7a3e8e', '#d35400', '#26867d', '#b03a6a'];
const SHUTTER = ['#9aa0a6', '#7f878e', '#a7a39a', '#8a9399'];
const LIT = ['#ffd27a', '#ffe2a6', '#ffcf8a', '#fff0c8', '#cfe0ff'];
const SHOP_LIT = ['#f2d49a', '#eedcb8', '#f5c98a', '#e3e9f0'];
const SHOP_GLASS = ['#5a6e7c', '#62747f', '#4f6573', '#6b7d86'];

const pick = <T>(list: readonly T[], r: number): T => list[Math.floor(r * list.length) % list.length];

function neighborhood(c: Vec2): number {
  const n = Math.sin(c.x * 0.0041 + 1.3) * Math.cos(c.z * 0.0053 - 0.7) + 0.6 * Math.sin((c.x + c.z) * 0.0093);
  return n > 0.3 ? 0 : n < -0.3 ? 1 : 2;
}

const CIVIC = new Set(['university', 'college', 'school', 'hospital', 'church', 'public', 'civic', 'mosque', 'government']);
const HOMES = new Set(['house', 'detached', 'residential', 'terrace']);

/** Style and colors of a building, from its OSM use, height and whether it stands on an avenue. */
export function buildingLook(ctx: FacadeContext, b: Building): BuildingLook {
  const c = centroid(b.footprint);
  const r = (salt: number) => hash2(c.x, c.z, salt);
  const floors = Math.max(1, Math.round(b.height / FLOOR_HEIGHT));
  const onAvenue = b.footprint.some((p) => ctx.avenues.clearance(p) < 22);
  let style: Style;
  if (b.use && CIVIC.has(b.use)) style = 'civic';
  else if (floors <= 3 || (floors === 4 && (!b.use || HOMES.has(b.use)) && r(1) < 0.5)) style = 'house';
  else if ((onAvenue && floors >= 5 && r(2) < 0.75) || b.use === 'office' || (floors >= 12 && r(2) < 0.4)) style = 'glass';
  else style = 'tower';
  switch (style) {
    case 'house':
      return { style, wall: pick(HOUSE_PAINT[neighborhood(c)], r(3)), roof: floors <= 2 || r(4) < 0.5 ? pick(TILE_ROOF, r(5)) : '#a3a199', trim: r(6) < 0.7 ? '#f7f5ee' : '#8a6a52', glass: '#4f5a63' };
    case 'tower':
      return { style, wall: pick(TOWER_PAINT, r(3)), roof: '#9a9a96', trim: r(6) < 0.6 ? '#f2f0ea' : '#7d7f82', glass: '#55636f' };
    case 'glass':
      return { style, wall: pick(GLASS_FRAME, r(3)), roof: '#7d8288', trim: '#d9dde0', glass: pick(GLASS_PANE, r(5)) };
    case 'civic':
      return { style, wall: pick(CIVIC_PAINT, r(3)), roof: floors <= 2 ? pick(TILE_ROOF, r(5)) : '#9a9a96', trim: '#f4f2ea', glass: '#4f5a63' };
  }
}

/**
 * Windows, balconies, cornices and (on walls facing a street) shopfronts with awnings, shutters
 * and signs. Everything here is decoration on the building's own walls: the building's collider
 * is its plain prism, and nothing here reaches further out than an awning over the sidewalk.
 * `top` is the highest ground under the building (where its floors are counted from).
 */
export function addFacades(ctx: FacadeContext, b: Building, look: BuildingLook, top: number): void {
  const c = centroid(b.footprint);
  const mb = ctx.detail.at(c.x, c.z);
  const glow = ctx.glow.at(c.x, c.z);
  const floors = Math.max(1, Math.round(b.height / FLOOR_HEIGHT));
  const roofY = top + b.height;
  const r = (salt: number) => hash2(c.x, c.z, salt);
  const orient = signedArea(b.footprint) > 0 ? 1 : -1;
  const lit = ctx.light.litWindows;
  const dark = lit > 0;
  const shopChance =
    look.style === 'civic' ? 0 : b.shop || b.use === 'commercial' || b.use === 'retail' ? 0.95 : look.style === 'glass' ? 0.55 : b.footprint.some((p) => ctx.avenues.clearance(p) < 22) ? 0.85 : 0.5;
  const hasShops = r(10) < shopChance;
  const balconies = (look.style === 'house' && r(11) < 0.5) || (look.style === 'tower' && floors <= 14 && r(11) < 0.6);
  const bay = look.style === 'glass' ? 1.5 : look.style === 'tower' ? 2.4 + r(12) * 0.6 : 2.6 + r(12) * 0.6;
  const glassColor = dark ? '#232a33' : look.glass;
  const plinth = shade(look.wall, 0.72);

  for (let i = 0; i < b.footprint.length; i++) {
    const p0 = b.footprint[i];
    const p1 = b.footprint[(i + 1) % b.footprint.length];
    const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (len < 2.5) continue;
    const d = { x: (p1.x - p0.x) / len, z: (p1.z - p0.z) / len };
    const n = { x: orient * d.z, z: -orient * d.x };
    const at = (t: number, out: number): Vec2 => ({ x: p0.x + d.x * t + n.x * out, z: p0.z + d.z * t + n.z * out });
    const pt = (t: number, y: number, out: number) => {
      const q = at(t, out);
      return { x: q.x, y, z: q.z };
    };
    const quad = (m: MeshBuilder, t0: number, t1: number, y0: number, y1: number, out: number, color: string) =>
      m.quad(pt(t0, y0, out), pt(t1, y0, out), pt(t1, y1, out), pt(t0, y1, out), color);
    // A window: lit ones (when it's dark) go to the glow layer.
    const pane = (t0: number, t1: number, y0: number, y1: number, out: number, color = glassColor) => {
      const k = hash2(p0.x + t0 * 1.7, p0.z + y0 * 3.1, 7);
      if (dark && k < lit) quad(glow, t0, t1, y0, y1, out, pick(LIT, k / lit));
      else quad(mb, t0, t1, y0, y1, out, color);
    };
    // A wall against the next building (party walls fill La Mariscal's blocks) can't be seen.
    if ([0.2, 0.5, 0.8].every((k) => ctx.buildings.contains(at(len * k, 1.2)))) continue;
    const street = facesStreet(ctx, at(len / 2, 0.6), n);
    const shops = hasShops && street !== null && len >= 3.5;
    const g0 = ctx.ground(p0);
    const g1 = ctx.ground(p1);

    // Plinth: a darker band along the foot of the wall (shopfronts have their own).
    if (!shops && look.style !== 'glass')
      mb.quad(pt(0, Math.min(g0, g1) - 0.3, 0.02), pt(len, Math.min(g0, g1) - 0.3, 0.02), pt(len, g1 + 0.6, 0.02), pt(0, g0 + 0.6, 0.02), plinth);
    // Cornice / parapet edge along the top.
    quad(mb, -0.08, len + 0.08, roofY - 0.35, roofY + 0.12, 0.07, look.style === 'glass' ? look.trim : look.trim);

    if (shops) shopfronts(ctx, mb, glow, b, len, at, pt, quad, r(20 + i), Math.min(street!, 6), orient > 0);
    const first = shops ? 1 : 0;

    if (look.style === 'glass') {
      // Curtain wall: a glass band per floor, mullions down the whole height.
      const lobby = !shops;
      if (lobby) pane(0.4, len - 0.4, top, top + FLOOR_HEIGHT - 0.2, 0.05, look.glass);
      for (let f = 1; f < floors; f++) {
        const y = top + f * FLOOR_HEIGHT;
        if (!dark) quad(mb, 0.3, len - 0.3, y + 0.35, y + 2.95, 0.05, look.glass);
        else for (let t = 0.3; t < len - 0.4; t += bay * 3) pane(t, Math.min(len - 0.3, t + bay * 3), y + 0.35, y + 2.95, 0.05);
      }
      if (floors > 1) for (let t = bay; t < len - 0.5; t += bay) quad(mb, t - 0.06, t + 0.06, top + FLOOR_HEIGHT, roofY - 0.35, 0.08, look.wall);
      continue;
    }

    if (look.style === 'tower' || (look.style === 'civic' && floors > 3)) {
      // Window rows: a band per floor split into windows by piers running up the facade.
      for (let f = first; f < floors; f++) {
        const y = top + f * FLOOR_HEIGHT;
        if (!dark) quad(mb, 0.6, len - 0.6, y + 0.85, y + 2.45, 0.05, look.glass);
        else for (let t = 0.6; t < len - 0.7; t += bay) pane(t, Math.min(len - 0.6, t + bay), y + 0.85, y + 2.45, 0.05);
        // Floor slab line.
        quad(mb, 0, len, y - 0.09, y + 0.09, 0.06, look.trim);
      }
      const y0 = top + first * FLOOR_HEIGHT + 0.5;
      for (let t = bay; t < len - 0.7; t += bay) quad(mb, t - 0.22, t + 0.22, y0, roofY - 0.35, 0.08, look.wall);
      if (balconies && street !== null && look.style === 'tower') {
        const railing = r(13) < 0.5 ? '#9fb7c4' : look.trim;
        for (let t = bay; t + bay < len - 0.7; t += bay * 3)
          for (let f = Math.max(1, first); f < floors; f++) balcony(mb, pt, t + 0.25, t + bay - 0.25, top + f * FLOOR_HEIGHT, 1.0, railing, look.wall);
      }
      continue;
    }

    // Houses (and low civic buildings): framed windows, French windows onto small balconies.
    const count = Math.max(1, Math.floor((len - 0.8) / bay));
    const gap = len / count;
    for (let f = first; f < floors; f++) {
      const y = top + f * FLOOR_HEIGHT;
      for (let w = 0; w < count; w++) {
        const t = gap * (w + 0.5);
        const door = balconies && street !== null && f >= 1 && (w + f) % 2 === 0 && look.style === 'house';
        const y0 = door ? y + 0.15 : y + 0.95;
        const y1 = door ? y + 2.35 : y + 2.3;
        if (street !== null) quad(mb, t - 0.72, t + 0.72, y0 - 0.14, y1 + 0.14, 0.03, look.trim); // frames on the street side
        pane(t - 0.55, t + 0.55, y0, y1, 0.05);
        if (door) balcony(mb, pt, t - 0.95, t + 0.95, y, 0.75, look.trim, look.wall);
      }
    }
  }

  // On the roof: a water tank on houses, a machine room on taller blocks.
  const inside = (q: Vec2) => pointInPolygon(q, b.footprint);
  if (inside(c) && r(30) < (look.style === 'house' ? 0.55 : 0.8)) {
    const m = new THREE.Matrix4();
    if (look.style === 'house') {
      const tank = new THREE.CylinderGeometry(0.55, 0.55, 1.1, 7);
      mb.add(tank, m.makeTranslation(c.x + (r(31) - 0.5) * 2, roofY + 0.55, c.z + (r(32) - 0.5) * 2), '#2b2d2f', '#1d1f21');
      tank.dispose();
    } else {
      const room = new THREE.BoxGeometry(2.6 + r(33) * 1.5, 2.6, 2.4 + r(34) * 1.5);
      mb.add(room, m.makeRotationY(r(35) * Math.PI).setPosition(c.x, roofY + 1.3, c.z), '#8e8e8a', look.style === 'glass' ? look.wall : shade(look.wall, 0.9));
      room.dispose();
    }
  }
}

type Pt = (t: number, y: number, out: number) => { x: number; y: number; z: number };
type Quad = (m: MeshBuilder, t0: number, t1: number, y0: number, y1: number, out: number, color: string) => void;

/** A balcony from t0 to t1 on the floor at `y`, `depth` deep, with solid parapets. */
function balcony(mb: MeshBuilder, pt: Pt, t0: number, t1: number, y: number, depth: number, parapet: string, slab: string): void {
  // Four quads: they add up over a whole city.
  const lo = y - 0.12;
  const hi = y + 1.0;
  mb.quad(pt(t0, lo, depth), pt(t1, lo, depth), pt(t1, hi, depth), pt(t0, hi, depth), parapet); // front
  for (const t of [t0, t1]) mb.quad(pt(t, lo, 0), pt(t, lo, depth), pt(t, hi, depth), pt(t, hi, 0), parapet); // sides
  mb.quad(pt(t0, lo, 0), pt(t1, lo, 0), pt(t1, lo, depth), pt(t0, lo, depth), slab); // underside (its floor is hidden behind the parapet)
}

/**
 * Ground-floor shops along a wall facing the street: each unit has its own floor height (the
 * sidewalk slopes), a glass front with a door or a pulled-down metal shutter, a fascia with
 * the shop's sign, and often an awning over the sidewalk where there's room for it.
 */
function shopfronts(
  ctx: FacadeContext,
  mb: MeshBuilder,
  glow: MeshBuilder,
  b: Building,
  len: number,
  at: (t: number, out: number) => Vec2,
  pt: Pt,
  quad: Quad,
  seed: number,
  room: number,
  /** The wall runs right to left as seen from the street: signs are laid out the other way. */
  flip: boolean,
): void {
  const units = Math.max(1, Math.round((len - 0.6) / (4 + seed * 2)));
  const w = (len - 0.6) / units;
  const signs = ctx.signs?.at(at(len / 2, 0).x, at(len / 2, 0).z);
  const dark = ctx.light.litWindows > 0;
  for (let u = 0; u < units; u++) {
    const t0 = 0.3 + u * w;
    const t1 = t0 + w;
    const mid = (t0 + t1) / 2;
    const k = (salt: number) => hash2(at(mid, 0).x, at(mid, 0).z, salt);
    const g = Math.max(ctx.ground(at(t0, 0.5)), ctx.ground(at(t1, 0.5)), ctx.ground(at(mid, 0.5))) + 0.04;
    // Fascia band and the sign on it.
    quad(mb, t0, t1, g + 2.5, g + 3.2, 0.04, '#2f3336');
    if (signs) {
      const half = (flip ? -1 : 1) * (Math.min(w - 0.4, 3.6) / 2);
      const uv = signUV(pickSign(k(1), b.shop, b.use));
      signs.quad(pt(mid - half, g + 2.58, 0.07), pt(mid + half, g + 2.58, 0.07), pt(mid + half, g + 3.12, 0.07), pt(mid - half, g + 3.12, 0.07), uv);
    }
    // The opening: shop window with a door, or a closed shutter (more of them at night).
    const shut = k(2) < (ctx.light.pools ? 0.45 : 0.15); // at night many have closed
    const o0 = t0 + 0.2;
    const o1 = t1 - 0.2;
    if (shut) {
      quad(mb, o0, o1, g - 0.1, g + 2.45, 0.04, pick(SHUTTER, k(3)));
      for (let y = g + 0.35; y < g + 2.4; y += 0.42) quad(mb, o0, o1, y, y + 0.05, 0.05, '#5d6166');
    } else {
      quad(mb, o0, o1, g - 0.1, g + 2.45, 0.03, '#2d3236'); // frame and bulkhead
      const door = k(4) < 0.5 ? o0 + 0.15 : o1 - 1.15;
      const panes: [number, number][] = door < mid ? [[door + 1.1, o1 - 0.1]] : [[o0 + 0.1, door - 0.1]];
      for (const [a, z] of panes) if (z - a > 0.4) (dark ? glow : mb).quad(pt(a, g + 0.45, 0.05), pt(z, g + 0.45, 0.05), pt(z, g + 2.35, 0.05), pt(a, g + 2.35, 0.05), dark ? pick(SHOP_LIT, k(5)) : pick(SHOP_GLASS, k(5)));
      quad(dark ? glow : mb, door, door + 1.0, g, g + 2.3, 0.05, dark ? '#c9a66a' : '#1e2328');
    }
    // Awning, only where the sidewalk has room for it (never over the road).
    if (k(6) < 0.6 && room >= 2 && [t0, t1].every((t) => ctx.roads.clearance(at(t, 1.2)) > 0.3 && !ctx.buildings.contains(at(t, 1.2)))) {
      const color = pick(AWNING, k(7));
      const striped = k(8) < 0.45;
      const n = striped ? Math.max(2, Math.round(w / 0.5)) : 1;
      for (let s = 0; s < n; s++) {
        const a = t0 + 0.1 + ((w - 0.2) * s) / n;
        const z = t0 + 0.1 + ((w - 0.2) * (s + 1)) / n;
        const col = striped && s % 2 ? '#f4f1e8' : color;
        mb.quad(pt(a, g + 2.55, 0.05), pt(z, g + 2.55, 0.05), pt(z, g + 2.2, 1.1), pt(a, g + 2.2, 1.1), col);
        mb.quad(pt(a, g + 2.2, 1.1), pt(z, g + 2.2, 1.1), pt(z, g + 1.98, 1.1), pt(a, g + 1.98, 1.1), col);
      }
    }
  }
}

/** Distance out from a wall (point `from`, outward normal `n`) to a street's asphalt, or null if another building is in the way. */
function facesStreet(ctx: FacadeContext, from: Vec2, n: Vec2): number | null {
  for (let k = 0; k <= 16; k += 1) {
    const q = { x: from.x + n.x * k, z: from.z + n.z * k };
    if (ctx.roads.clearance(q) < 0) return k + 0.6;
    if (ctx.buildings.contains(q)) return null;
  }
  return null;
}

function shade(color: string, k: number): string {
  return '#' + new THREE.Color(color).multiplyScalar(k).getHexString();
}

function signedArea(ring: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

export function centroid(poly: Vec2[]): Vec2 {
  return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, z: poly.reduce((s, p) => s + p.z, 0) / poly.length };
}
