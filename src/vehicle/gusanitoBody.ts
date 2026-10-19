import * as THREE from 'three';
import type { BusPreset } from './busPreset';

const flat = (color: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color, flatShading: true });
const lit = (color: THREE.ColorRepresentation) => new THREE.MeshBasicMaterial({ color });
const GLASS = '#1c2a38';
/** Canopy stripes, wagon after wagon: the circus-tent roofs of the photos. */
const CANOPY = ['#ff5fae', '#ffd21f', '#3fc4ff', '#8fdc2c', '#ff8a2a', '#b06cff'];
/** Paint of the wagons' sides, alternating like the segments of a worm. */
const SEGMENT = ['#8fdc2c', '#5fd06a'];
/** The LED strips along the canopy edges (unshaded: they glow at night). */
const LED = ['#3fffe0', '#ff4fd8', '#fff04a'];
const SKIN = ['#f1c27d', '#c68642', '#8d5524', '#e0ac69'];
const SHIRT = ['#e53935', '#1e88e5', '#fdd835', '#43a047', '#ffffff', '#8e24aa', '#fb8c00'];

function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function ball(r: number, x: number, y: number, z: number, mat: THREE.Material, detail = 1): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), mat);
  m.position.set(x, y, z);
  return m;
}

/** A rounded tub (a squashed capsule along x): the worm's segments. */
function tub(length: number, height: number, width: number, mat: THREE.Material): THREE.Mesh {
  const r = height / 2;
  const geo = new THREE.CapsuleGeometry(r, Math.max(0.01, length - 2 * r), 4, 12);
  geo.rotateZ(Math.PI / 2);
  geo.scale(1, 1, width / height);
  return new THREE.Mesh(geo, mat);
}

/** Heights shared by the head and the wagons, from the preset's box (centered on its origin). */
function levels(preset: BusPreset) {
  const { height: H, width: W } = preset.body;
  const floor = -H / 2 + 0.05;
  return { H, W, floor, belt: floor + 0.95, top: H / 2 };
}

/**
 * Striped canopy on four posts, a scalloped fringe and LED strips round its edge (a fringed
 * circus roof, as on the photos), `L` long, its top at `top`.
 */
function canopy(L: number, W: number, from: number, top: number, color: string, led: string): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.62, W * 0.62, L, 12, 1, false, 0, Math.PI), flat(color));
  roof.rotation.z = Math.PI / 2;
  roof.scale.set(0.32, 1, 1);
  roof.position.set(0, top - W * 0.62 * 0.32, 0);
  // The flat underside (the half-cylinder's cut face) closes it from below.
  const under = box(L, 0.04, W * 1.24, 0, top - W * 0.2, 0, flat('#fff6e0'));
  under.position.y = roof.position.y;
  out.push(roof, under);
  // White stripes across, between the colored ones.
  for (let x = -L / 2 + L / 8; x < L / 2; x += L / 4) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.625, W * 0.625, L / 10, 12, 1, false, 0, Math.PI), flat('#fff6e0'));
    s.rotation.z = Math.PI / 2;
    s.scale.set(0.32, 1, 1);
    s.position.set(x, roof.position.y, 0);
    out.push(s);
  }
  const fringeMat = flat('#ffe14a');
  const y = roof.position.y - 0.08;
  for (const z of [-W * 0.62, W * 0.62]) {
    for (let x = -L / 2 + 0.15; x < L / 2; x += 0.3) out.push(ball(0.09, x, y, z, fringeMat, 0));
    out.push(box(L, 0.03, 0.03, 0, y + 0.06, z * 1.01, lit(led)));
  }
  for (const x of [-L / 2, L / 2]) out.push(box(0.03, 0.03, W * 1.24, x * 1.005, y + 0.06, 0, lit(led)));
  // Posts: white tubes from the tub's rim up to the canopy.
  const post = flat('#f4f4f4');
  for (const px of [-L / 2 + 0.12, L / 2 - 0.12])
    for (const z of [-W / 2 + 0.08, W / 2 - 0.08]) {
      const h = y - from;
      out.push(box(0.07, h, 0.07, px, from + h / 2, z, post));
    }
  return out;
}

/**
 * The gusanito's head: a round green car with a worm's face (big lashed eyes on the hood, a
 * red nose, wide red lips round the bumper), two antennae with balls on top, a windshield and a
 * striped canopy over the driver. In chassis space (+X forward), `L` = the front section.
 */
