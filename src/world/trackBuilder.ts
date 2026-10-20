import * as THREE from 'three';
import { RAPIER, addTerrainCollider, markStatic } from '../physics/world';
import type { CityData, Vec2 } from './cityData';
import { terrainAt } from './cityData';
import { ChunkedMeshBuilder, InstancedTiles, MeshBuilder, hash2, vertexColorMaterial, withinRange } from './meshBuilder';
import type { RoadGraph } from './roadGraph';
import type { Terrain } from './terrain';
import { type TrackData, locateOnTrack, trackPoint } from './track';
import { PropSystem } from './props';
import { RoadIndex } from './roadIndex';
import { BuildingIndex } from './facades';
import { SignalLamps } from './signalBuilder';
import { TrafficLights } from '../gameplay/trafficLights';
import { LIGHTING, timeOfDayOf } from './sky';
import type { BuiltCity } from './cityBuilder';
import { Rng } from '../core/rng';
import { type Puff, MIST_LOOK, mistMesh } from './mist';
import type { TrackScenery } from './track';
import { distToPolyline, pointInPolygon } from './geom';
import { crowdMesh, crowdSpots } from './spectators';

const ASPHALT = '#4a4c52';
const MARK_WHITE = '#eceae0';
const MARK_YELLOW = '#e8c230';
/** The deck's sides: a stone retaining wall under the road's edge. */
const STONE = '#7b746a';
const STEEL = '#b8bdc3';
const POST = '#868b90';
const CHEVRON = '#f3c418';
/** A chevron's face at night, lit by nothing but how it shines back in headlights. */
const CHEVRON_LIT = '#b08c10';
const SIGN_BACK = '#6d7075';
/** Terrain colors: páramo grass, cloud-forest green, bare cut earth, rock, the gravel shoulder. */
const PARAMO = new THREE.Color('#a39f58');
const FOREST = new THREE.Color('#4d7337');
const EARTH = new THREE.Color('#8a7660');
const ROCK = new THREE.Color('#77736d');
const GRAVEL = new THREE.Color('#9a907f');
/** Guardrail: beam from BEAM_LO to BEAM_HI over the road, posts every POST_EVERY m, this far past the asphalt. */
const RAIL_OUT = 0.45;
const BEAM_LO = 0.42;
const BEAM_HI = 0.78;
const POST_EVERY = 4;
/** A bend this tight (radius, m) gets chevron signs on its outside. */
const CHEVRON_RADIUS = 75;
/** Trees, shrubs and rocks aren't drawn past this (m): the hills behind are what you see there. */
const PLANTS_RANGE = 900;
/** Trees and shrubs: one try per this many meters of road per side. */
const TREE_STEP = 5;

/**
 * Builds a race track (`city.race`): the terrain colored for the mountains, the road on its own
 * deck (one trimesh collider per stretch) with a stone wall down its edges to the ground, double
 * yellow center and white edge lines, steel guardrails along the railed drops (solid), chevron
 * signs on the tight bends, the start and finish gantries with checkered lines, and trees,
 * shrubs and rocks on the valley sides. Returns empty props and traffic lights.
 */
export function buildTrack(city: CityData, world: RAPIER.World, scene: THREE.Scene, graph: RoadGraph): BuiltCity {
  const race = city.race!;
  const light = LIGHTING[timeOfDayOf(scene)];
  const t = city.terrain!;
  const layer = (factor: number) => vertexColorMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: factor, polygonOffsetUnits: factor });
  const ground = (p: Vec2) => terrainAt(city, p);
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

  addTerrainCollider(world, t);
  for (const m of trackTerrain(t, race, layer(6))) scene.add(m);

  const deck = new ChunkedMeshBuilder(300);
  const paint = new ChunkedMeshBuilder(300);
  const solid = new ChunkedMeshBuilder(300);
  roadDeck(race, deck, paint, ground, world, fixed);
  for (const r of race.rails) guardrail(race, r, solid, world, fixed);
  // At night the boards shine back in the headlights (retroreflective): their faces unlit.
  const lit = timeOfDayOf(scene) === 'night' ? new ChunkedMeshBuilder(300) : null;
  const leds = chevrons(race, solid, ground, lit);
  if (lit) scene.add(...lit.build(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  gantry(race, race.start, 'SALIDA', solid, paint, scene, world, fixed);
  gantry(race, race.finish, 'META', solid, paint, scene, world, fixed);
  const banks = new ChunkedMeshBuilder(300);
  fillBanks(race, banks, ground);
  shrines(race, solid);
  const sc = race.scenery;
  const water = new ChunkedMeshBuilder(400);
  const texts: TextSign[] = [];
  if (sc) {
    for (const rv of sc.rivers) river(rv, water);
    for (const pipe of sc.pipes) pipeline(race, pipe, solid, ground, world, fixed);
    for (const b of sc.buildings) house(race, b, solid, ground, texts, world, fixed);
  }
  const zones = mistZones(race);
  roadSigns(race, zones, solid, ground, texts);
  const plants = scatter(race, t, ground, world, fixed, (p) => !!sc && blocked(sc, p));

  const meshes = [...deck.build(layer(0)), ...paint.build(layer(-3))];
  for (const m of meshes) m.receiveShadow = true;
  scene.add(...meshes, ...solid.build(vertexColorMaterial({ side: THREE.DoubleSide }), { merge: 2, shadows: true }));
  scene.add(...plants.map((m) => withinRange(m, PLANTS_RANGE)));
  for (const m of banks.build(layer(3))) {
    m.receiveShadow = true;
    scene.add(m);
  }
  const waterMat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, specular: '#b8c4c8', shininess: 60, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  for (const m of water.build(waterMat)) {
    m.receiveShadow = true;
    scene.add(withinRange(m, PLANTS_RANGE * 1.6));
  }
  const signs = textSigns(texts);
  if (signs) scene.add(signs);
  const tod = timeOfDayOf(scene);
  // After dark the chevrons' lamps flash in sequence round each bend.
  if (light.headlights && leds.length) scene.add(chevronLamps(leds));
  // A crowd at the start and at the finish.
  const clear = (p: Vec2) => !!sc && blocked(sc, p);
  scene.add(crowdMesh([...crowdSpots(race, race.start - 70, race.start + 25, ground, clear), ...crowdSpots(race, race.finish - 40, race.finish + 15, ground, clear)]));
  scene.add(mistMesh(mistPuffs(race, t, zones), MIST_LOOK[tod], 2600));

  // No traffic lights or props on a track, but the session expects both.
  const signals = new SignalLamps({
    city,
    graph,
    lights: new TrafficLights(graph, []),
    roads: new RoadIndex(city.roads),
    buildings: new BuildingIndex([]),
    ground,
    solid: new ChunkedMeshBuilder(),
    paint: new ChunkedMeshBuilder(),
    light,
    world,
    fixed,
  });
  markStatic(world);
  return { props: new PropSystem(world, scene, city), signals };
}

const v3 = (p: Vec2, y: number) => ({ x: p.x, y, z: p.z });

/** Unit right-of-travel normal at each centerline point (mitered between its segments). */
function normals(pts: Vec2[]): Vec2[] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: -(b.z - a.z) / l, z: (b.x - a.x) / l };
  });
}

