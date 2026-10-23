import * as THREE from 'three';
import { type BusPreset, rearLift } from './busPreset';

const flat = (color: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color, flatShading: true });
const lit = (color: THREE.ColorRepresentation) => new THREE.MeshBasicMaterial({ color });
const GLASS = '#1c2a38';
const CHROME = '#c9ccd1';
const DARK = '#25272b';

/** Not a real company (see CLAUDE.md): the tractor's maker "Taitar" (taita: Quechua "father"). The container carries no text or logo. */
export const TRUCK_BRAND = 'TAITAR';

function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/** A cylinder along y (a stack) or, with `along: 'x'`, along the vehicle (a tank). */
function pipe(r: number, len: number, x: number, y: number, z: number, mat: THREE.Material, along: 'x' | 'y' = 'y'): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
  if (along === 'x') m.rotation.z = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

/** Heights shared by the parts, from the preset (the front section's center is the origin, +X forward). */
function layout(preset: BusPreset) {
  const w = preset.wheels;
  const art = preset.articulated!;
  const lift = rearLift(preset);
  return {
    /** Tractor: ground height (front-section y) and its length. */
    G: w.mountHeight - 0.31 - w.radius,
    Lf: preset.body.length - art.rearLength - art.gap,
    W: preset.body.width,
    /** Trailer: ground height (rear-section y) and the hinge's x on the tractor. */
    Gt: w.mountHeight - lift - 0.41 - w.radius,
    lift,
  };
}

/** Where a driven exhaust flame (nitro) comes out: the stack tops (front-section coordinates). */
export function truckStacks(preset: BusPreset): [number, number, number][] {
  const { G, Lf } = layout(preset);
  const x = -Lf / 2 + 2.6;
  return [
    [x, G + 4.0, 0.98],
    [x, G + 4.0, 1.2],
  ];
}

/** The cab's front plate: the maker's name over a chrome plaque. */
function plaque(): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#d7dadf';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#16181c';
  ctx.fillRect(6, 6, 244, 52);
  ctx.fillStyle = '#e8eaee';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(TRUCK_BRAND, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.2), new THREE.MeshBasicMaterial({ map: tex }));
  m.rotation.y = Math.PI / 2;
  return m;
}

/**
 * The tractor: a conventional (long-nosed) cab with a flat roof and air deflector, hood, grille
 * with the maker's plaque, headlights, mirrors, twin exhaust stacks behind the cab, fuel tanks,
 * fenders over the wheels, the frame and the fifth wheel the trailer's kingpin sits in. In the
 * front section's space: its box is `Lf` long, `W` wide, with the ground `G` below its center.
 */