export function gusanitoHead(preset: BusPreset, L: number): THREE.Object3D[] {
  const { W, floor, belt, top } = levels(preset);
  const { color, stripe } = preset.body;
  const paint = flat(color);
  const out: THREE.Object3D[] = [];
  const x1 = L / 2;
  // Body: a long round tub, with a bulging hood (the worm's head) in front of the windshield.
  const body = tub(L, belt - floor, W, paint);
  body.position.set(0, (floor + belt) / 2, 0);
  const hood = tub(1.9, 1.0, W * 0.92, paint);
  hood.position.set(x1 - 1.0, belt - 0.25, 0);
  out.push(body, hood);
  // Yellow belt stripe and a blue sill, the cartoon livery.
  out.push(box(L * 0.84, 0.1, W + 0.02, -0.1, floor + 0.62, 0, flat(stripe)));
  out.push(box(L * 0.8, 0.12, W + 0.03, -0.1, floor + 0.18, 0, flat('#2f7dff')));
  // Face, on the front of the hood: eyes, lashes, nose and lips.
  const white = flat('#ffffff');
  const iris = flat('#2f62ff');
  const black = flat('#151515');
  for (const s of [-1, 1]) {
    const z = s * W * 0.24;
    const eye = ball(0.34, x1 - 0.62, belt + 0.24, z, white);
    eye.scale.set(0.7, 1, 1);
    const face: THREE.Object3D[] = [eye, ball(0.18, x1 - 0.43, belt + 0.2, z, iris), ball(0.08, x1 - 0.3, belt + 0.2, z, black)];
    // Eyelid (pink) and three lashes over it.
    const lid = ball(0.35, x1 - 0.66, belt + 0.33, z, flat('#ff6fb8'));
    lid.scale.set(0.72, 0.55, 1.02);
    face.push(lid);
    for (const k of [-1, 0, 1]) {
      const lash = box(0.035, 0.24, 0.035, x1 - 0.56, belt + 0.62, z + k * 0.16, black);
      lash.rotation.x = -k * 0.45;
      face.push(lash);
    }
    for (const o of face) o.name = 'eye';
    out.push(...face);
  }
  const red = flat('#e8262b');
  out.push(ball(0.2, x1 - 0.12, belt - 0.32, 0, red));
  // Lips: a thick red ring, flattened, round the front bumper, with the mouth dark inside.
  const lips = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.11, 6, 16), red);
  lips.rotation.y = Math.PI / 2;
  lips.scale.set(1, 0.42, 1.55);
  lips.position.set(x1 + 0.02, floor + 0.38, 0);
  const mouth = box(0.05, 0.18, 1.15, x1 - 0.02, floor + 0.38, 0, flat('#7a0d1e'));
  out.push(lips, mouth);
  // Headlights in the cheeks.
  for (const s of [-1, 1]) out.push(box(0.06, 0.16, 0.2, x1 - 0.08, floor + 0.62, s * W * 0.4, lit('#fff6c8')));
  // Antennae: purple stalks leaning forward out of the hood, a ball on each.
  const stalk = flat('#9b5cff');
  for (const s of [-1, 1]) {
    const a = box(0.06, 0.9, 0.06, x1 - 0.95, belt + 0.62, s * W * 0.3, stalk);
    a.rotation.set(s * 0.25, 0, -0.35);
    out.push(a, ball(0.12, x1 - 0.77, belt + 1.06, s * W * 0.36, flat('#ff3fa0')));
  }
  // Windshield on a frame, and the canopy over the driver's seat behind it.
  const wsX = x1 - 2.05;
  const glass = box(0.05, top - 0.35 - belt, W * 0.84, wsX, (top - 0.35 + belt) / 2, 0, flat(GLASS));
  glass.name = 'windshield';
  out.push(glass);
  out.push(box(0.08, 0.08, W * 0.86, wsX, belt + 0.02, 0, flat('#f4f4f4')));
  const cLen = L - 1.7;
  const c = canopy(cLen, W, belt, top, CANOPY[0], LED[0]);
  for (const o of c) o.position.x += -L / 2 + cLen / 2 + 0.05;
  out.push(...c);
  // Driver's seat back and the tail of the head car (a coupling plate).
  out.push(box(0.15, 0.7, W * 0.4, -1.15, belt + 0.1, -W * 0.22, flat('#c62828')));
  out.push(box(0.3, 0.12, 0.3, -L / 2 - 0.1, floor + 0.15, 0, flat('#333')));
  return out;
}

/**
 * One wagon: an open green tub with benches and riders, painted stripes, a drawbar to the
 * section ahead, and a striped canopy. The last one has the worm's tail (a spiral of rings with
 * a smiley in the middle) and tail lamps. `i` = which wagon (0 = right behind the head).
 */