/**
 * The road: the asphalt deck flat across at the surface height, its two sides walled in stone
 * down to the ground (the ravine starts right at the edge), the paint, and one trimesh collider
 * per 60 m: the deck is what the wheels drive on, never the terrain under it.
 */
function roadDeck(race: TrackData, deck: ChunkedMeshBuilder, paint: ChunkedMeshBuilder, ground: (p: Vec2) => number, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const { points: pts, y } = race;
  const n = normals(pts);
  const hw = race.width / 2;
  const at = (i: number, off: number) => ({ x: pts[i].x + n[i].x * off, z: pts[i].z + n[i].z * off });
  const CHUNK = 20;
  let verts: number[] = [];
  let idx: number[] = [];
  const flush = () => {
    if (idx.length) world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx)).setFriction(1), fixed);
    verts = [];
    idx = [];
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const j = i + 1;
    const [la, ra, lb, rb] = [at(i, -hw), at(i, hw), at(j, -hw), at(j, hw)];
    const mb = deck.at(pts[i].x, pts[i].z);
    mb.quad(v3(la, y[i]), v3(lb, y[j]), v3(rb, y[j]), v3(ra, y[i]), ASPHALT);
    // Stone sides down to the ground (a little into it), both edges.
    for (const [a, b, off] of [
      [la, lb, -hw - 0.3],
      [ra, rb, hw + 0.3],
    ] as const) {
      const ga = Math.min(y[i] - 0.4, ground(at(i, off)) - 0.4);
      const gb = Math.min(y[j] - 0.4, ground(at(j, off)) - 0.4);
      mb.quad(v3(a, y[i]), v3(b, y[j]), v3(b, gb), v3(a, ga), STONE);
    }
    // Paint: white edge lines, a double yellow line down the middle.
    for (const [o0, o1, color] of [
      [-hw + 0.25, -hw + 0.4, MARK_WHITE],
      [hw - 0.4, hw - 0.25, MARK_WHITE],
      [-0.2, -0.08, MARK_YELLOW],
      [0.08, 0.2, MARK_YELLOW],
    ] as const)
      paint.at(pts[i].x, pts[i].z).quad(v3(at(i, o0), y[i] + 0.02), v3(at(j, o0), y[j] + 0.02), v3(at(j, o1), y[j] + 0.02), v3(at(i, o1), y[i] + 0.02), color);
    const base = verts.length / 3;
    if (i % CHUNK === 0) {
      verts.push(la.x, y[i], la.z, ra.x, y[i], ra.z);
    }
    verts.push(lb.x, y[j], lb.z, rb.x, y[j], rb.z);
    const a0 = i % CHUNK === 0 ? base : base - 2;
    const b0 = i % CHUNK === 0 ? base + 2 : base;
    idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    if (j % CHUNK === 0) flush();
  }
  flush();
}

/** A steel W-beam on posts along one side of the road from s0 to s1, solid from the road up past the beam. */
function guardrail(race: TrackData, r: TrackData['rails'][number], solid: ChunkedMeshBuilder, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const off = r.side * (race.width / 2 + RAIL_OUT);
  const q = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const point = (s: number) => {
    trackPoint(race, s, q);
    return { p: { x: q.x - q.dz * off, z: q.z + q.dx * off }, y: q.y };
  };
  const len = r.s1 - r.s0;
  const n = Math.max(1, Math.round(len / POST_EVERY));
  for (let k = 0; k < n; k++) {
    const a = point(r.s0 + (len * k) / n);
    const b = point(r.s0 + (len * (k + 1)) / n);
    const mb = solid.at(a.p.x, a.p.z);
    strip(mb, a.p, b.p, a.y + BEAM_LO, b.y + BEAM_LO, BEAM_HI - BEAM_LO, 0.1, STEEL);
    post(mb, a.p, a.y - 0.6, a.y + BEAM_HI + 0.02, 0.14, POST);
    if (k === n - 1) post(mb, b.p, b.y - 0.6, b.y + BEAM_HI + 0.02, 0.14, POST);
    // Solid: a thin slab from the road to the top of the beam (a bus scrapes along it).
    const d = unit(a.p, b.p);
    const o = { x: -d.z * 0.15, z: d.x * 0.15 };
    const corners = [-1, 1].flatMap((s) => [
      a.p.x + o.x * s, a.y - 0.3, a.p.z + o.z * s,
      a.p.x + o.x * s, a.y + BEAM_HI + 0.15, a.p.z + o.z * s,
      b.p.x + o.x * s, b.y - 0.3, b.p.z + o.z * s,
      b.p.x + o.x * s, b.y + BEAM_HI + 0.15, b.p.z + o.z * s,
    ]);
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(corners));
    if (desc) world.createCollider(desc.setFriction(0.3), fixed);
  }
}

