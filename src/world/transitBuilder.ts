import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { RAPIER } from '../physics/world';
import type { MetroEntrance, Station, TransitSystem, Vec2 } from './cityData';
import { forward, right } from './cityData';
import type { MeshBuilder } from './meshBuilder';
import { METRO_ENTRANCE as ENTRANCE } from './metro';

/** System colors: roof band, signs. */
export const SYSTEM_STYLE: Record<TransitSystem, { color: string; label: string }> = {
  trolebus: { color: '#1f6fb8', label: 'TROLEBÚS' },
  ecovia: { color: '#c8372d', label: 'ECOVÍA' },
  metrobus: { color: '#2e9d57', label: 'METROBUS-Q' },
};
const METRO_RED = '#d7262e';

const PLATFORM_HEIGHT = 0.35;
const ROOF_HEIGHT = 3.1;
/** Platforms are built in slabs this long, each following the ground's slope. */
const SEGMENT = 8;
/** Open middle stretch of a platform where the bus doors line up (no glass). */
const DOOR_GAP = 14;

type Ground = (p: Vec2) => number;
type Part = (w: number, h: number, d: number, x: number, y: number, z: number, color: string, side?: string) => void;

/** Box parts placed in a local frame (x along `heading`, z to its right) at a point on the ground. */
function framer(mb: MeshBuilder, at: Vec2, base: number, heading: number): Part {
  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(at.x, base, at.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading),
    new THREE.Vector3(1, 1, 1),
  );
  return (w, h, d, x, y, z, color, side = color) => mb.add(new THREE.BoxGeometry(w, h, d), new THREE.Matrix4().makeTranslation(x, y, z).premultiply(frame), color, side);
}

/**
 * BRT station: a raised platform in slabs that follow the slope, glass walls toward the ends
 * (the middle is open where the bus doors line up), posts and a long roof with the system's
 * color band. The platform and walls are solid.
 */
export function addStation(mb: MeshBuilder, s: Station, ground: Ground, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const fw = forward(s.heading);
  const rt = right(s.heading);
  const at = (along: number, across: number): Vec2 => ({ x: s.pos.x + fw.x * along + rt.x * across, z: s.pos.z + fw.z * along + rt.z * across });
  const color = SYSTEM_STYLE[s.system].color;
  const n = Math.max(1, Math.round(s.length / SEGMENT));
  const seg = s.length / n;
  const hw = s.width / 2;
  for (let i = 0; i < n; i++) {
    const a = -s.length / 2 + i * seg;
    const b = a + seg;
    const mid = (a + b) / 2;
    // Slab: each corner rises from its own ground height.
    const pts: THREE.Vector3[] = [];
    for (const u of [a, b])
      for (const v of [-hw, hw]) {
        const p = at(u, v);
        const g = ground(p);
        pts.push(new THREE.Vector3(p.x, g - 0.4, p.z), new THREE.Vector3(p.x, g + PLATFORM_HEIGHT, p.z));
      }
    mb.add(new ConvexGeometry(pts), new THREE.Matrix4(), '#b8b4aa', '#8f8b82');
    world.createCollider(RAPIER.ColliderDesc.convexHull(new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z])))!.setFriction(0.8), fixed);

    const c = at(mid, 0);
    const top = Math.max(...[a, b].flatMap((u) => [-hw, hw].map((v) => ground(at(u, v))))) + PLATFORM_HEIGHT;
    const part = framer(mb, c, top, s.heading);
    part(seg + 0.02, 0.14, s.width + 0.6, 0, ROOF_HEIGHT + 0.07, 0, '#d9dde0', '#6c7278'); // roof
    part(seg + 0.02, 0.3, s.width + 0.64, 0, ROOF_HEIGHT - 0.12, 0, color); // color band
    for (const v of [-hw + 0.15, hw - 0.15]) part(0.14, ROOF_HEIGHT, 0.14, -seg / 2 + 0.2, ROOF_HEIGHT / 2, v, '#5f666d');
    // Glass along both edges, except around the doors in the middle.
    if (Math.abs(mid) > DOOR_GAP / 2) {
      for (const v of [-hw + 0.1, hw - 0.1]) part(seg - 0.3, 2.2, 0.06, 0, 1.2, v, '#a9c7d6');
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.heading);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(seg / 2, 1.1, hw).setTranslation(c.x, top + 1.1, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
        fixed,
      );
    }
  }
  // End walls.
  for (const u of [-s.length / 2 + 0.1, s.length / 2 - 0.1]) {
    const p = at(u, 0);
    framer(mb, p, ground(p) + PLATFORM_HEIGHT, s.heading)(0.08, 2.2, s.width - 0.2, 0, 1.1, 0, '#a9c7d6');
  }
}