export function gusanitoWagon(preset: BusPreset, i: number, last: boolean, gap: number): THREE.Object3D[] {
  const { W, floor, belt, top } = levels(preset);
  const L = preset.articulated!.rearLength;
  const out: THREE.Object3D[] = [];
  const paint = flat(SEGMENT[i % 2]);
  const body = tub(L, belt - floor, W, paint);
  body.position.set(0, (floor + belt) / 2, 0);
  out.push(body);
  out.push(box(L * 0.8, 0.1, W + 0.02, 0, floor + 0.62, 0, flat(preset.body.stripe)));
  out.push(box(L * 0.75, 0.12, W + 0.03, 0, floor + 0.18, 0, flat('#2f7dff')));
  // The open tub's dark inside and two benches with a back each, riders on them.
  out.push(box(L * 0.8, 0.04, W * 0.86, 0, belt + 0.005, 0, flat('#3a2a1e')));
  const seat = flat('#c62828');
  for (const [k, x] of [-L * 0.2, L * 0.22].entries()) {
    out.push(box(0.12, 0.45, W * 0.8, x - 0.35, belt + 0.2, 0, seat));
    for (const z of [-W * 0.22, W * 0.22]) {
      const h = (i * 7 + k * 3 + (z > 0 ? 1 : 0)) % 7;
      out.push(box(0.3, 0.42, 0.34, x - 0.12, belt + 0.21, z, flat(SHIRT[h])));
      out.push(ball(0.13, x - 0.1, belt + 0.55, z, flat(SKIN[h % SKIN.length])));
    }
  }
  out.push(...canopy(L - 0.1, W, belt, top, CANOPY[(i + 1) % CANOPY.length], LED[(i + 1) % LED.length]));
  // Drawbar forward through the gap to the section ahead.
  out.push(box(gap + 0.4, 0.08, 0.12, L / 2 + gap / 2, floor + 0.15, 0, flat('#333')));
  if (last) {
    // The tail: concentric rings, a smiley in the middle.
    const rings = ['#ff8a2a', '#3fc4ff', '#ff5fae', '#8fdc2c', '#ffd21f'];
    rings.forEach((c, k) => {
      const r = 0.62 - k * 0.12;
      const d = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.04, 16), flat(c));
      d.rotation.z = Math.PI / 2;
      d.position.set(-L / 2 - 0.02 - k * 0.012, (floor + belt) / 2 + 0.05, 0);
      out.push(d);
    });
    const face = -L / 2 - 0.09;
    for (const s of [-1, 1]) out.push(box(0.02, 0.06, 0.05, face, (floor + belt) / 2 + 0.12, s * 0.08, flat('#151515')));
    // A smile: a flat middle and two corners turned up.
    const mid = (floor + belt) / 2;
    out.push(box(0.02, 0.04, 0.12, face, mid - 0.05, 0, flat('#151515')));
    for (const s of [-1, 1]) {
      const corner = box(0.02, 0.04, 0.08, face, mid - 0.025, s * 0.085, flat('#151515'));
      corner.rotation.x = s * 0.6;
      out.push(corner);
    }
    for (const s of [-1, 1]) out.push(box(0.05, 0.14, 0.14, -L / 2 + 0.05, floor + 0.45, s * W * 0.44, lit('#d42020')));
  }
  return out;
}

/**
 * The driver's view: the hood with the worm's eyes ahead, dashboard, the canopy's posts and
 * edge overhead, the sides closed below the belt. Steering wheel returned separately (it turns).
 */
export function gusanitoCockpit(preset: BusPreset, L: number): { parts: THREE.Object3D[]; wheelMount: THREE.Group } {
  const { W, floor, belt, top } = levels(preset);
  const x1 = L / 2;
  // The head's own parts ahead of the seat (hood, antennae) and the canopy overhead; the
  // windshield (the glass is opaque) and the eyes (their backs fill the middle of the view) are left out.
  const parts = gusanitoHead(preset, L).filter((o) => o.name !== 'windshield' && o.name !== 'eye' && (o.position.x > x1 - 2.2 || o.position.y > top - 0.4));
  const trim = flat('#2f2f31');
  const wsX = x1 - 2.05;
  parts.push(box(0.5, 0.25, W * 0.86, wsX - 0.25, belt + 0.05, 0, flat('#2a2a2a'))); // dashboard
  parts.push(box(0.06, belt - floor, W * 0.9, wsX, (belt + floor) / 2, 0, trim)); // under the dash
  for (const s of [-1, 1]) parts.push(box(2.6, belt + 0.12 - floor, 0.05, wsX - 1.3, (belt + 0.12 + floor) / 2, s * (W / 2 - 0.05), trim)); // sides
  parts.push(box(2.6, 0.04, W * 0.9, wsX - 1.3, floor + 0.1, 0, trim)); // floor
  const wheelMount = new THREE.Group();
  wheelMount.position.set(wsX - 0.5, belt + 0.18, -W * 0.22);
  // Face the driver, then rake back (ZYX: see busModel's wheel mount).
  wheelMount.rotation.set(0, Math.PI / 2, -0.6, 'ZYX');
  return { parts, wheelMount };
}