/** Yellow chevron boards along the outside of each tight bend, facing the racers coming into it. */
function chevrons(race: TrackData, solid: ChunkedMeshBuilder, ground: (p: Vec2) => number, lit: ChunkedMeshBuilder | null): Lamp[] {
  const lamps: Lamp[] = [];
  // Each bend's boards in order: their lamps flash one after another round it.
  let order = 0;
  const q = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const turnAt = (s: number) => {
    // Heading change over 30 m: + = turning right.
    const a = trackPoint(race, s - 15, { ...q });
    const b = trackPoint(race, s + 15, { ...q });
    return (a.dx * b.dz - a.dz * b.dx) / 30;
  };
  let last = -Infinity;
  for (let s = race.start; s < race.finish; s += 6) {
    const k = turnAt(s);
    if (Math.abs(k) < 1 / CHEVRON_RADIUS || s - last < 18) continue;
    order = s - last > 40 ? 0 : order + 1;
    last = s;
    // Outside of the bend: left of travel for a right turn.
    const side = k > 0 ? -1 : 1;
    trackPoint(race, s, q);
    const off = side * (race.width / 2 + 1.4);
    const p = { x: q.x - q.dz * off, z: q.z + q.dx * off };
    const g = ground(p);
    // Over a drop there's nothing to plant it in.
    if (q.y - g > 2.5) continue;
    const mb = solid.at(p.x, p.z);
    post(mb, p, g - 0.3, q.y + 1.9, 0.08, POST);
    // The board faces back along the road (toward the racers), the chevron pointing into the turn.
    const face = { x: -q.dx, z: -q.dz };
    const across = { x: -face.z, z: face.x };
    const w = 0.75;
    const h = 0.6;
    const yb = q.y + 1.2;
    const c = { x: p.x + face.x * 0.06, z: p.z + face.z * 0.06 };
    const corner = (u: number, v: number, out = 0) => ({ x: c.x + across.x * u + face.x * out, y: yb + v, z: c.z + across.z * u + face.z * out });
    const faceMb = (lit ?? solid).at(p.x, p.z);
    faceMb.quad(corner(-w / 2, 0), corner(w / 2, 0), corner(w / 2, h), corner(-w / 2, h), lit ? CHEVRON_LIT : CHEVRON);
    mb.quad(corner(-w / 2, 0, -0.03), corner(-w / 2, h, -0.03), corner(w / 2, h, -0.03), corner(w / 2, 0, -0.03), SIGN_BACK);
    // A black ">" pointing into the turn. `across` is the driver's left, so a right turn points to -u.
    const sgn = k > 0 ? -1 : 1;
    const arm = (pts: [number, number][]) => {
      const [p0, p1, p2, p3] = pts.map(([u, v]) => corner(u * sgn, v, 0.01));
      faceMb.quad(p0, p1, p2, p3, '#1b1b1d');
    };
    arm([[-0.2, 0.52], [-0.06, 0.52], [0.18, 0.3], [0.04, 0.3]]);
    arm([[0.04, 0.3], [0.18, 0.3], [-0.06, 0.08], [-0.2, 0.08]]);
    // A lamp on top of the board.
    const top = corner(0, h + 0.08, 0.04);
    lamps.push({ x: top.x, y: top.y, z: top.z, order });
  }
  return lamps;
}

/** An amber lamp on a chevron board, and its place in its bend's sequence. */
interface Lamp {
  x: number;
  y: number;
  z: number;
  order: number;
}

/**
 * The chevrons' amber lamps after dark, one instanced draw: soft glows facing the camera, each
 * bend's flashing in sequence toward its far end (timed in the vertex shader).
 */
