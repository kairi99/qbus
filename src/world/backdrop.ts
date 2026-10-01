import * as THREE from 'three';
import type { CityData, Horizon, Landmark } from './cityData';
import { buildMountains } from './mountains';
import { SKY_HORIZON, skyDome } from './sky';

/**
 * The Virgen is drawn this many times life size (≈45 m with her base): from La Mariscal, 4 km
 * away, true size is a speck; this keeps her readable on the skyline like she feels in person.
 */
const VIRGEN_SCALE = 3.5;
const HAZE = SKY_HORIZON;

/**
 * Everything far away, drawn in its own pass before the city with its own long-range camera
 * (so the city keeps its fog and depth precision): the sky, and either the real terrain around
 * an imported city with its landmarks, or a made-up mountain ring around a generated one.
 */
export function buildBackdrop(city: CityData, cityRadius: number): THREE.Scene {
  const scene = new THREE.Scene();
  // Linear haze that starts "behind" the camera: even the nearest hills are a little hazy.
  scene.fog = new THREE.Fog(HAZE, -8000, 80000);
  scene.add(skyDome());
  scene.add(new THREE.HemisphereLight('#cfe6ff', '#6b7a4a', 1.4));
  const sun = new THREE.DirectionalLight('#fff3dc', 2.2);
  sun.position.set(60, 110, 40);
  scene.add(sun);

  const scale = city.terrain?.scale ?? 1;
  if (city.horizon) {
    scene.add(horizonMesh(city.horizon, scale));
    for (const l of city.landmarks ?? []) scene.add(l.kind === 'virgen' ? virgen(l, scale) : volcano(l, scale));
  } else scene.add(buildMountains(cityRadius));
  return scene;
}

/** Ground color by height above the city (true meters): city, green hills, páramo, rock. */
const BANDS: [number, THREE.Color][] = [
  [0, new THREE.Color('#bdb5a4')],
  [260, new THREE.Color('#b3ab96')],
  [650, new THREE.Color('#86a06c')],
  [1200, new THREE.Color('#6d8858')],
  [1550, new THREE.Color('#a69d77')],
  [1850, new THREE.Color('#8d877a')],
];

function bandColor(h: number, out: THREE.Color): THREE.Color {
  if (h <= BANDS[0][0]) return out.copy(BANDS[0][1]);
  for (let i = 1; i < BANDS.length; i++) {
    if (h <= BANDS[i][0]) return out.copy(BANDS[i - 1][1]).lerp(BANDS[i][1], (h - BANDS[i - 1][0]) / (BANDS[i][0] - BANDS[i - 1][0]));
  }
  return out.copy(BANDS[BANDS.length - 1][1]);
}

/**
 * The far terrain as one low-poly grid. Low ground near the city fades into the same haze as
 * the city's own fog, so the two meet without a seam; hills stand clear of it.
 */
function horizonMesh(h: Horizon, scale: number): THREE.Mesh {
  const pos = new Float32Array(h.cols * h.rows * 3);
  const col = new Float32Array(h.cols * h.rows * 3);
  const c = new THREE.Color();
  for (let r = 0; r < h.rows; r++)
    for (let k = 0; k < h.cols; k++) {
      const i = r * h.cols + k;
      const x = h.minX + k * h.cell;
      const z = h.minZ + r * h.cell;
      const y = h.heights[i];
      pos.set([x, y * scale - 2, z], i * 3);
      // A little variation so the city floor doesn't read as a flat sheet.
      const n = Math.sin(x * 0.013 + z * 0.021) * Math.sin(x * 0.007 - z * 0.017);
      bandColor(y, c).multiplyScalar(1 + n * 0.08);
      // Haze lies over the low city near the zone (matching the city's own fog); hills rising
      // out of it, like El Panecillo, stay clear.
      const near = Math.max(0, Math.min(1, 1 - (Math.hypot(x, z) - 1400) / 2200));
      const low = Math.max(0, Math.min(1, 1 - (y - 60) / 160));
      c.lerp(HAZE, 0.85 * near * low);
      col.set([c.r, c.g, c.b], i * 3);
    }
  const index: number[] = [];
  for (let r = 0; r < h.rows - 1; r++)
    for (let k = 0; k < h.cols - 1; k++) {
      const a = r * h.cols + k;
      index.push(a, a + h.cols, a + 1, a + 1, a + h.cols, a + h.cols + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

/**
 * La Virgen de El Panecillo, low-poly: stone base, globe, flared robe, torso, head with a
 * crown of stars, and the big wings. She faces north, over the city.
 */
function virgen(l: Landmark, scale: number): THREE.Group {
  const g = new THREE.Group();
  // Polished aluminum: a little self-lit so she shines against the sky from any side.
  const metal = new THREE.MeshLambertMaterial({ color: '#e4e8ee', emissive: '#7d8490', flatShading: true });
  const stone = new THREE.MeshLambertMaterial({ color: '#cfcac0', flatShading: true });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    g.add(m);
  };
  // Base: a stepped octagonal building on the summit, reaching down into the hill.
  add(new THREE.CylinderGeometry(6.5, 8, 14, 8), stone, 0, -3, 0);
  add(new THREE.CylinderGeometry(4.5, 5.5, 6, 8), stone, 0, 7, 0);
  add(new THREE.IcosahedronGeometry(3.6, 1), metal, 0, 13, 0); // the globe
  add(new THREE.CylinderGeometry(1.3, 3.4, 13, 10), metal, 0, 22.5, 0); // robe
  add(new THREE.CylinderGeometry(1.0, 1.35, 5, 8), metal, 0, 31.5, 0); // torso
  add(new THREE.IcosahedronGeometry(1.25, 1), metal, 0, 35, 0); // head
  add(new THREE.TorusGeometry(1.7, 0.2, 5, 12), metal, 0, 36.2, 0.4, Math.PI / 2 - 0.3); // crown of stars
  for (const side of [-1, 1]) {
    // Wings: tall and swept back and out from the shoulders.
    add(new THREE.BoxGeometry(9, 3.4, 0.35), metal, side * 4.5, 33, 1.6, 0, side * -0.35, side * 0.55);
    add(new THREE.BoxGeometry(6, 2.2, 0.3), metal, side * 3.6, 30, 1.9, 0, side * -0.3, side * 0.9);
    add(new THREE.BoxGeometry(0.7, 5, 0.7), metal, side * 1.4, 30.5, -0.4, 0.3, 0, side * 0.25); // arms
  }
  g.scale.setScalar(VIRGEN_SCALE);
  g.position.set(l.pos.x, l.y * scale, l.pos.z);
  return g;
}

/** A snow-capped volcano far on the skyline, at its real bearing and height. */
function volcano(l: Landmark, scale: number): THREE.Group {
  const g = new THREE.Group();
  // From a base well below the valley floor (hidden by the hills) up to the summit.
  const base = -600;
  const height = l.y * scale - base;
  const radius = height * 2.4;
  const rock = new THREE.Mesh(new THREE.ConeGeometry(radius, height, 9, 1), new THREE.MeshLambertMaterial({ color: '#7d8a86', flatShading: true }));
  rock.position.y = base + height / 2;
  const capH = height * 0.3;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.3 * 1.02, capH, 9, 1), new THREE.MeshLambertMaterial({ color: '#f4f6f8', flatShading: true }));
  cap.position.y = base + height - capH / 2 + 1;
  g.add(rock, cap);
  g.position.set(l.pos.x, 0, l.pos.z);
  return g;
}
