import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import type { BusPreset } from './busPreset';

const flat = (color: THREE.ColorRepresentation) => new THREE.MeshLambertMaterial({ color, flatShading: true });
const lit = (color: THREE.ColorRepresentation) => new THREE.MeshBasicMaterial({ color });
const GLASS = '#1c2a38';

/** A convex solid from [x, y, z] points (chassis space: +X forward, +Z right). */
function hull(points: [number, number, number][], mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new ConvexGeometry(points.map(([x, y, z]) => new THREE.Vector3(x, y, z))), mat);
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/**
 * Toyota Sprinter Trueno AE86, low-poly, in the "panda" livery (white over black): wedge nose
 * with its pop-up headlights down, three-door hatchback glasshouse, full-width black tail
 * panel. Sized from the preset's body (4.2 × 1.66 × 1.34 m); origin at the body's center.
 */
export function carExterior(preset: BusPreset): THREE.Object3D[] {
  const { length: L, width: W, height: H, color, stripe } = preset.body;
  const x0 = -L / 2;
  const x1 = L / 2;
  const w = W / 2;
  const floor = -H / 2 + 0.05;
  const belt = floor + H * 0.47;
  const paint = flat(color);
  const black = flat(stripe);

  // Lower body: a wedge, low at the nose, rising to the belt line at the windshield.
  const lower = hull(
    [
      [x1, floor + 0.08, -w * 0.94], [x1, floor + 0.08, w * 0.94],
      [x1 - 0.05, belt - 0.16, -w * 0.9], [x1 - 0.05, belt - 0.16, w * 0.9],
      [x1 - 1.25, belt, -w], [x1 - 1.25, belt, w],
      [x0 + 0.05, belt, -w], [x0 + 0.05, belt, w],
      [x0, floor + 0.08, -w * 0.97], [x0, floor + 0.08, w * 0.97],
      [x0 + 0.3, floor, -w], [x0 + 0.3, floor, w], [x1 - 0.3, floor, -w], [x1 - 0.3, floor, w],
    ],
    paint,
  );
  // Black lower half (the panda): sills and bumpers, a little proud of the paint.
  const skirtH = (belt - floor) * 0.45;
  const skirt = box(L - 0.55, skirtH, W + 0.03, 0, floor + skirtH / 2, 0, black);
  const bumperF = box(0.16, skirtH + 0.04, W * 0.98, x1 - 0.02, floor + skirtH / 2 + 0.02, 0, black);
  const bumperR = box(0.16, skirtH + 0.04, W * 0.99, x0 + 0.02, floor + skirtH / 2 + 0.02, 0, black);

  // Glasshouse: windshield from the hood, flat roof, long sloping hatch to the tail.
  const top = H / 2;
  const cabin = hull(
    [
      [x1 - 1.25, belt, -w * 0.93], [x1 - 1.25, belt, w * 0.93],
      [x1 - 2.05, top, -w * 0.8], [x1 - 2.05, top, w * 0.8],
      [x0 + 1.15, top, -w * 0.8], [x0 + 1.15, top, w * 0.8],
      [x0 + 0.12, belt + 0.02, -w * 0.93], [x0 + 0.12, belt + 0.02, w * 0.93],
    ],
    flat(GLASS),
  );
  // White roof panel and pillars over the glass.
  const roofPanel = hull(
    [
      [x1 - 2.1, top + 0.01, -w * 0.78], [x1 - 2.1, top + 0.01, w * 0.78],
      [x0 + 1.2, top + 0.01, -w * 0.78], [x0 + 1.2, top + 0.01, w * 0.78],
      [x1 - 2.1, top - 0.05, -w * 0.82], [x1 - 2.1, top - 0.05, w * 0.82],
      [x0 + 1.2, top - 0.05, -w * 0.82], [x0 + 1.2, top - 0.05, w * 0.82],
    ],
    paint,
  );
  const parts: THREE.Object3D[] = [lower, skirt, bumperF, bumperR, cabin, roofPanel];
  for (const s of [-1, 1]) {
    // B-pillar, and the chrome-less black trim strip along the belt.
    parts.push(box(0.12, top - belt, 0.04, x1 - 2.25, (top + belt) / 2, s * w * 0.87, paint));
    parts.push(box(L - 0.6, 0.05, 0.03, -0.05, belt - 0.02, s * (w + 0.005), black));
    // Pop-up headlights, closed: two dark lids at the front of the hood.
    parts.push(box(0.26, 0.02, 0.36, x1 - 0.2, belt - 0.14, s * w * 0.6, black));
    // Amber indicators in the bumper corners, wide red tail lamps in the black tail panel.
    parts.push(box(0.04, 0.07, 0.22, x1 + 0.07, floor + skirtH * 0.7, s * w * 0.72, lit('#ff9d2e')));
    parts.push(box(0.04, 0.12, 0.42, x0 - 0.01, belt - 0.13, s * w * 0.62, lit('#d42020')));
    // Mirror on each door.
    parts.push(box(0.1, 0.08, 0.14, x1 - 1.35, belt + 0.12, s * (w + 0.07), black));
  }
  // Tail panel between the lamps, and the black grille slit under the nose.
  parts.push(box(0.03, 0.14, W * 0.5, x0 - 0.005, belt - 0.13, 0, black));
  parts.push(box(0.03, 0.05, W * 0.55, x1 + 0.01, belt - 0.2, 0, black));
  return parts;
}