function chevronLamps(lamps: Lamp[]): THREE.Mesh {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  geo.setAttribute('center', new THREE.InstancedBufferAttribute(new Float32Array(lamps.flatMap((l) => [l.x, l.y, l.z])), 3));
  geo.setAttribute('order', new THREE.InstancedBufferAttribute(new Float32Array(lamps.map((l) => l.order)), 1));
  geo.instanceCount = lamps.length;
  const uniforms = { time: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      uniform float time;
      attribute vec3 center; attribute float order;
      varying vec2 vUv; varying float vOn;
      void main() {
        vec4 mv = modelViewMatrix * vec4(center, 1.0);
        // Bigger with distance (up to a point), so a far bend still reads as a row of lights.
        float d = -mv.z;
        mv.xy += position.xy * clamp(d * 0.03, 0.9, 4.0);
        float phase = fract(time * 1.25 - order * 0.18);
        vOn = 0.15 + 0.85 * (1.0 - smoothstep(0.0, 0.3, phase));
        vUv = uv;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vOn;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        float k = (1.0 - smoothstep(0.0, 1.0, r)) * vOn;
        if (k < 0.01) discard;
        gl_FragColor = vec4(vec3(1.0, 0.62, 0.12) * (k + smoothstep(0.25, 0.0, r) * vOn), k);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.name = 'chevron-lamps';
  const t0 = performance.now();
  mesh.onBeforeRender = () => {
    uniforms.time.value = (performance.now() - t0) / 1000;
  };
  return mesh;
}

/** A gantry across the road (two poles and a banner) and a checkered line painted under it. */
function gantry(race: TrackData, s: number, label: string, solid: ChunkedMeshBuilder, paint: ChunkedMeshBuilder, scene: THREE.Scene, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const q = trackPoint(race, s);
  const n = { x: -q.dz, z: q.dx };
  const half = race.width / 2 + 1.3;
  const top = q.y + 6.2;
  const mb = solid.at(q.x, q.z);
  for (const side of [-1, 1]) {
    const p = { x: q.x + n.x * half * side, z: q.z + n.z * half * side };
    post(mb, p, q.y - 1, top + 1.2, 0.35, '#c62d2d');
    world.createCollider(RAPIER.ColliderDesc.cylinder(4, 0.2).setTranslation(p.x, q.y + 3, p.z), fixed);
  }
  // Checkered line across the asphalt, two rows of squares.
  const sq = 0.6;
  const cells = Math.round(race.width / sq);
  for (let row = 0; row < 2; row++)
    for (let k = 0; k < cells; k++) {
      const u0 = -race.width / 2 + k * sq;
      const s0 = row * sq;
      const corner = (u: number, a: number) => ({ x: q.x + n.x * u + q.dx * a, y: q.y + 0.025, z: q.z + n.z * u + q.dz * a });
      paint.at(q.x, q.z).quad(corner(u0, s0), corner(u0, s0 + sq), corner(u0 + sq, s0 + sq), corner(u0 + sq, s0), (k + row) % 2 ? '#111111' : '#f4f4f4');
    }
  // The banner: a canvas texture with the label, both faces.
  const width = half * 2;
  // Facing the racers coming up to it, and the same the right way round on its back.
  const material = bannerMaterial(label);
  for (const turn of [0, Math.PI]) {
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(width, 1.3), material);
    banner.position.set(q.x, top + 0.45, q.z);
    banner.rotation.y = Math.atan2(-q.dx, -q.dz) + turn;
    scene.add(banner);
  }
}

function bannerMaterial(label: string): THREE.Material {
  if (typeof document === 'undefined') return new THREE.MeshBasicMaterial({ color: '#c62d2d' });
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c62d2d';
  g.fillRect(0, 0, c.width, c.height);
  // Checkered ends.
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (const x0 of [0, c.width - 64]) {
    g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
    g.fillRect(x0 + i * 16, j * 16, 16, 16);
  }
  g.fillStyle = '#fff';
  g.font = 'bold 46px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: tex });
}

/**
 * The terrain in tiles like a city's, colored by what grows there: gravel at the road's edge,
 * bare earth and rock on steep cuts and cliffs, páramo grass up high giving way to the cloud
 * forest's green lower down.
 */
function trackTerrain(t: Terrain, race: TrackData, material: THREE.Material): THREE.Mesh[] {
  // Distance to the road on the grid (rasterized along the centerline, near the road only).
  const nearRoad = new Float32Array(t.cols * t.rows).fill(Infinity);
  for (let i = 0; i < race.points.length; i++) {
    const p = race.points[i];
    const c0 = Math.round((p.x - t.minX) / t.cell);
    const r0 = Math.round((p.z - t.minZ) / t.cell);
    for (let r = r0 - 2; r <= r0 + 2; r++)
      for (let c = c0 - 2; c <= c0 + 2; c++) {
        if (r < 0 || c < 0 || r >= t.rows || c >= t.cols) continue;
        const d = Math.hypot(t.minX + c * t.cell - p.x, t.minZ + r * t.cell - p.z);
        const k = r * t.cols + c;
        if (d < nearRoad[k]) nearRoad[k] = d;
      }
  }
  const ys = race.y;
  const hi = Math.max(...ys);
  const lo = Math.min(...ys);
  const h = (r: number, c: number) => t.heights[Math.max(0, Math.min(t.rows - 1, r)) * t.cols + Math.max(0, Math.min(t.cols - 1, c))];
  const TILE = 80;
  const meshes: THREE.Mesh[] = [];
  const col = new THREE.Color();
  for (let r0 = 0; r0 < t.rows - 1; r0 += TILE)
    for (let c0 = 0; c0 < t.cols - 1; c0 += TILE) {
      const r1 = Math.min(t.rows - 1, r0 + TILE);
      const c1 = Math.min(t.cols - 1, c0 + TILE);
      const w = c1 - c0 + 1;
      const pos: number[] = [];
      const cols: number[] = [];
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const x = t.minX + c * t.cell;
          const z = t.minZ + r * t.cell;
          const y = h(r, c);
          pos.push(x, y * t.scale, z);
          const slope = Math.hypot(h(r, c + 1) - h(r, c - 1), h(r + 1, c) - h(r - 1, c)) / (2 * t.cell);
          // Higher up it's páramo, lower down forest (with patches of each by noise).
          const alt = (y - lo) / (hi - lo || 1);
          const noise = hash2(Math.floor(x / 40), Math.floor(z / 40), 3) * 0.5 + hash2(x, z, 9) * 0.15;
          col.copy(FOREST).lerp(PARAMO, Math.max(0, Math.min(1, alt * 1.2 - 0.25 + noise * 0.6)));
          if (slope > 0.9) col.lerp(slope > 1.3 ? ROCK : EARTH, Math.min(1, (slope - 0.9) * 2));
          if (nearRoad[r * t.cols + c] < race.width / 2 + 3) col.copy(GRAVEL);
          cols.push(col.r, col.g, col.b);
        }
      const idx: number[] = [];
      for (let r = 0; r < r1 - r0; r++)
        for (let c = 0; c < c1 - c0; c++) {
          const a = r * w + c;
          idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, material);
      m.receiveShadow = true;
      meshes.push(m);
    }
  return meshes;
}

/** A tree, shrub or rock beside the track: where, how big, which way it's turned, its tint. */
export interface Plant {
  kind: 'tree' | 'shrub' | 'rock';
  p: Vec2;
  y: number;
  size: number;
  /** Height over width (trees). */
  stretch: number;
  turn: number;
  /** HSL. */
  hsl: [number, number, number];
  /** Solid (near the road: a bus going over the edge hits trunks and boulders). */
  solid: boolean;
}

/** Keeps every plant's middle this far past the asphalt's edge: a tree's crown or a boulder never overhangs a lane. */
export const PLANT_CLEAR = 3.5;

/**
 * Where trees, shrubs and rocks grow on the valley sides: thicker lower down (cloud forest),
 * sparse up in the páramo, rocks on the steep cuts; never on or right beside any leg of the
 * road (a hairpin's other leg can be far along the track but right here, so the whole track is
 * searched). Deterministic.
 */