export function truckTractor(preset: BusPreset): THREE.Object3D[] {
  const { G, Lf, W } = layout(preset);
  const { color, stripe, roof } = preset.body;
  const paint = flat(color);
  const trim = flat(stripe);
  const white = flat(roof);
  const chrome = flat(CHROME);
  const dark = flat(DARK);
  const glass = flat(GLASS);
  const y = (h: number) => G + h;
  const front = Lf / 2;
  const out: THREE.Object3D[] = [];

  // Frame, bumper, fifth wheel.
  out.push(box(Lf - 0.35, 0.3, 1.05, -0.2, y(0.95), 0, dark));
  out.push(box(0.3, 0.42, W * 0.96, front - 0.1, y(0.78), 0, chrome));
  out.push(box(0.2, 0.1, 1.0, front - 0.05, y(0.48), 0, dark));
  const hinge = -(Lf / 2 + preset.articulated!.gap / 2);
  out.push(box(1.5, 0.22, 1.35, hinge - 0.05, y(1.2), 0, dark));
  out.push(pipe(0.62, 0.12, hinge, preset.articulated!.hingeY! - 0.04, 0, flat('#44474d')));
  out.push(box(0.7, 0.1, 0.18, hinge - 0.5, preset.articulated!.hingeY! - 0.04, 0, dark));

  // Nose: hood, grille, lights.
  const hoodX = front - 1.15;
  out.push(box(2.15, 0.9, 1.66, hoodX, y(1.8), 0, paint));
  out.push(box(0.1, 1.1, 1.62, front - 0.28, y(1.8), 0, dark)); // grille
  for (let i = 0; i < 5; i++) out.push(box(0.05, 0.06, 1.5, front - 0.2, y(1.4 + i * 0.2), 0, chrome));
  out.push(box(0.06, 1.2, 0.07, front - 0.22, y(1.8), -0.8, chrome), box(0.06, 1.2, 0.07, front - 0.22, y(1.8), 0.8, chrome));
  out.push(box(0.08, 0.07, 1.7, front - 0.23, y(2.35), 0, chrome));
  for (const z of [-0.66, 0.66]) {
    out.push(box(0.08, 0.3, 0.42, front - 0.2, y(1.3), z, lit('#fff6c8'))); // headlights
    out.push(box(0.07, 0.12, 0.2, front - 0.2, y(1.04), z * 1.1, lit('#ffb43a'))); // indicators
  }
  const sign = plaque();
  sign.position.set(front - 0.17, y(2.2), 0);
  out.push(sign);
  // Fenders over the front wheels and the tandem.
  const frontAxle = preset.wheels.frontOffset;
  for (const z of [-1, 1]) {
    out.push(box(1.35, 0.1, 0.62, frontAxle, y(1.2), z * 1.0, paint));
    out.push(box(1.35, 0.3, 0.06, frontAxle, y(1.07), z * 1.32, paint));
    const tandem = (preset.wheels.rearOffset + (preset.wheels.extraRear?.[0] ?? preset.wheels.rearOffset)) / 2;
    out.push(box(2.6, 0.08, 0.66, tandem, y(1.22), z * 1.0, dark));
    out.push(box(0.04, 0.55, 0.62, -Lf / 2 + 0.05, y(0.62), z * 1.0, dark)); // mudflaps
  }

  // Cab.
  const cabFront = front - 2.17;
  const cabLen = 2.3;
  const cabX = cabFront - cabLen / 2;
  out.push(box(cabLen, 2.35, 2.5, cabX, y(2.375), 0, paint));
  out.push(box(cabLen * 0.96, 0.12, 2.44, cabX, y(3.6), 0, white)); // roof
  out.push(box(0.9, 0.5, 2.3, cabX - 0.55, y(3.9), 0, white)); // air deflector
  out.push(box(0.32, 0.07, 2.3, cabFront + 0.1, y(3.56), 0, white)); // sun visor
  out.push(box(cabLen + 0.02, 0.22, 2.52, cabX, y(2.0), 0, trim)); // stripe
  out.push(box(0.07, 0.95, 2.2, cabFront + 0.02, y(3.0), 0, glass)); // windshield
  for (const z of [-1, 1]) {
    out.push(box(1.45, 0.82, 0.07, cabX + 0.3, y(3.0), z * 1.26, glass)); // side windows
    out.push(box(0.04, 1.65, 0.05, cabX - 0.15, y(2.15), z * 1.27, dark)); // door seam
    out.push(box(0.14, 0.05, 0.05, cabX + 0.2, y(2.4), z * 1.29, chrome)); // handle
    out.push(box(0.5, 0.06, 0.28, cabX + 0.35, y(1.18), z * 1.37, dark)); // step
    out.push(box(0.08, 0.12, 0.08, cabFront + 0.04, y(3.64), z * 0.5, lit('#ffb43a'))); // marker lights
    // Mirrors on arms: the arm, the glass.
    out.push(box(0.05, 0.05, 0.4, cabFront - 0.1, y(3.1), z * 1.45, dark));
    out.push(box(0.07, 0.62, 0.2, cabFront - 0.1, y(3.0), z * 1.64, dark));
  }
  out.push(box(0.08, 0.12, 0.08, cabFront + 0.04, y(3.64), 0, lit('#ffb43a')));

  // Twin exhaust stacks and the fuel tanks.
  for (const [x, top, z] of truckStacks(preset)) {
    out.push(pipe(0.075, top - y(1.2), x, (top + y(1.2)) / 2, z, chrome));
    out.push(pipe(0.085, 0.14, x, top, z, dark));
  }
  for (const z of [-1, 1]) out.push(pipe(0.34, 1.5, cabX + 0.15, y(0.88), z * 1.0, chrome, 'x'));
  return out;
}

