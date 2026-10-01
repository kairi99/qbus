import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { CityData, Prop, Vec2, Wall } from './cityData';
import type { MeshBuilder } from './meshBuilder';

type Ground = (p: Vec2) => number;
type Sink = { at(x: number, z: number): MeshBuilder };

const PANEL_HEIGHT = 2.4;
const STEP = 2;
/** Invisible part of the boundary collider above the hoarding, so nothing jumps it off a ramp. */
const WALL_TOP = 7;
const ORANGE = '#e8702a';
const HOARDING = '#f1f1ec';
const QUITO_BLUE = '#1f5fbf';
const WALL = '#e3d8bd';
const WALL_CAP = '#b5a88a';

/** A "VÍA CERRADA" board facing into the play area. */
export interface WorksSign {
  pos: Vec2;
  heading: number;
  base: number;
}

/**
 * Closes the play area off with Quito roadworks along its edge: construction hoarding between
 * the streets, and where a street crosses, striped barriers, a "VÍA CERRADA" sign, cones (that
 * can be knocked over), and, just past the barrier, an idle excavator and workers taking a
 * break. A tall invisible wall runs along the whole edge.
 */
export function addRoadworks(
  sink: Sink,
  city: CityData,
  ground: Ground,
  paved: (p: Vec2) => boolean,
  blocked: (p: Vec2) => boolean,
  world: RAPIER.World,
  fixed: RAPIER.RigidBody,
): { cones: Prop[]; signs: WorksSign[] } {
  const area = city.playArea!;
  const { min, max } = area;
  const corners = [min, { x: max.x, z: min.z }, max, { x: min.x, z: max.z }];
  const cones: Prop[] = [];
  const signs: WorksSign[] = [];
  let crossing = 0;

  for (let side = 0; side < 4; side++) {
    const a = corners[side];
    const b = corners[(side + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    // Corners go counter-clockwise on screen (x east, z south): inward is to the right of travel.
    const inward = { x: -d.z, z: d.x };
    const heading = Math.atan2(-d.z, d.x);
    const at = (t: number): Vec2 => ({ x: a.x + d.x * t, z: a.z + d.z * t });

    // Hoarding panels and barrier pieces, 2 m at a time.
    let run: number[] = [];
    const flushRun = () => {
      if (run.length) roadClosed(run, at, inward, heading);
      run = [];
    };
    for (let t = 0; t + STEP <= len; t += STEP) {
      const mid = at(t + STEP / 2);
      if (paved(mid)) {
        run.push(t);
        barrier(sink, mid, heading, ground(mid), run.length % 2 ? ORANGE : HOARDING);
        continue;
      }
      flushRun();
      if (blocked(mid)) continue;
      hoarding(sink, mid, heading, Math.min(ground(at(t)), ground(at(t + STEP))), Math.max(ground(at(t)), ground(at(t + STEP))), t % 20 < STEP);
    }
    flushRun();

    // The wall that actually stops the bus, in 20 m pieces that follow the ground.
    for (let t = 0; t < len; t += 20) {
      const t1 = Math.min(len, t + 20);
      const hs = [t, (t + t1) / 2, t1].map((u) => ground(at(u)));
      const lo = Math.min(...hs) - 2;
      const hi = Math.max(...hs) + WALL_TOP;
      const c = at((t + t1) / 2);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid((t1 - t) / 2, (hi - lo) / 2, 0.3)
          .setTranslation(c.x, (lo + hi) / 2, c.z)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
        fixed,
      );
    }
  }
  return { cones, signs };

  /** A street closed where it crosses the edge: sign and cones inside, machinery beyond. */
  function roadClosed(run: number[], at: (t: number) => Vec2, inward: Vec2, heading: number): void {
    const t0 = run[0];
    const t1 = run[run.length - 1] + STEP;
    const mid = at((t0 + t1) / 2);
    const off = (p: Vec2, k: number): Vec2 => ({ x: p.x + inward.x * k, z: p.z + inward.z * k });
    const signAt = off(mid, 1.6);
    signs.push({ pos: signAt, heading: Math.atan2(inward.x, inward.z), base: ground(signAt) });
    const part = framer(sink.at(signAt.x, signAt.z), signAt, ground(signAt), heading);
    for (const x of [-1.1, 1.1]) part(0.1, 2.2, 0.1, x, 1.1, 0, '#555');
    part(2.6, 1.3, 0.06, 0, 1.75, -0.04, '#f2f2f2'); // back of the board (the face is a texture)
    // Cones in a staggered line a few meters in front of the barrier.
    for (let t = t0 + 1; t < t1; t += 3.2) {
      const p = off(at(t), 3 + ((t * 7.3) % 1.5));
      if (paved(p)) cones.push({ kind: 'cone', pos: p, heading: 0 });
    }
    crossing++;
    // Past the barrier: an excavator on every other closed street, a couple of workers on break.
    if (t1 - t0 >= 6) {
      if (crossing % 2) excavator(sink, off(at(t0 + (t1 - t0) * 0.3), -7), heading + (crossing % 4 ? 0.4 : -0.3), ground);
      worker(sink, off(at(t0 + (t1 - t0) * 0.7), -2.2), heading - Math.PI / 2 + 0.3, ground, true);
      worker(sink, off(at(t0 + (t1 - t0) * 0.7 + 1.4), -3.4), heading + 2.2, ground, false);
    }
  }
}

/** Campus walls: plain painted walls with a cap, in short pieces that follow the slope. */
export function addWalls(sink: Sink, walls: Wall[], ground: Ground, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const HEIGHT = 2.6;
  for (const w of walls) {
    // Merge 2 m steps into straight pieces up to 6 m long.
    let start = 0;
    for (let i = 1; i < w.points.length; i++) {
      const a = w.points[start];
      const b = w.points[i];
      const next = w.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const bends = next && Math.abs((next.x - a.x) * (b.z - a.z) - (next.z - a.z) * (b.x - a.x)) / (len || 1) > 0.3;
      if (next && len < 6 && !bends) continue;
      if (len > 0.3) {
        const c = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
        const lo = Math.min(ground(a), ground(b), ground(c)) - 0.3;
        const hi = Math.max(ground(a), ground(b), ground(c)) + HEIGHT;
        const heading = Math.atan2(-(b.z - a.z), b.x - a.x);
        const part = framer(sink.at(c.x, c.z), c, lo, heading);
        part(len + 0.25, hi - lo, 0.25, 0, (hi - lo) / 2, 0, WALL);
        part(len + 0.3, 0.12, 0.34, 0, hi - lo + 0.06, 0, WALL_CAP);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
        world.createCollider(
          // Exactly the drawn wall and its cap: anything taller is an invisible wall.
          RAPIER.ColliderDesc.cuboid(len / 2 + 0.1, (hi - lo + 0.12) / 2, 0.15)
            .setTranslation(c.x, lo + (hi - lo + 0.12) / 2, c.z)
            .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
          fixed,
        );
      }
      start = i;
    }
  }
}

type Part = (w: number, h: number, d: number, x: number, y: number, z: number, color: string, side?: string) => void;

/** Box parts in a local frame (x along `heading`, z to its right) standing on `base`. */
function framer(mb: MeshBuilder, at: Vec2, base: number, heading: number, tilt = 0): Part {
  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(at.x, base, at.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, heading, tilt, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );
  return (w, h, d, x, y, z, color, side = color) => mb.add(new THREE.BoxGeometry(w, h, d), new THREE.Matrix4().makeTranslation(x, y, z).premultiply(frame), color, side);
}

/** One 2 m hoarding panel: white with a blue band, and a post every 20 m. */
function hoarding(sink: Sink, mid: Vec2, heading: number, lo: number, hi: number, post: boolean): void {
  const part = framer(sink.at(mid.x, mid.z), mid, lo - 0.3, heading);
  const h = hi - lo + 0.3 + PANEL_HEIGHT;
  part(STEP + 0.02, h, 0.06, 0, h / 2, 0, HOARDING);
  part(STEP + 0.03, 0.5, 0.08, 0, h - 0.9, 0, QUITO_BLUE);
  if (post) part(0.14, h + 0.1, 0.14, -STEP / 2, (h + 0.1) / 2, 0.08, '#6b6f75');
}

/** A striped plastic road barrier (orange or white). */
function barrier(sink: Sink, mid: Vec2, heading: number, base: number, color: string): void {
  const part = framer(sink.at(mid.x, mid.z), mid, base, heading);
  part(1.9, 0.75, 0.45, 0, 0.375, 0, color);
  part(1.9, 0.12, 0.3, 0, 0.8, 0, color === ORANGE ? HOARDING : ORANGE);
}

/** A little yellow excavator, arm down, bucket resting on the asphalt. */
function excavator(sink: Sink, p: Vec2, heading: number, ground: Ground): void {
  const part = framer(sink.at(p.x, p.z), p, ground(p), heading);
  const yellow = '#e9b52a';
  for (const z of [-1.05, 1.05]) part(3.4, 0.7, 0.6, 0, 0.35, z, '#2b2b2b'); // tracks
  part(2.6, 0.9, 2.2, -0.2, 1.15, 0, yellow); // body
  part(1.2, 1.3, 1.2, -0.4, 2.25, -0.45, '#c9d9e3', yellow); // cab
  part(0.9, 0.5, 2.0, -1.4, 1.75, 0, '#444'); // counterweight
  const boom = framer(sink.at(p.x, p.z), p, ground(p), heading, -0.45);
  boom(2.8, 0.35, 0.35, 2.1, 2.2, 0.3, yellow);
  const stick = framer(sink.at(p.x, p.z), p, ground(p), heading, 0.9);
  stick(2.0, 0.3, 0.3, 3.6, -1.2, 0.3, yellow);
  part(0.8, 0.6, 1.0, 3.9, 0.35, 0.3, '#3a3a3a'); // bucket
}

/** A roadworker in an orange vest and white helmet: leaning on a shovel, or sitting down. */
function worker(sink: Sink, p: Vec2, heading: number, ground: Ground, sitting: boolean): void {
  const part = framer(sink.at(p.x, p.z), p, ground(p), heading);
  if (sitting) {
    part(0.45, 0.4, 0.45, 0, 0.2, 0, '#6b6f75'); // bucket to sit on
    part(0.4, 0.2, 0.6, 0.25, 0.5, 0, '#2b3a55'); // legs forward
    part(0.42, 0.55, 0.3, 0, 0.75, 0, ORANGE);
    part(0.3, 0.3, 0.3, 0, 1.2, 0, '#a8704a');
    part(0.36, 0.14, 0.36, 0, 1.42, 0, '#f4f4f4');
  } else {
    part(0.36, 0.8, 0.24, 0, 0.4, 0, '#2b3a55');
    part(0.44, 0.6, 0.3, 0, 1.1, 0, ORANGE);
    part(0.3, 0.3, 0.3, 0, 1.55, 0, '#c68a5b');
    part(0.36, 0.14, 0.36, 0, 1.77, 0, '#f4f4f4');
    part(0.06, 1.3, 0.06, 0.35, 0.65, 0.25, '#7a5a3a'); // shovel handle
    part(0.3, 0.3, 0.04, 0.35, 0.05, 0.25, '#555');
  }
}

/** "VÍA CERRADA" boards (canvas textures), facing into the play area (`heading` = yaw of the face). */
export function worksSigns(signs: WorksSign[]): THREE.Mesh[] {
  if (typeof document === 'undefined' || !signs.length) return [];
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const c = canvas.getContext('2d')!;
  c.fillStyle = ORANGE;
  c.fillRect(0, 0, 512, 256);
  c.fillStyle = '#1b1b1b';
  c.fillRect(10, 10, 492, 236);
  c.fillStyle = ORANGE;
  c.fillRect(18, 18, 476, 220);
  c.fillStyle = '#1b1b1b';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = 'bold 72px system-ui, sans-serif';
  c.fillText('VÍA CERRADA', 256, 78);
  c.font = 'bold 34px system-ui, sans-serif';
  c.fillText('Obras del Municipio', 256, 146);
  c.font = 'italic 28px system-ui, sans-serif';
  c.fillText('Terminamos ya mismo. Disculpe.', 256, 198);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const geo = new THREE.PlaneGeometry(2.5, 1.25);
  return signs.map((s) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(s.pos.x, s.base + 1.75, s.pos.z);
    // The plane faces +Z locally: turn it toward the inside of the play area.
    m.rotation.y = s.heading;
    return m;
  });
}