export function plantSpots(race: TrackData, t: Terrain, ground: (p: Vec2) => number, blockedAt: (p: Vec2) => boolean = () => false): Plant[] {
  const rng = new Rng(17);
  const lo = Math.min(...race.y);
  const hi = Math.max(...race.y);
  const at = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const len = race.cum[race.cum.length - 1];
  const hw = race.width / 2;
  const out: Plant[] = [];
  for (let s = 0; s < len; s += TREE_STEP)
    for (const side of [-1, 1]) {
      trackPoint(race, s, at);
      const alt = (at.y - lo) / (hi - lo || 1);
      for (let k = 0; k < 3; k++) {
        // Denser near the road (what you see), out to ~240 m.
        const off = side * (hw + 4 + 240 * rng.next() ** 1.8);
        const p = { x: at.x - at.dz * off + rng.range(-3, 3), z: at.z + at.dx * off + rng.range(-3, 3) };
        if (p.x < t.minX + 10 || p.z < t.minZ + 10 || p.x > t.minX + (t.cols - 2) * t.cell || p.z > t.minZ + (t.rows - 2) * t.cell) continue;
        const where = locateOnTrack(race, p);
        if (Math.abs(where.off) < hw + PLANT_CLEAR || blockedAt(p)) continue;
        const g = ground(p);
        const slope = Math.hypot(ground({ x: p.x + 2, z: p.z }) - ground({ x: p.x - 2, z: p.z }), ground({ x: p.x, z: p.z + 2 }) - ground({ x: p.x, z: p.z - 2 })) / 4;
        const forest = 1 - alt * 0.75;
        let kind: Plant['kind'];
        if (slope > 1.1) kind = 'rock';
        else if (rng.next() < forest * 0.8) kind = 'tree';
        else if (rng.next() < 0.75) kind = 'shrub';
        else kind = 'rock';
        if (kind === 'rock' && rng.next() < 0.5) continue;
        const size = kind === 'tree' ? rng.range(0.8, 1.5) : kind === 'shrub' ? rng.range(0.6, 1.3) : rng.range(0.5, 1.6);
        const turn = rng.range(0, Math.PI * 2);
        const stretch = kind === 'tree' ? rng.range(0.85, 1.25) : 1;
        const hsl: Plant['hsl'] = [
          kind === 'rock' ? 0.08 : 0.22 + rng.range(-0.04, 0.05),
          kind === 'rock' ? 0.05 : 0.45,
          kind === 'rock' ? rng.range(0.42, 0.55) : rng.range(0.42, 0.58),
        ];
        out.push({ kind, p, y: g, size, stretch, turn, hsl, solid: Math.abs(where.off) < hw + 30 && kind !== 'shrub' });
      }
    }
  return out;
}

/** The plants as instanced meshes in tiles, and colliders for the solid ones. */
function scatter(race: TrackData, t: Terrain, ground: (p: Vec2) => number, world: RAPIER.World, fixed: RAPIER.RigidBody, blockedAt: (p: Vec2) => boolean): THREE.InstancedMesh[] {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const tiles = new InstancedTiles(
    {
      tree: { geometry: treeGeometry(), material, shadow: true },
      shrub: { geometry: shrubGeometry(), material, shadow: true },
      rock: { geometry: rockGeometry(), material, shadow: true },
    },
    400,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const tint = new THREE.Color();
  for (const pl of plantSpots(race, t, ground, blockedAt)) {
    q.setFromAxisAngle(up, pl.turn);
    scale.set(pl.size, pl.size * pl.stretch, pl.size);
    pos.set(pl.p.x, pl.y - 0.15, pl.p.z);
    m.compose(pos, q, scale);
    tint.setHSL(...pl.hsl).multiplyScalar(pl.kind === 'rock' ? 1.4 : 1.6);
    tiles.add(pl.kind, m, tint);
    if (pl.solid)
      world.createCollider(
        pl.kind === 'tree'
          ? RAPIER.ColliderDesc.cylinder(1.6 * pl.size, 0.28 * pl.size).setTranslation(pl.p.x, pl.y + 1.4 * pl.size, pl.p.z)
          : RAPIER.ColliderDesc.ball(0.7 * pl.size).setTranslation(pl.p.x, pl.y + 0.2, pl.p.z),
        fixed,
      );
  }
  return tiles.build();
}

/** A low-poly tree: a trunk and two lumps of crown (white-ish vertex colors, tinted per instance). */
function treeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.18, 0.28, 3.2, 5).translate(0, 1.6, 0);
  paint(trunk, '#5b4634');
  const crown = new THREE.IcosahedronGeometry(1.9, 0).scale(1, 1.15, 1).translate(0, 4.2, 0);
  paint(crown, '#ffffff');
  const top = new THREE.IcosahedronGeometry(1.3, 0).translate(0.4, 5.6, -0.2);
  paint(top, '#f2f2f2');
  parts.push(trunk, crown, top);
  return merge(parts);
}

function shrubGeometry(): THREE.BufferGeometry {
  const a = new THREE.IcosahedronGeometry(0.9, 0).scale(1.2, 0.7, 1.1).translate(0, 0.45, 0);
  paint(a, '#ffffff');
  const b = new THREE.IcosahedronGeometry(0.6, 0).translate(0.6, 0.4, 0.3);
  paint(b, '#eaeaea');
  return merge([a, b]);
}

function rockGeometry(): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(0.9, 0).scale(1.3, 0.75, 1);
  paint(g, '#ffffff');
  return g;
}

function paint(g: THREE.BufferGeometry, color: string): void {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat(), 3));
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const count = flat.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let at = 0;
  for (const g of flat) {
    pos.set(g.getAttribute('position').array as Float32Array, at * 3);
    col.set(g.getAttribute('color').array as Float32Array, at * 3);
    at += g.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeVertexNormals();
  return out;
}

/** A thin wall `height` tall along a-b (both faces and the top). */
function strip(mb: MeshBuilder, a: Vec2, b: Vec2, ya: number, yb: number, height: number, thick: number, color: string): void {
  const d = unit(a, b);
  const o = { x: (-d.z * thick) / 2, z: (d.x * thick) / 2 };
  const A0 = { x: a.x - o.x, z: a.z - o.z };
  const A1 = { x: a.x + o.x, z: a.z + o.z };
  const B0 = { x: b.x - o.x, z: b.z - o.z };
  const B1 = { x: b.x + o.x, z: b.z + o.z };
  mb.quad(v3(A0, ya), v3(B0, yb), v3(B0, yb + height), v3(A0, ya + height), color);
  mb.quad(v3(B1, yb), v3(A1, ya), v3(A1, ya + height), v3(B1, yb + height), color);
  mb.quad(v3(A0, ya + height), v3(B0, yb + height), v3(B1, yb + height), v3(A1, ya + height), color);
}

/** A square post from y0 to y1. */
function post(mb: MeshBuilder, p: Vec2, y0: number, y1: number, w: number, color: string): void {
  const h = w / 2;
  const c = [
    { x: p.x - h, z: p.z - h },
    { x: p.x + h, z: p.z - h },
    { x: p.x + h, z: p.z + h },
    { x: p.x - h, z: p.z + h },
  ];
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    mb.quad(v3(a, y0), v3(b, y0), v3(b, y1), v3(a, y1), color);
  }
  mb.quad(v3(c[0], y1), v3(c[1], y1), v3(c[2], y1), v3(c[3], y1), color);
}