/** The container's livery, drawn to one canvas: the two sides, the doors and the front wall, corrugated. */
const ATLAS = { w: 2048, h: 1024, side: { x: 0, y: 0, w: 2048, h: 436 }, door: { x: 0, y: 512, w: 410, h: 436 }, front: { x: 512, y: 512, w: 410, h: 436 } };

function containerTexture(color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS.w;
  canvas.height = ATLAS.h;
  const ctx = canvas.getContext('2d')!;
  const panel = (r: { x: number; y: number; w: number; h: number }) => {
    ctx.fillStyle = color;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    // Corrugation: alternating light and dark ribs, every 16 px.
    for (let x = r.x; x < r.x + r.w; x += 16) {
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x, r.y, 5, r.h);
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fillRect(x + 9, r.y, 5, r.h);
    }
    // Weathering along the bottom.
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(r.x, r.y + r.h - 22, r.w, 22);
  };
  panel(ATLAS.side);
  panel(ATLAS.door);
  panel(ATLAS.front);

  // Doors: two leaves, locking bars and handles.
  const d = ATLAS.door;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(d.x + d.w / 2 - 3, d.y, 6, d.h);
  ctx.fillStyle = '#b9bdc2';
  for (const fx of [0.18, 0.34, 0.66, 0.82]) ctx.fillRect(d.x + d.w * fx - 5, d.y + 20, 10, d.h - 40);
  ctx.fillStyle = '#2b2d31';
  for (const fx of [0.34, 0.66]) ctx.fillRect(d.x + d.w * fx - 14, d.y + d.h * 0.5 - 8, 28, 16);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A quad with texture coordinates from the atlas rectangle `r`; corners bottom-left, bottom-right, top-right, top-left as seen from outside. */
function quad(pos: number[], r: { x: number; y: number; w: number; h: number }, out: { p: number[]; t: number[]; n: number[] }, normal: [number, number, number]): void {
  const c = [0, 1, 2, 3].map((i) => pos.slice(i * 3, i * 3 + 3));
  const uvs = [
    [(r.x) / ATLAS.w, 1 - (r.y + r.h) / ATLAS.h],
    [(r.x + r.w) / ATLAS.w, 1 - (r.y + r.h) / ATLAS.h],
    [(r.x + r.w) / ATLAS.w, 1 - r.y / ATLAS.h],
    [r.x / ATLAS.w, 1 - r.y / ATLAS.h],
  ];
  for (const i of [0, 1, 2, 0, 2, 3]) {
    out.p.push(...c[i]);
    out.t.push(...uvs[i]);
    out.n.push(...normal);
  }
}

/**
 * The semi-trailer, in the rear section's space: chassis rails, landing legs, the axle group's
 * fenders, underride bar and lights, a 40 ft shipping container on top (one textured mesh for the
 * sides, doors and front wall, rest plain), each end rail and corner casting.
 */