/** Metro de Quito entrance: stairs going down under a canopy, open toward the street. */
export function addMetroEntrance(mb: MeshBuilder, e: MetroEntrance, ground: Ground, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const { length: L, width: W, roof } = ENTRANCE;
  const fw = forward(e.heading);
  const rt = right(e.heading);
  const corners = [-1, 1].flatMap((u) => [-1, 1].map((v) => ground({ x: e.pos.x + (fw.x * u * L) / 2 + (rt.x * v * W) / 2, z: e.pos.z + (fw.z * u * L) / 2 + (rt.z * v * W) / 2 })));
  const low = Math.min(...corners);
  const high = Math.max(...corners);
  // Walls start a little below the lowest corner so a slope never shows a gap under them.
  const part = framer(mb, e.pos, low - 0.3, e.heading);
  const up = high - low + 0.3;
  part(L - 0.3, 0.02, W - 0.5, 0.1, up + 0.03, 0, '#15171a'); // the dark stairwell
  for (let k = 0; k < 3; k++) part(0.25, 0.02, W - 0.5, L / 2 - 0.4 - k * 0.55, up + 0.05, 0, '#6d7076'); // top steps
  for (const v of [-W / 2 + 0.12, W / 2 - 0.12]) part(L, up + 1.1, 0.24, 0, (up + 1.1) / 2, v, '#c9c6bd'); // side parapets
  part(0.24, up + roof, W, -L / 2 + 0.12, (up + roof) / 2, 0, '#c9c6bd'); // back wall
  for (const v of [-W / 2 + 0.12, W / 2 - 0.12]) part(0.14, up + roof, 0.14, L / 2 - 0.1, (up + roof) / 2, v, '#4a525a'); // front posts
  part(L + 0.5, 0.16, W + 0.5, 0, up + roof + 0.08, 0, '#3b4652'); // canopy
  part(0.1, 0.35, W + 0.5, L / 2 + 0.25, up + roof, 0, METRO_RED, METRO_RED); // red fascia over the mouth
  // Totem beside the mouth: a post holding a board, whose faces carry the sign (`transitSigns`).
  const t = totemSpot(e);
  const board = ground(t) + TOTEM_SIGN_Y - (low - 0.3);
  const postTop = board - TOTEM_SIGN / 2;
  part(0.12, postTop, 0.12, L / 2 + 0.6, postTop / 2, W / 2 + 0.6, '#4a525a');
  part(TOTEM_DEPTH, TOTEM_SIGN + 0.08, TOTEM_SIGN + 0.08, L / 2 + 0.6, board, W / 2 + 0.6, '#3b4652');
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), e.heading);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(L / 2, (up + roof) / 2, W / 2)
      .setTranslation(e.pos.x, low - 0.3 + (up + roof) / 2, e.pos.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    fixed,
  );
}

const TOTEM_SIGN = 1.1;
const TOTEM_SIGN_Y = 3.3;
const TOTEM_DEPTH = 0.16;

/** Where a Metro entrance's totem stands: past the mouth, beside it. */
function totemSpot(e: MetroEntrance): Vec2 {
  const fw = forward(e.heading);
  const rt = right(e.heading);
  const k = ENTRANCE.length / 2 + 0.6;
  const s = ENTRANCE.width / 2 + 0.6;
  return { x: e.pos.x + fw.x * k + rt.x * s, z: e.pos.z + fw.z * k + rt.z * s };
}

/** Name boards (canvas textures): on top of each BRT station, and on each Metro totem. */
export function transitSigns(stations: Station[], metro: MetroEntrance[], ground: Ground): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  // Signs are canvas-drawn; headless tests build the city in Node, without a DOM.
  if (typeof document === 'undefined') return out;
  for (const s of stations) {
    const style = SYSTEM_STYLE[s.system];
    const tex = signTexture(style.color, style.label, s.name);
    // Over the middle of the roof, which follows the highest corner of its slab.
    const fw = forward(s.heading);
    const rt = right(s.heading);
    const middle = [-4, 4].flatMap((u) => [-1, 1].map((v) => ground({ x: s.pos.x + fw.x * u + (rt.x * v * s.width) / 2, z: s.pos.z + fw.z * u + (rt.z * v * s.width) / 2 })));
    const top = Math.max(...middle) + PLATFORM_HEIGHT + ROOF_HEIGHT + 0.75;
    for (const side of [0, Math.PI]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(7, s.length * 0.6), 0.9), new THREE.MeshBasicMaterial({ map: tex }));
      m.position.set(s.pos.x, top, s.pos.z);
      // Plane faces +Z locally; turn it to face across the avenue (each side's traffic).
      m.rotation.y = s.heading + side;
      out.push(m);
    }
  }
  for (const e of metro) {
    const p = totemSpot(e);
    const fw = forward(e.heading);
    const tex = signTexture(METRO_RED, 'METRO', e.name, true);
    for (const side of [1, -1]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(TOTEM_SIGN, TOTEM_SIGN), new THREE.MeshBasicMaterial({ map: tex }));
      // On the board's faces, just clear of it, so nothing passes in front of the sign.
      const off = (TOTEM_DEPTH / 2 + 0.01) * side;
      m.position.set(p.x + fw.x * off, ground(p) + TOTEM_SIGN_Y, p.z + fw.z * off);
      m.rotation.y = e.heading + Math.PI / 2 + (side > 0 ? 0 : Math.PI);
      out.push(m);
    }
  }
  return out;
}

function signTexture(color: string, label: string, name: string, square = false): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = square ? 128 : 512;
  canvas.height = square ? 128 : 96;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (square) {
    // The game's own Metro pictogram, not the city's logo (a white "M" on red is its identity):
    // a dark board with a red disc holding a train's front, and the station's name.
    ctx.fillStyle = '#20262d';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(64, 50, 38, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(46, 26, 36, 42, 8);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(51, 33, 26, 14); // windscreen
    ctx.beginPath();
    for (const x of [54, 74]) ctx.arc(x, 58, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillText(label, 64, 98);
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText(name.toUpperCase(), 64, 116, 120);
  } else {
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText(label, 256, 24);
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.fillText(name, 256, 64, 496);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