function unit(a: Vec2, b: Vec2): Vec2 {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}

/** No plant in a river, a building or on a pipeline. */
export function blocked(sc: TrackScenery, p: Vec2): boolean {
  return (
    sc.rivers.some((rv) => distToPolyline(p, rv.points) < rv.width / 2 + 2) ||
    sc.pipes.some((pp) => distToPolyline(p, pp.points) < 2.5) ||
    sc.buildings.some((b) => pointInPolygon(p, b.footprint) || distToPolyline(p, [...b.footprint, b.footprint[0]]) < 3)
  );
}

/**
 * The road's fill bank where the ground falls away beside it: a strip from the asphalt's edge
 * down to the ground FILL_WIDTH out, following the road's curve exactly (the 8 m terrain grid
 * alone draws that edge as a sawtooth of triangles). A gravel shoulder, then earth into grass.
 */
const FILL_WIDTH = 5;
function fillBanks(race: TrackData, mb: ChunkedMeshBuilder, ground: (p: Vec2) => number): void {
  const { points: pts, y } = race;
  const n = normals(pts);
  const hw = race.width / 2;
  const steps = [0, 0.7, 1.8, 3.2, FILL_WIDTH];
  const cols = ['#9a907f', '#9a907f', '#86745c', '#6f7445', '#62783f'];
  for (const side of [-1, 1]) {
    const ring = (i: number) => {
      const edge = y[i] - 0.06;
      const far = { x: pts[i].x + n[i].x * side * (hw + FILL_WIDTH), z: pts[i].z + n[i].z * side * (hw + FILL_WIDTH) };
      const gFar = ground(far) + 0.05;
      return steps.map((d, k) => {
        const p = { x: pts[i].x + n[i].x * side * (hw + d), z: pts[i].z + n[i].z * side * (hw + d) };
        const t = d / FILL_WIDTH;
        // A bank that bows out (convex) like real fill, never under the ground it covers.
        const line = edge + (gFar - edge) * (k === 1 ? 0.02 : t ** 0.8);
        return { x: p.x, y: Math.max(line, ground(p) + 0.04), z: p.z };
      });
    };
    let prev = ring(0);
    for (let i = 1; i < pts.length; i++) {
      const cur = ring(i);
      // Only where the ground falls away: on a cut the slope rises from the ditch by itself.
      const falls = ground({ x: pts[i].x + n[i].x * side * (hw + FILL_WIDTH), z: pts[i].z + n[i].z * side * (hw + FILL_WIDTH) }) < y[i] - 0.5;
      if (falls)
        for (let k = 0; k < steps.length - 1; k++) {
          mb.at(pts[i].x, pts[i].z).quad(prev[k], cur[k], cur[k + 1], prev[k + 1], cols[k]);
        }
      prev = cur;
    }
  }
}

/**
 * Little roadside shrines (a white cross, sometimes a tiny chapel with flowers) at some of the
 * open drops: on Ecuador's mountain roads they mark where a bus went over.
 */
function shrines(race: TrackData, solid: ChunkedMeshBuilder): void {
  const rng = new Rng(29);
  const q = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  for (const d of race.drops) {
    if (!rng.chance(0.55)) continue;
    const s = d.s0 + (d.s1 - d.s0) * rng.range(0.2, 0.8);
    trackPoint(race, s, q);
    const off = d.side * (race.width / 2 + 0.55);
    const p = { x: q.x - q.dz * off, z: q.z + q.dx * off };
    const mb = solid.at(p.x, p.z);
    const along = { x: q.dx, z: q.dz };
    if (rng.chance(0.5)) {
      post(mb, p, q.y - 0.4, q.y + 1.15, 0.09, '#f4f4f0');
      const arm = (u: number) => ({ x: p.x + along.x * u, z: p.z + along.z * u });
      strip(mb, arm(-0.32), arm(0.32), q.y + 0.78, q.y + 0.78, 0.09, 0.09, '#f4f4f0');
    } else {
      // A capillita: a white box on a post with a red roof, a pot of yellow flowers in front.
      post(mb, p, q.y - 0.4, q.y + 0.75, 0.12, '#bdb8ad');
      const a = { x: p.x - along.x * 0.3, z: p.z - along.z * 0.3 };
      const b = { x: p.x + along.x * 0.3, z: p.z + along.z * 0.3 };
      strip(mb, a, b, q.y + 0.75, q.y + 0.75, 0.55, 0.45, '#f6f3ea');
      strip(mb, a, b, q.y + 1.3, q.y + 1.3, 0.12, 0.55, '#b4442f');
      const roadward = -d.side * 0.35;
      post(mb, { x: p.x - q.dz * roadward, z: p.z + q.dx * roadward }, q.y - 0.05, q.y + 0.18, 0.22, '#e8b422');
    }
  }
}

/** A river: its water a ribbon at the river's level, white water mottled in. */
function river(rv: TrackScenery['rivers'][number], mb: ChunkedMeshBuilder): void {
  const n = normals(rv.points);
  const half = rv.width / 2 + 1.5;
  const c = new THREE.Color();
  const deep = new THREE.Color('#5d7c80');
  const foam = new THREE.Color('#d9e4e4');
  for (let i = 1; i < rv.points.length; i++) {
    const [a, b] = [rv.points[i - 1], rv.points[i]];
    const across = (p: Vec2, k: number, o: number) => ({ x: p.x + n[k].x * o, y: rv.y[k], z: p.z + n[k].z * o });
    // Steeper stretches foam more.
    const drop = Math.max(0, rv.y[i - 1] - rv.y[i]) / 6;
    const white = Math.min(0.85, drop * 6 + hash2(a.x, a.z, 5) * 0.35);
    c.copy(deep).lerp(foam, white);
    mb.at(a.x, a.z).quad(across(a, i - 1, -half), across(b, i, -half), across(b, i, half), across(a, i - 1, half), `#${c.getHexString()}`);
  }
}

/**
 * An oil pipeline on low stands (the SOTE and OCP run beside the Vía Interoceánica): a six-sided
 * tube 0.6 m over the ground, a stand every other point; solid near the road.
 */
