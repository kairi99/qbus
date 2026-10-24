import * as THREE from 'three';
import { biomeOf } from './biomes';
import type { CityData, Horizon, Landmark } from './cityData';
import { buildMountains } from './mountains';
import { type Puff, MIST_LOOK, mistMesh } from './mist';
import { LIGHTING, type TimeOfDay, skyDome } from './sky';
import { type TrackData, onMountain } from './track';

/**
 * The Virgen is drawn this many times life size (≈45 m with her base): from La Mariscal, 4 km
 * away, true size is a speck; this keeps her readable on the skyline like she feels in person.
 */
const VIRGEN_SCALE = 3.5;

/**
 * Everything far away, drawn in its own pass before the city with its own long-range camera
 * (so the city keeps its fog and depth precision): the sky, and either the real terrain around
 * an imported city with its landmarks, or a made-up mountain ring around a generated one.
 */
export function buildBackdrop(city: CityData, cityRadius: number, tod: TimeOfDay = 'day'): THREE.Scene {
  const light = LIGHTING[tod];
  const scene = new THREE.Scene();
  // Linear haze that starts "behind" the camera: even the nearest hills are a little hazy.
  scene.fog = new THREE.Fog(light.horizon, -8000, 80000);
  scene.add(skyDome(tod));
  scene.add(new THREE.HemisphereLight(light.hemiSky, light.hemiGround, light.hemi));
  const sun = new THREE.DirectionalLight(light.sunColor, light.sun);
  sun.position.copy(light.sunOffset);
  scene.add(sun);

  const scale = city.terrain?.scale ?? 1;
  if (city.horizon) {
    scene.add(horizonMesh(city.horizon, scale, light.horizon, onMountain(city) ? city.race : undefined));
    // Quito's lights around a city zone; out on a mountain road the valley is dark.
    if (tod === 'night' && !onMountain(city)) scene.add(cityLights(city.horizon, scale));
    for (const l of city.landmarks ?? []) scene.add(l.kind === 'virgen' ? virgen(l, scale) : volcano(l, scale));
    // Out in the mountains, banks of cloud over the far ridges and around the volcanoes.
    if (onMountain(city)) scene.add(mistMesh(farClouds(city.horizon, city.landmarks ?? []), MIST_LOOK[tod], 40000));
  } else scene.add(buildMountains(cityRadius));
  return scene;
}

/**
 * Quito at night from inside it: the valley floor and the lower slopes around the zone are
 * dotted with lights (one draw call of points), the páramo above stays dark.
 */
function cityLights(h: Horizon, scale: number): THREE.Points {
  const pos: number[] = [];
  const col: number[] = [];
  const warm = new THREE.Color('#ffc874');
  const cool = new THREE.Color('#e8eeff');
  const c = new THREE.Color();
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let r = 0; r < h.rows - 1; r++)
    for (let k = 0; k < h.cols - 1; k++) {
      const y = h.heights[r * h.cols + k];
      const x = h.minX + k * h.cell;
      const z = h.minZ + r * h.cell;
      const d = Math.hypot(x, z);
      // Built-up: the valley and up to ~350 m above it, thinning out with height and distance.
      const density = Math.max(0, 1 - Math.max(0, y - 80) / 300) * Math.min(1, Math.max(0, (d - 1100) / 400)) * Math.max(0.15, 1 - d / 14000);
      const n = Math.floor(density * 2.5 + rnd());
      for (let i = 0; i < n; i++) {
        const u = rnd();
        const v = rnd();
        const i0 = r * h.cols + k;
        // Bilinear height inside the cell, a little over the ground.
        const hy = (h.heights[i0] * (1 - u) + h.heights[i0 + 1] * u) * (1 - v) + (h.heights[i0 + h.cols] * (1 - u) + h.heights[i0 + h.cols + 1] * u) * v;
        pos.push(x + u * h.cell, hy * scale + 4, z + v * h.cell);
        c.copy(rnd() < 0.7 ? warm : cool).multiplyScalar(0.6 + rnd() * 0.4);
        col.push(c.r, c.g, c.b);
      }
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false }));
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

/** Out in the mountains (a race track; heights over its valley floor): the biome's forest, rock, the snow on Antisana. */
function wildBands(race: TrackData | undefined): [number, THREE.Color][] {
  return biomeOf(race).far.map(([h, c]) => [h, new THREE.Color(c)]);
}

function bandColor(h: number, out: THREE.Color, bands = BANDS): THREE.Color {
  if (h <= bands[0][0]) return out.copy(bands[0][1]);
  for (let i = 1; i < bands.length; i++) {
    if (h <= bands[i][0]) return out.copy(bands[i - 1][1]).lerp(bands[i][1], (h - bands[i - 1][0]) / (bands[i][0] - bands[i - 1][0]));
  }
  return out.copy(bands[bands.length - 1][1]);
}

/**
 * The far terrain as one low-poly grid. Low ground near the city fades into the same haze as
 * the city's own fog, so the two meet without a seam; hills stand clear of it.
 */
function horizonMesh(h: Horizon, scale: number, haze: THREE.Color, race?: TrackData): THREE.Mesh {
  const pos = new Float32Array(h.cols * h.rows * 3);
  const col = new Float32Array(h.cols * h.rows * 3);
  const c = new THREE.Color();
  const wild = !!race;
  const bands = wild ? wildBands(race) : BANDS;
  for (let r = 0; r < h.rows; r++)
    for (let k = 0; k < h.cols; k++) {
      const i = r * h.cols + k;
      const x = h.minX + k * h.cell;
      const z = h.minZ + r * h.cell;
      const y = h.heights[i];
      pos.set([x, y * scale - 2, z], i * 3);
      // A little variation so the city floor doesn't read as a flat sheet.
      const n = Math.sin(x * 0.013 + z * 0.021) * Math.sin(x * 0.007 - z * 0.017);
      bandColor(y, c, bands).multiplyScalar(1 + n * 0.08);
      // Haze lies over the low city near the zone (matching the city's own fog); hills rising
      // out of it, like El Panecillo, stay clear.
      const near = Math.max(0, Math.min(1, 1 - (Math.hypot(x, z) - 1400) / 2200));
      const low = Math.max(0, Math.min(1, 1 - (y - 60) / 160));
      // (Not in the mountains: there the low ground is the valley floor, as green as the rest.)
      if (!wild) c.lerp(haze, 0.85 * near * low);
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

/** Cloud banks over the far terrain (1.5–12 km out) and wrapped around the volcanoes' flanks. */
function farClouds(h: Horizon, landmarks: Landmark[]): Puff[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const at = (x: number, z: number) => {
    const c = Math.max(0, Math.min(h.cols - 1, Math.round((x - h.minX) / h.cell)));
    const r = Math.max(0, Math.min(h.rows - 1, Math.round((z - h.minZ) / h.cell)));
    return h.heights[r * h.cols + c];
  };
  const out: Puff[] = [];
  for (let i = 0; i < 170; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 1500 + rnd() ** 0.7 * 10500;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const size = 450 + rnd() * 1100;
    out.push({ x, y: at(x, z) + 120 + rnd() * 450, z, size, alpha: 0.35 + rnd() * 0.4 });
  }
  for (const l of landmarks)
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2;
      const d = 1500 + rnd() * 3500;
      out.push({ x: l.pos.x + Math.cos(a) * d, y: l.y - 1700 + rnd() * 700, z: l.pos.z + Math.sin(a) * d, size: 1800 + rnd() * 1500, alpha: 0.45 + rnd() * 0.3 });
    }
  return out;
}