export function truckTrailer(preset: BusPreset): THREE.Object3D[] {
  const { Gt } = layout(preset);
  const art = preset.articulated!;
  const L = art.rearLength;
  const W = preset.body.width;
  const dark = flat(DARK);
  const chrome = flat(CHROME);
  const t = (h: number) => Gt + h;
  const out: THREE.Object3D[] = [];
  const boxColor = preset.body.stripe;

  // Chassis: two rails, crossmembers, the front kingpin plate, landing legs (raised for the road).
  for (const z of [-0.62, 0.62]) out.push(box(L - 0.2, 0.3, 0.16, -0.05, t(1.2), z, dark));
  for (let x = -L / 2 + 0.6; x < L / 2 - 0.3; x += 1.25) out.push(box(0.1, 0.12, 1.5, x, t(1.28), 0, dark));
  out.push(box(1.6, 0.1, 2.0, L / 2 - 0.9, t(1.34), 0, dark));
  for (const z of [-1, 1]) {
    out.push(box(0.14, 0.9, 0.14, L / 2 - 2.4, t(0.85), z * 1.02, dark));
    out.push(box(0.4, 0.06, 0.3, L / 2 - 2.4, t(0.4), z * 1.02, dark));
  }
  out.push(box(0.1, 0.1, 2.0, L / 2 - 2.4, t(0.95), 0, dark));

  // Axle group: beams under the nominal wheel centers, fenders, mudflaps, underride bar, lights.
  const axles = [art.rearAxle, ...(art.rearAxles ?? [])];
  for (const x of axles) out.push(box(0.16, 0.16, 2.2, x, t(0.62), 0, dark));
  const mid = (Math.min(...axles) + Math.max(...axles)) / 2;
  const span = Math.max(...axles) - Math.min(...axles) + 1.7;
  out.push(box(span + 0.3, 0.14, 1.5, mid, t(1.0), 0, dark)); // subframe
  for (const z of [-1, 1]) {
    out.push(box(span, 0.07, 0.64, mid, t(1.2), z * 1.0, dark));
    out.push(box(0.04, 0.6, 0.6, Math.min(...axles) - 0.9, t(0.7), z * 1.0, dark));
    out.push(box(0.06, 0.3, 0.42, -L / 2 - 0.02, t(1.12), z * 1.0, lit('#d42020'))); // tail lights
    out.push(box(0.06, 0.12, 0.2, -L / 2 - 0.02, t(1.45), z * 1.0, lit('#ffb43a')));
    for (const x of [L / 2 - 1.5, 0.5, -L / 2 + 1.5]) out.push(box(0.2, 0.07, 0.07, x, t(1.3), z * 1.2, lit('#ffb43a'))); // side markers
  }
  out.push(box(0.14, 0.3, W * 0.92, -L / 2 - 0.08, t(0.76), 0, chrome)); // underride bar
  out.push(box(0.02, 0.15, 0.45, -L / 2 - 0.02, t(0.95), 0, flat('#f2efe6'))); // plate

  // The container: 12.19 x 2.44 x 2.59 m on the rails, one textured mesh for its four walls.
  const cl = 12.19;
  const cw = 2.44;
  const ch = 2.59;
  const base = t(1.42);
  const cx = -0.04;
  out.push(box(cl - 0.04, ch - 0.04, cw - 0.04, cx, base + ch / 2, 0, flat(boxColor))); // the core: roof and floor
  const trimMat = flat(new THREE.Color(boxColor).multiplyScalar(0.6));
  for (const y of [base + 0.04, base + ch - 0.04]) for (const z of [-cw / 2, cw / 2]) out.push(box(cl + 0.02, 0.1, 0.1, cx, y, z, trimMat));
  for (const x of [cx - cl / 2, cx + cl / 2]) for (const y of [base + 0.04, base + ch - 0.04]) out.push(box(0.1, 0.1, cw + 0.02, x, y, 0, trimMat));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [base + 0.06, base + ch - 0.06]) out.push(box(0.2, 0.16, 0.2, cx + (sx * cl) / 2, y, (sz * cw) / 2, dark));
  const g = { p: [] as number[], t: [] as number[], n: [] as number[] };
  const o = 0.012;
  const x0 = cx - cl / 2;
  const x1 = cx + cl / 2;
  const [y0, y1] = [base, base + ch];
  const hz = cw / 2;
  // Both sides read left to right as seen from outside (so on the left one from front to back), like every box.
  quad([x0, y0, hz + o, x1, y0, hz + o, x1, y1, hz + o, x0, y1, hz + o], ATLAS.side, g, [0, 0, 1]);
  quad([x1, y0, -hz - o, x0, y0, -hz - o, x0, y1, -hz - o, x1, y1, -hz - o], ATLAS.side, g, [0, 0, -1]);
  quad([x0 - o, y0, -hz, x0 - o, y0, hz, x0 - o, y1, hz, x0 - o, y1, -hz], ATLAS.door, g, [-1, 0, 0]);
  quad([x1 + o, y0, hz, x1 + o, y0, -hz, x1 + o, y1, -hz, x1 + o, y1, hz], ATLAS.front, g, [1, 0, 0]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.t, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.n, 3));
  const walls = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: containerTexture(boxColor) }));
  out.push(walls);
  return out;
}