function pipeline(race: TrackData, pipe: TrackScenery['pipes'][number], solid: ChunkedMeshBuilder, ground: (p: Vec2) => number, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const r = pipe.diameter / 2;
  const pts = pipe.points;
  const ys = pts.map((p) => ground(p) + 0.6 + r);
  const hw = race.width / 2;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const d = unit(a, b);
    const side = { x: -d.z, z: d.x };
    const ring = (p: Vec2, y: number) =>
      Array.from({ length: 6 }, (_, k) => {
        const ang = (k / 6) * Math.PI * 2;
        return { x: p.x + side.x * Math.cos(ang) * r, y: y + Math.sin(ang) * r, z: p.z + side.z * Math.cos(ang) * r };
      });
    const ra = ring(a, ys[i - 1]);
    const rb = ring(b, ys[i]);
    const mb = solid.at(a.x, a.z);
    for (let k = 0; k < 6; k++) mb.quad(ra[k], rb[k], rb[(k + 1) % 6], ra[(k + 1) % 6], k < 3 ? '#a8adb0' : '#8c9194');
    if (i % 2 === 0) {
      post(mb, a, ys[i - 1] - r - 0.7, ys[i - 1] - r, 0.12, '#5d5a55');
      strip(mb, { x: a.x - side.x * (r + 0.1), z: a.z - side.z * (r + 0.1) }, { x: a.x + side.x * (r + 0.1), z: a.z + side.z * (r + 0.1) }, ys[i - 1] - r - 0.08, ys[i - 1] - r - 0.08, 0.08, 0.14, '#5d5a55');
    }
    if (Math.abs(locateOnTrack(race, a).off) < hw + 30) {
      const hull = [...ra, ...rb].flatMap((v) => [v.x, v.y, v.z]);
      const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(hull));
      if (desc) world.createCollider(desc.setFriction(0.5), fixed);
    }
  }
}

/** A sign with words on it, drawn from one shared canvas atlas. */
interface TextSign {
  text: string;
  /** Bottom-left and bottom-right corners of its face (seen from the front), and its height. */
  a: THREE.Vector3Like;
  b: THREE.Vector3Like;
  height: number;
  /** Board and letter colors. */
  bg: string;
  fg: string;
}

/**
 * A building of the town: walls on the lowest ground under it, a hipped tin roof, a door and
 * windows on each long wall (the one facing the road gets the door), a trade sign over the door
 * of a roadside business. Solid (its footprint's hull).
 */
function house(race: TrackData, b: TrackScenery['buildings'][number], solid: ChunkedMeshBuilder, ground: (p: Vec2) => number, texts: TextSign[], world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const fp = b.footprint;
  const hs = fp.map(ground);
  const y0 = Math.min(...hs) - 0.3;
  const top = Math.max(...hs) + b.floors * 2.7;
  const c = { x: fp.reduce((s, p) => s + p.x, 0) / fp.length, z: fp.reduce((s, p) => s + p.z, 0) / fp.length };
  const mb = solid.at(c.x, c.z);
  // The wall facing the road gets the door (and the sign).
  const roadAt = locateOnTrack(race, c);
  const toRoad = (() => {
    const q = trackPoint(race, roadAt.s);
    const l = Math.hypot(q.x - c.x, q.z - c.z) || 1;
    return { x: (q.x - c.x) / l, z: (q.z - c.z) / l };
  })();
  let front = -1;
  let frontDot = -Infinity;
  for (let i = 0; i < fp.length; i++) {
    const [p, q] = [fp[i], fp[(i + 1) % fp.length]];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
    const out = unit(c, mid);
    const dot = out.x * toRoad.x + out.z * toRoad.z;
    if (len > 3 && dot > frontDot) (frontDot = dot), (front = i);
  }
  for (let i = 0; i < fp.length; i++) {
    const [p, q] = [fp[i], fp[(i + 1) % fp.length]];
    mb.quad(v3(p, y0), v3(q, y0), v3(q, top), v3(p, top), b.wall);
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 2.5) continue;
    const d = unit(p, q);
    const mid = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
    const out = unit(c, mid);
    // Openings stand a few centimeters out of the wall, facing out.
    const at = (u: number, y: number) => ({ x: p.x + d.x * u + out.x * 0.04, y, z: p.z + d.z * u + out.z * 0.04 });
    // (The material is double-sided: no winding to get right.)
    const face = (u0: number, u1: number, ya: number, yb: number, color: string) => mb.quad(at(u0, ya), at(u1, ya), at(u1, yb), at(u0, yb), color);
    const ground0 = Math.max(ground(p), ground(q));
    for (let f = 0; f < b.floors; f++) {
      const yb = ground0 + f * 2.7;
      const windows = Math.max(1, Math.floor(len / 3.2));
      for (let w = 0; w < windows; w++) {
        const u = (len * (w + 0.5)) / windows;
        if (f === 0 && i === front && w === Math.floor(windows / 2)) face(u - 0.55, u + 0.55, yb, yb + 2.1, '#5a4636');
        else face(u - 0.6, u + 0.6, yb + 1.0, yb + 2.0, '#2d3a44');
      }
    }
    if (i === front && b.sign) {
      const w = Math.min(4.5, len * 0.8);
      const u = len / 2;
      const ys = ground0 + (b.floors > 1 ? 2.75 : 2.2);
      const A = at(u - w / 2, ys);
      const B = at(u + w / 2, ys);
      // The face reads from outside: left to right as seen looking at the wall.
      const flip = (B.z - A.z) * out.x - (B.x - A.x) * out.z > 0;
      texts.push({ text: b.sign, a: flip ? B : A, b: flip ? A : B, height: 0.65, bg: '#f7f3e4', fg: '#b3261e' });
    }
  }
  // A hipped roof: eaves a little out from the walls, up to a short ridge.
  const eave = fp.map((p) => {
    const o = unit(c, p);
    return { x: p.x + o.x * 0.4, y: top - 0.05, z: p.z + o.z * 0.4 };
  });
  const peak = { x: c.x, y: top + 1.1, z: c.z };
  for (let i = 0; i < eave.length; i++) {
    const [a, bq] = [eave[i], eave[(i + 1) % eave.length]];
    mb.quad(a, bq, peak, peak, b.roof);
  }
  const hull = new Float32Array([...fp.flatMap((p) => [p.x, y0, p.z, p.x, top, p.z]), peak.x, peak.y, peak.z]);
  const desc = RAPIER.ColliderDesc.convexHull(hull);
  if (desc) world.createCollider(desc.setFriction(0.6), fixed);
}