/**
 * What the driver sees from the seat: dashboard, the white hood through the windshield, the
 * A-pillars and the roof edge. Steering wheel is returned separately (it turns).
 */
export function carCockpit(preset: BusPreset): { parts: THREE.Object3D[]; wheelMount: THREE.Group } {
  const { length: L, width: W, height: H, color } = preset.body;
  const x1 = L / 2;
  const w = W / 2;
  const floor = -H / 2 + 0.05;
  const belt = floor + H * 0.47;
  const paint = flat(color);
  const parts: THREE.Object3D[] = [];
  // Hood, seen over the dash.
  parts.push(
    hull(
      [
        [x1 - 0.05, belt - 0.16, -w * 0.9], [x1 - 0.05, belt - 0.16, w * 0.9],
        [x1 - 1.25, belt, -w], [x1 - 1.25, belt, w],
        [x1 - 0.05, belt - 0.3, -w * 0.9], [x1 - 1.25, belt - 0.3, w],
      ],
      paint,
    ),
  );
  parts.push(box(0.45, 0.16, W * 0.92, x1 - 1.45, belt - 0.02, 0, flat('#2a2a2a'))); // dashboard, low enough to see the hood
  const top = H / 2;
  // Headliner: from the top of the windshield back, so it only frames the view.
  parts.push(box(1.4, 0.05, W * 0.9, x1 - 2.75, top - 0.04, 0, lit('#c9c9c2')));
  for (const s of [-1, 1]) {
    // A-pillars along the windshield's sides, from its base up to the roof.
    const [bx, by, tx, ty] = [x1 - 1.25, belt, x1 - 2.05, top];
    const pillar = box(0.05, Math.hypot(tx - bx, ty - by), 0.05, (bx + tx) / 2, (by + ty) / 2, s * w * 0.86, paint);
    pillar.rotation.z = Math.atan2(bx - tx, ty - by);
    parts.push(pillar);
    parts.push(box(1.6, 0.14, 0.06, x1 - 2.2, belt - 0.02, s * w * 0.95, paint)); // door tops
  }
  const wheelMount = new THREE.Group();
  wheelMount.position.set(x1 - 1.66, belt + 0.02, -w * 0.43);
  wheelMount.rotation.z = -0.35;
  wheelMount.rotation.y = Math.PI / 2;
  return { parts, wheelMount };
}