/**
 * The cab seen from the driver's seat: dashboard, doors closed up to the window sills, pillars and
 * roof, the hood ahead (front-section space). The view widens at speed, so any gap would show
 * the road: the cabin is shut all round below the windows and the pillars reach the roof.
 */
export function truckCockpit(preset: BusPreset): { parts: THREE.Object3D[]; wheelMount: THREE.Group } {
  const { G, Lf, W } = layout(preset);
  const { color } = preset.body;
  const paint = flat(color);
  const dark = flat('#2a2a2c');
  const trim = flat('#3a3d42');
  const y = (h: number) => G + h;
  const front = Lf / 2;
  const cabFront = front - 2.17;
  const cabLen = 2.3;
  const back = cabFront - cabLen;
  const floor = y(1.3);
  const sill = y(2.55);
  const roofY = y(3.55);
  const parts: THREE.Object3D[] = [];
  const part = (w: number, h: number, d: number, x: number, yy: number, z: number, mat: THREE.Material) => parts.push(box(w, h, d, x, yy, z, mat));

  // The hood ahead, its lights and the mirrors out the side windows.
  part(2.15, 0.9, 1.66, front - 1.15, y(1.8), 0, paint);
  part(0.1, 1.1, 1.62, front - 0.28, y(1.8), 0, flat(DARK));
  for (const z of [-1, 1]) {
    part(0.07, 0.62, 0.2, cabFront - 0.1, y(3.0), z * 1.64, flat(DARK));
    part(0.05, 0.05, 0.4, cabFront - 0.1, y(3.1), z * 1.45, flat(DARK));
  }
  // Cabin: dash, floor, doors up to the sills, rear wall, pillars, header, ceiling.
  part(0.7, 0.55, W * 0.9, cabFront - 0.4, y(2.35), 0, dark); // dashboard
  part(0.1, sill - floor, W, cabFront - 0.03, (sill + floor) / 2, 0, trim); // under the windshield
  part(cabLen, 0.06, W, cabFront - cabLen / 2, floor, 0, trim); // floor
  part(cabLen, 0.1, W, cabFront - cabLen / 2, roofY + 0.05, 0, new THREE.MeshBasicMaterial({ color: '#bfc3c7' })); // ceiling
  part(0.1, roofY + 0.1 - sill, W, back + 0.05, (roofY + 0.1 + sill) / 2, 0, paint); // back wall, floor to ceiling
  part(0.1, sill - floor, W, back + 0.05, (sill + floor) / 2, 0, trim);
  part(0.2, roofY + 0.1 - y(3.5), W, cabFront - 0.1, (roofY + 0.1 + y(3.5)) / 2, 0, paint); // header over the windshield
  for (const z of [-W / 2 + 0.06, W / 2 - 0.06]) {
    part(cabLen, sill - floor, 0.12, cabFront - cabLen / 2, (sill + floor) / 2, z, paint); // door, under the window
    part(0.16, roofY + 0.1 - floor, 0.12, cabFront - 0.1, (roofY + 0.1 + floor) / 2, z, paint); // A pillar
    part(0.16, roofY + 0.1 - sill, 0.12, back + 0.1, (roofY + 0.1 + sill) / 2, z, paint); // B pillar
    part(cabLen, 0.14, 0.12, cabFront - cabLen / 2, roofY + 0.04, z, paint); // roof rail
  }
  const wheelMount = new THREE.Group();
  wheelMount.position.set(cabFront - 0.75, y(2.62), -0.62);
  wheelMount.rotation.set(0, Math.PI / 2, -0.75, 'ZYX');
  return { parts, wheelMount };
}