/** Two stretches of thick mist on the road (Papallacta's páramo is in the clouds most afternoons). */
function mistZones(race: TrackData): { s0: number; s1: number }[] {
  const len = race.finish - race.start;
  return [0.32, 0.7].map((f) => ({ s0: race.start + len * f, s1: race.start + len * f + 320 }));
}

/** The town's name sign and "ZONA DE NEBLINA" ahead of each misty stretch, on the right. */
function roadSigns(race: TrackData, zones: { s0: number; s1: number }[], solid: ChunkedMeshBuilder, ground: (p: Vec2) => number, texts: TextSign[]): void {
  const q = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const put = (s: number, text: string, bg: string, fg: string, w: number) => {
    trackPoint(race, s, q);
    const off = race.width / 2 + 1.6;
    const p = { x: q.x - q.dz * off, z: q.z + q.dx * off };
    const g = Math.min(q.y, ground(p));
    const mb = solid.at(p.x, p.z);
    const across = { x: -q.dz, z: q.dx };
    const y = q.y + 1.6;
    for (const u of [-w / 2 + 0.15, w / 2 - 0.15]) post(mb, { x: p.x + across.x * u, z: p.z + across.z * u }, g - 0.3, y + 0.9, 0.08, POST);
    // Facing the racers: its left edge on the road side.
    const A = { x: p.x - across.x * w / 2 - q.dx * 0.06, y, z: p.z - across.z * w / 2 - q.dz * 0.06 };
    const B = { x: p.x + across.x * w / 2 - q.dx * 0.06, y, z: p.z + across.z * w / 2 - q.dz * 0.06 };
    texts.push({ text, a: A, b: B, height: 0.85, bg, fg });
    mb.quad({ ...B, x: B.x + q.dx * 0.03, z: B.z + q.dz * 0.03 }, { ...A, x: A.x + q.dx * 0.03, z: A.z + q.dz * 0.03 }, { ...A, x: A.x + q.dx * 0.03, y: y + 0.85, z: A.z + q.dz * 0.03 }, { ...B, x: B.x + q.dx * 0.03, y: y + 0.85, z: B.z + q.dz * 0.03 }, SIGN_BACK);
  };
  put(race.start + 40, race.from.toUpperCase(), '#1f6b3a', '#ffffff', 3.2);
  for (const z of zones) put(z.s0 - 90, 'ZONA DE NEBLINA', '#f3c418', '#1b1b1d', 3.4);
}

/** Every text sign in one mesh: the words drawn once into a canvas atlas, one row each. */
function textSigns(signs: TextSign[]): THREE.Mesh | null {
  if (!signs.length || typeof document === 'undefined') return null;
  const ROW = 64;
  const W = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = ROW * signs.length;
  const g = canvas.getContext('2d')!;
  const pos: number[] = [];
  const uv: number[] = [];
  signs.forEach((s, i) => {
    const len = Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z);
    // The row's width matches the sign's shape, so the letters aren't stretched.
    const px = Math.min(W, Math.round((len / s.height) * ROW));
    g.fillStyle = s.bg;
    g.fillRect(0, i * ROW, px, ROW);
    g.strokeStyle = s.fg;
    g.lineWidth = 4;
    g.strokeRect(3, i * ROW + 3, px - 6, ROW - 6);
    g.fillStyle = s.fg;
    g.font = `bold ${ROW * 0.55}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.text, px / 2, i * ROW + ROW / 2 + 2, px - 14);
    const [u0, u1] = [0, px / W];
    const [v0, v1] = [1 - ((i + 1) * ROW) / canvas.height, 1 - (i * ROW) / canvas.height];
    const A = s.a;
    const B = s.b;
    const C = { x: B.x, y: B.y + s.height, z: B.z };
    const D = { x: A.x, y: A.y + s.height, z: A.z };
    pos.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z, A.x, A.y, A.z, C.x, C.y, C.z, D.x, D.y, D.z);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  mesh.name = 'track-signs';
  return mesh;
}

/**
 * Clouds over the valley and mist on the road: banks of big puffs clinging to the slopes above
 * the road (the páramo lives in its clouds), and thick, low puffs over the asphalt along the
 * misty stretches, thinning out at their ends.
 */
function mistPuffs(race: TrackData, t: Terrain, zones: { s0: number; s1: number }[]): Puff[] {
  const rng = new Rng(41);
  const out: Puff[] = [];
  const q = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
  const len = race.cum[race.cum.length - 1];
  const tAt = (x: number, z: number) => terrainAt({ terrain: t } as CityData, { x, z });
  for (let s = 0; s < len; s += 45) {
    trackPoint(race, s, q);
    const side = rng.chance(0.5) ? 1 : -1;
    const off = side * rng.range(120, 650);
    const x = q.x - q.dz * off + rng.range(-40, 40);
    const z = q.z + q.dx * off + rng.range(-40, 40);
    const size = rng.range(90, 220);
    // Lying against the slope: a bit over the ground there, up to ~250 m over the road.
    const y = Math.max(tAt(x, z) + size * 0.2, q.y + rng.range(40, 250));
    out.push({ x, y, z, size, alpha: rng.range(0.35, 0.65) });
  }
  for (const zn of zones)
    for (let s = zn.s0; s < zn.s1; s += 7) {
      trackPoint(race, s, q);
      // Thickest in the middle of the stretch.
      const k = Math.sin(((s - zn.s0) / (zn.s1 - zn.s0)) * Math.PI);
      for (let j = 0; j < 2; j++) {
        const off = rng.range(-16, 16);
        out.push({ x: q.x - q.dz * off, y: q.y + rng.range(1.5, 6), z: q.z + q.dx * off, size: rng.range(18, 34), alpha: 0.18 + 0.32 * k });
      }
    }
  return out;
}
