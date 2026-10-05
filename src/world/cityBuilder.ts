import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { RAPIER, addTerrainCollider, markStatic } from '../physics/world';
import type { Building, CityData, Feature, Stop, Vec2 } from './cityData';
import { SIDEWALK_HEIGHT, forward, groundHeightAt, right, terrainAt } from './cityData';
import { bbox, pointInPolygon } from './geom';
import { ChunkedMeshBuilder, ChunkedUVQuadBuilder, MeshBuilder, extrude, vertexColorMaterial, IDENTITY, withinRange } from './meshBuilder';
import { type Path, type RoadGraph, buildRoadGraph, dirAt, edgeY, laneOffset, makePath, pointAt, projectOnPath } from './roadGraph';
import type { Terrain } from './terrain';
import { PropSystem } from './props';
import { addMonument } from './monuments';
import { type SidewalkSection, sidewalkSections } from './sidewalks';
import { addMetroEntrance, addStation, transitSigns } from './transitBuilder';
import { addRoadworks, addWalls, worksSigns } from './boundaryBuilder';
import { RoadIndex } from './roadIndex';
import { profileAt, projectOnRoad, roadProfiles, surfaceY } from './elevation';
import { buildGrades, nodeArea, planTrenches } from './gradeBuilder';
import { BuildingIndex, type FacadeContext, addFacades, buildingLook, centroid } from './facades';
import { addStreetscape } from './streetscape';
import { WHITE_UV, signAtlas } from './signAtlas';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LIGHTING, timeOfDayOf } from './sky';

// Draw order on the ground is enforced with polygon offsets, not height gaps, so layers stay
// put at any distance: terrain < sidewalk < asphalt < paint.
const ASPHALT = '#4d5057';
const MARK_WHITE = '#eceae0';
const MARK_YELLOW = '#e8c230';
const SIDEWALK_TOP = '#c9c5bb';
const CURB = '#a19d94';
const PARK_TOP = '#79a651';
const PAVING = '#b9b2a3';
const COUNTRY = '#8aa266';
/** Ground layers are draped vertex by vertex, with vertices at most this far apart. */
const DRAPE = 2.5;
/** Heights above the terrain for each ground layer. */
const Y = { sidewalk: 0.04, curb: 0.05, asphalt: 0.06, paint: 0.08 };

/** Anything that can take ground quads: a single builder or a tiled one. */
type QuadSink = Pick<MeshBuilder, 'quad' | 'drapedQuad'>;

export interface BuiltCity {
  props: PropSystem;
}

/**
 * Turns CityData into merged low-poly meshes (a few dozen draw calls) and static colliders,
 * lit for the scene's time of day (`setupSky`; day if none): windows lit from inside, lamps.
 */
export function buildCity(city: CityData, world: RAPIER.World, scene: THREE.Scene, graph = buildRoadGraph(city)): BuiltCity {
  const light = LIGHTING[timeOfDayOf(scene)];
  const h = (p: Vec2) => terrainAt(city, p);
  // Draped layers take the highest ground within half a drape step, so a flat quad spanning a
  // crease in the terrain rides over it instead of cutting under the ridge.
  const r = DRAPE / 2;
  const hUp = (p: Vec2) =>
    Math.max(h(p), h({ x: p.x + r, z: p.z }), h({ x: p.x - r, z: p.z }), h({ x: p.x, z: p.z + r }), h({ x: p.x, z: p.z - r }));
  const layer = (factor: number) =>
    vertexColorMaterial({ side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: factor, polygonOffsetUnits: factor });
  // Ground layers are tiled so the camera frustum can skip what's out of view.
  const sidewalks = new ChunkedMeshBuilder(150);
  const asphalt = new ChunkedMeshBuilder(150);
  const paint = new ChunkedMeshBuilder(150);
  const solid = new ChunkedMeshBuilder(); // casts and receives shadows
  // Facade detail and street furniture, in coarser tiles that aren't drawn past the fog.
  const detail = new ChunkedMeshBuilder(250); // casts and receives shadows
  const glow = new ChunkedMeshBuilder(250); // lit from inside at night: unshaded
  const atlas = signAtlas();
  const signs = atlas ? new ChunkedUVQuadBuilder(250) : null;

  // Underpasses cut through the terrain: a finer patch with the cut left open replaces it there.
  const trenches = planTrenches(city, graph);
  const groundColor = terrainColor(city);
  if (city.terrain) {
    addTerrainCollider(world, city.terrain, trenches ?? undefined);
    for (const m of terrainMeshes(city, city.terrain, layer(6), groundColor, trenches?.cells)) scene.add(m);
  } else scene.add(countryside(city));

  // Roads on bridges, in underpasses and on their ramps follow their own profile, not the ground.
  const profiles = roadProfiles(city);
  const roadHeight = (i: number) => {
    const prof = profiles[i];
    if (!prof) return hUp;
    const road = city.roads[i];
    return (p: Vec2) => surfaceY(city, profileAt(prof, projectOnRoad(road, p).s), p, hUp(p));
  };
  city.roads.forEach((road, i) => ribbon(asphalt, makePath(road.points), -road.width / 2, road.width / 2, roadHeight(i), Y.asphalt, ASPHALT));
  // Real cities have no block slabs: sidewalks run along the roads, clipped wherever they'd
  // cover asphalt or a junction (divided avenues put carriageways side by side).
  const sections = sidewalkSections(city, graph);
  if (!city.blocks.length)
    for (const run of sections) {
      strip(sidewalks, run, (s) => [s.from, s.to], hUp, Y.sidewalk, SIDEWALK_TOP);
      strip(sidewalks, run, (s) => [s.from, s.from + Math.sign(s.to - s.from) * 0.25], hUp, Y.curb, CURB);
    }
  // Junction paving drapes over the ground, raised or sunk by the junction's lift where it's
  // really up on a deck or down in a cut (not where one of its roads is just starting a ramp).
  for (const n of graph.nodes) if (n.hull) asphalt.fan(n.hull, (p) => hUp(p) + (Math.abs(n.lift) >= 1 ? n.lift : 0) + Y.asphalt, ASPHALT, DRAPE);
  // Where two pieces of a bridge or underpass meet at an angle, their ribbons leave a wedge open
  // on the outside of the bend: pave it (at street level the terrain under it hides the gap).
  for (const n of graph.nodes) if (!n.hull && n.y !== null && Math.abs(n.lift) >= 0.3) asphalt.fan(nodeArea(graph, n.id), () => n.y! + Y.asphalt, ASPHALT, DRAPE);
  addMarkings(paint, graph, (p) => hUp(p) + Y.paint);

  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const collide = (desc: RAPIER.ColliderDesc | null) => desc && world.createCollider(desc.setFriction(0.8), fixed);

  for (const b of city.blocks) {
    const c = centroid(b.footprint);
    solid.at(c.x, c.z).add(extrude(b.footprint, 0, SIDEWALK_HEIGHT), IDENTITY, b.kind === 'park' ? PARK_TOP : SIDEWALK_TOP, CURB);
    collide(RAPIER.ColliderDesc.convexHull(prismPoints(b.footprint, 0, SIDEWALK_HEIGHT)));
  }

  // Buildings sit on the lowest ground under them (sunk a little) and rise from the highest.
  const roadIndex = new RoadIndex(city.roads);
  const avenues = new RoadIndex(city.roads.filter((r) => r.kind === 'avenue' || /^Av\.? /.test(r.name)));
  const buildingIndex = new BuildingIndex(city.buildings.map((b) => b.footprint));
  const facades: FacadeContext = { detail, glow, signs, ground: h, roads: roadIndex, avenues, buildings: buildingIndex, light };
  const walls = new Map<string, number[]>();
  for (const b of city.buildings) {
    const hs = b.footprint.map(h);
    const ground = Math.max(...hs);
    const base = Math.min(...hs) - 0.3;
    const c = centroid(b.footprint);
    const prism = extrude(b.footprint, base, ground + b.height);
    const look = buildingLook(facades, b);
    solid.at(c.x, c.z).add(prism, IDENTITY, look.roof, look.wall);
    addFacades(facades, b, look, ground);
    const key = `${Math.floor(c.x / 150)},${Math.floor(c.z / 150)}`;
    const pos = prism.getAttribute('position').array as ArrayLike<number>;
    const list = walls.get(key) ?? [];
    for (let i = 0; i < pos.length; i++) list.push(pos[i]);
    walls.set(key, list);
    prism.dispose();
  }
  // One exact triangle-mesh collider per area: concave footprints stay concave.
  for (const verts of walls.values()) {
    const v = new Float32Array(verts);
    const idx = new Uint32Array(v.length / 3).map((_, i) => i);
    collide(RAPIER.ColliderDesc.trimesh(v, idx));
  }

  for (const f of city.features) {
    const pts = featurePoints(f, h);
    solid.at(f.pos.x, f.pos.z).add(new ConvexGeometry(pts), IDENTITY, f.kind === 'ramp' ? '#e39a2d' : MARK_YELLOW, f.kind === 'ramp' ? '#b8741c' : '#3a3a3a');
    collide(RAPIER.ColliderDesc.convexHull(new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z]))));
  }
  // Rapid-transit stops are served at their stations instead of a shelter.
  for (const s of city.stops) if (!s.system) addShelter(solid.at(s.pos.x, s.pos.z), s, groundHeightAt(city, s.pos), world, fixed);
  for (const s of city.stations ?? []) addStation(solid.at(s.pos.x, s.pos.z), s, h, world, fixed);
  for (const e of city.metro ?? []) addMetroEntrance(solid.at(e.pos.x, e.pos.z), e, h, world, fixed);
  addWalls(solid, city.walls ?? [], h, world, fixed);
  for (const m of city.monuments ?? []) addMonument(solid.at(m.pos.x, m.pos.z), m, h, world, fixed);
  for (const m of buildGrades(city, graph, trenches, solid, groundColor, world, fixed)) {
    m.material = layer(6);
    m.receiveShadow = true;
    scene.add(m);
  }
  let works: ReturnType<typeof addRoadworks> = { cones: [], signs: [] };
  if (city.playArea) {
    const index = roadIndex;
    const hulls = graph.nodes.filter((n) => n.hull).map((n) => n.hull!);
    const { min, max } = city.playArea;
    const nearEdge = (b: Building) =>
      b.footprint.some((p) => Math.min(Math.abs(p.x - min.x), Math.abs(p.x - max.x), Math.abs(p.z - min.z), Math.abs(p.z - max.z)) < 40);
    const edgeBuildings = city.buildings.filter(nearEdge);
    // Road surfaces at a point: an underpass crossing the edge is closed down on its floor.
    const boxes = city.roads.map((r) => {
      const b = bbox(r.points);
      return { x0: b.min.x - r.width, x1: b.max.x + r.width, z0: b.min.z - r.width, z1: b.max.z + r.width };
    });
    const surfaces = (p: Vec2) => {
      const ys: number[] = [];
      city.roads.forEach((road, i) => {
        const b = boxes[i];
        if (p.x < b.x0 || p.x > b.x1 || p.z < b.z0 || p.z > b.z1) return;
        if (projectOnRoad(road, p).d < road.width / 2) ys.push(roadHeight(i)(p));
      });
      return ys;
    };
    works = addRoadworks(
      solid,
      city,
      h,
      surfaces,
      (p) => index.onAsphalt(p, 0.3) || hulls.some((hl) => pointInPolygon(p, hl)),
      (p) => edgeBuildings.some((b) => pointInPolygon(p, b.footprint)),
      world,
      fixed,
    );
  }
  const streets = addStreetscape({
    city,
    graph,
    sections,
    roads: roadIndex,
    avenues,
    lifted: new RoadIndex(city.roads.filter((r) => r.lift?.some((l) => Math.abs(l) > 0.3))),
    buildings: buildingIndex,
    ground: hUp,
    bulbs: light.lamps ? glow : detail,
    light,
    world,
    fixed,
  });

  const ground = [...sidewalks.build(layer(3)), ...asphalt.build(layer(0)), ...paint.build(layer(-3))];
  for (const m of ground) m.receiveShadow = true;
  const solidMaterial = vertexColorMaterial({ side: THREE.DoubleSide });
  const solidMeshes = solid.build(solidMaterial);
  for (const m of solidMeshes) m.castShadow = m.receiveShadow = true;
  const decor = detail.build(solidMaterial);
  // Facade detail lies flat on the walls (or barely out of them): it takes shadows but casting
  // them would only double its cost in the shadow pass.
  for (const m of decor) m.receiveShadow = true;
  // Small things fade into the fog well before its far end: don't draw them out there. Lit
  // windows and signs are what the night is about, so they go all the way.
  const far = [
    ...decor.map((m) => withinRange(m, light.fogFar * 0.6)),
    ...streets.map((m) => withinRange(m, light.fogFar * 0.75)),
    ...lights(glow, signs, atlas).map((m) => withinRange(m, light.fogFar)),
  ];
  scene.add(...ground, ...solidMeshes, ...far, ...transitSigns(city.stations ?? [], city.metro ?? [], h), ...worksSigns(works.signs));

  markStatic(world);
  // The roadworks' cones can be knocked over like any other.
  return { props: new PropSystem(world, scene, { ...city, props: [...city.props, ...works.cones] }) };
}

/**
 * Unshaded layers: windows lit from inside and lamp bulbs (`glow`), and shop signs. By day
 * the signs are painted boards (shaded); when it's dark they're lit and share each tile's
 * draw call with the glow (the atlas has a white texel for the untextured quads).
 */
function lights(glow: ChunkedMeshBuilder, signs: ChunkedUVQuadBuilder | null, atlas: THREE.Texture | null): THREE.Mesh[] {
  const glowing = glow.geometries();
  if (!signs || !atlas) return [...glowing.values()].map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  if (!glowing.size) return signs.build(new THREE.MeshLambertMaterial({ map: atlas, side: THREE.DoubleSide }));
  const material = new THREE.MeshBasicMaterial({ map: atlas, vertexColors: true, side: THREE.DoubleSide });
  const tiles = signs.geometries();
  for (const k of glowing.keys()) if (!tiles.has(k)) tiles.set(k, new THREE.BufferGeometry());
  return [...tiles].map(([k, sg]) => {
    const parts: THREE.BufferGeometry[] = [];
    const g = glowing.get(k);
    if (g) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2).map((_, i) => WHITE_UV[i % 2]), 2));
      parts.push(g);
    }
    if (sg.getAttribute('position')) {
      sg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(sg.getAttribute('position').count * 3).fill(1), 3));
      parts.push(sg);
    }
    const merged = parts.length > 1 ? mergeGeometries(parts)! : parts[0];
    merged.computeBoundingSphere();
    return new THREE.Mesh(merged, material);
  });
}

/** Flat grass around a generated city, with the city cut out so nothing is coplanar. */
function countryside(city: CityData): THREE.Mesh {
  const { min, max } = city.bounds;
  const land = new THREE.Shape([new THREE.Vector2(-2000, -2000), new THREE.Vector2(2000, -2000), new THREE.Vector2(2000, 2000), new THREE.Vector2(-2000, 2000)]);
  land.holes.push(new THREE.Path([new THREE.Vector2(min.x, -min.z), new THREE.Vector2(min.x, -max.z), new THREE.Vector2(max.x, -max.z), new THREE.Vector2(max.x, -min.z)]));
  const grass = new THREE.Mesh(new THREE.ShapeGeometry(land).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#86a85f' }));
  grass.position.y = -0.03;
  grass.renderOrder = -1;
  grass.receiveShadow = true;
  return grass;
}

/** Ground color: paving in the city, parks green, country outside. */
function terrainColor(city: CityData): (x: number, z: number, out: THREE.Color) => THREE.Color {
  const parks = (city.parks ?? []).map((poly) => {
    const xs = poly.map((p) => p.x);
    const zs = poly.map((p) => p.z);
    return { poly, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  });
  const { min, max } = city.bounds;
  const cPave = new THREE.Color(PAVING);
  const cPark = new THREE.Color(PARK_TOP);
  const cCountry = new THREE.Color(COUNTRY);
  return (x: number, z: number, out: THREE.Color) => {
    const q = { x, z };
    if (parks.some((p) => x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && pointInPolygon(q, p.poly))) return out.copy(cPark);
    const outside = Math.max(min.x - x, x - max.x, min.z - z, z - max.z);
    return out.copy(cPave).lerp(cCountry, Math.min(1, Math.max(0, outside / 40)));
  };
}

/** Terrain grid in tiles (so it can be culled), leaving out `skip` cells (row * (cols - 1) + col). */
function terrainMeshes(
  city: CityData,
  t: Terrain,
  material: THREE.Material,
  color: (x: number, z: number, out: THREE.Color) => THREE.Color,
  skip?: Set<number>,
): THREE.Mesh[] {
  const TILE = 40;
  const meshes: THREE.Mesh[] = [];
  const c = new THREE.Color();
  for (let r0 = 0; r0 < t.rows - 1; r0 += TILE)
    for (let c0 = 0; c0 < t.cols - 1; c0 += TILE) {
      const r1 = Math.min(t.rows - 1, r0 + TILE);
      const c1 = Math.min(t.cols - 1, c0 + TILE);
      const w = c1 - c0 + 1;
      const pos: number[] = [];
      const col: number[] = [];
      for (let r = r0; r <= r1; r++)
        for (let cc = c0; cc <= c1; cc++) {
          const x = t.minX + cc * t.cell;
          const z = t.minZ + r * t.cell;
          pos.push(x, t.heights[r * t.cols + cc] * t.scale, z);
          color(x, z, c);
          col.push(c.r, c.g, c.b);
        }
      const idx: number[] = [];
      for (let r = 0; r < r1 - r0; r++)
        for (let cc = 0; cc < c1 - c0; cc++) {
          if (skip?.has((r0 + r) * (t.cols - 1) + c0 + cc)) continue;
          const a = r * w + cc;
          idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, material);
      m.receiveShadow = true;
      meshes.push(m);
    }
  return meshes;
}

/**
 * A strip between two lateral offsets along a path, draped over the terrain: vertices every
 * DRAPE meters along and across, each at the ground height under it plus `lift`. (Keeping a
 * road level side to side lets the ground poke through on cross slopes and divided avenues.)
 */
function ribbon(mb: QuadSink, path: Path, from: number, to: number, h: (p: Vec2) => number, lift: number, color: string): void {
  const samples: number[] = [];
  for (let s = 0; s < path.len; s += DRAPE) samples.push(s);
  for (const c of path.cum) samples.push(c);
  samples.sort((a, b) => a - b);
  const sections: { p: Vec2; dir: Vec2 }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (i > 0 && s - samples[i - 1] < 0.05) continue;
    // Average the directions either side of a vertex so the strip miters instead of tearing.
    const d0 = dirAt(path, Math.max(0, s - 0.01));
    const d1 = dirAt(path, Math.min(path.len, s + 0.01));
    let dx = d0.x + d1.x;
    let dz = d0.z + d1.z;
    const l = Math.hypot(dx, dz) || 1;
    const miter = 1 / Math.max(0.6, (dx / l) * d1.x + (dz / l) * d1.z);
    sections.push({ p: pointAt(path, s), dir: { x: (dx / l) * miter, z: (dz / l) * miter } });
  }
  drapeSections(mb, sections, () => [from, to], h, lift, color);
}

/** Draped quads between consecutive cross-sections, subdivided across so no quad is wider than DRAPE. */
function drapeSections<S extends { p: Vec2; dir: Vec2 }>(
  mb: QuadSink,
  sections: S[],
  span: (s: S) => [number, number],
  h: (p: Vec2) => number,
  lift: number,
  color: string,
): void {
  let cols = 1;
  for (const s of sections) {
    const [a, b] = span(s);
    cols = Math.max(cols, Math.ceil(Math.abs(b - a) / DRAPE));
  }
  const row = (s: S) => {
    const [a, b] = span(s);
    return Array.from({ length: cols + 1 }, (_, k) => {
      const off = a + ((b - a) * k) / cols;
      const q = { x: s.p.x - s.dir.z * off, z: s.p.z + s.dir.x * off };
      return { x: q.x, y: h(q) + lift, z: q.z };
    });
  };
  let prev = row(sections[0]);
  for (let i = 1; i < sections.length; i++) {
    const cur = row(sections[i]);
    for (let k = 0; k < cols; k++) mb.quad(prev[k], cur[k], cur[k + 1], prev[k + 1], color);
    prev = cur;
  }
}

/** Draped quads between consecutive sidewalk sections. */
function strip(
  mb: QuadSink,
  run: SidewalkSection[],
  span: (s: SidewalkSection) => [number, number],
  h: (p: Vec2) => number,
  lift: number,
  color: string,
): void {
  drapeSections(mb, run, span, h, lift, color);
}

/** Lane lines and center lines along every road piece, zebra crossings where it meets a junction. */
function addMarkings(mb: QuadSink, graph: RoadGraph, ground: (p: Vec2) => number): void {
  for (const e of graph.edges) {
    if (e.reverse >= 0 && e.reverse < e.id) continue; // draw each piece once
    const path = e.center;
    // On a ramp, bridge or underpass the paint follows the road's own surface.
    const y = e.y ? (p: Vec2) => edgeY(e, projectOnPath(path, p).s)! + Y.paint : ground;
    const lines: { off: number; color: string; dash: boolean }[] = [];
    if (e.reverse < 0) {
      for (let k = 0; k < e.lanes - 1; k++) lines.push({ off: laneOffset(e, k) - e.laneWidth / 2, color: MARK_WHITE, dash: true });
    } else {
      const avenue = e.lanes >= 2;
      if (avenue) lines.push({ off: -0.2, color: MARK_YELLOW, dash: false }, { off: 0.2, color: MARK_YELLOW, dash: false });
      else lines.push({ off: 0, color: MARK_WHITE, dash: true });
      for (let k = 0; k < e.lanes - 1; k++) {
        const off = laneOffset(e, k) - e.laneWidth / 2;
        lines.push({ off, color: MARK_WHITE, dash: true }, { off: -off, color: MARK_WHITE, dash: true });
      }
    }
    for (const l of lines) {
      const step = l.dash ? 6 : 1;
      const piece = l.dash ? 3 : 1.02;
      for (let s = 2; s + piece < path.len - 2; s += step) {
        const d = dirAt(path, s + piece / 2);
        const p = pointAt(path, s + piece / 2);
        mb.drapedQuad({ x: p.x - d.z * l.off, z: p.z + d.x * l.off }, d, piece, 0.18, y, l.color);
      }
    }
    // Zebra crossings just inside each end that meets a junction.
    for (const [node, s] of [
      [e.from, 1.8],
      [e.to, path.len - 1.8],
    ] as const) {
      if (!graph.nodes[node].junction || path.len < 8) continue;
      const d = dirAt(path, s);
      const p = pointAt(path, s);
      for (let o = -e.roadWidth / 2 + 0.8; o <= e.roadWidth / 2 - 0.8; o += 1.2) {
        mb.drapedQuad({ x: p.x - d.z * o, z: p.z + d.x * o }, d, 3, 0.6, y, MARK_WHITE);
      }
    }
  }
}

/** Bus shelter ("parada"): back panel, roof, bench and a blue sign, behind the waiting spot. */
function addShelter(mb: MeshBuilder, s: Stop, base: number, world: RAPIER.World, fixed: RAPIER.RigidBody): void {
  const r = right(s.heading);
  const center = { x: s.pos.x + r.x * 0.9, z: s.pos.z + r.z * 0.9 };
  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(center.x, base, center.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.heading),
    new THREE.Vector3(1, 1, 1),
  );
  const part = (w: number, hh: number, d: number, x: number, y: number, z: number, color: string, side = color) => {
    const m = new THREE.Matrix4().makeTranslation(x, y, z).premultiply(frame);
    mb.add(new THREE.BoxGeometry(w, hh, d), m, color, side);
  };
  part(4, 2.3, 0.08, 0, 1.15, 0.8, '#a9c7d6'); // back glass
  part(4.4, 0.12, 1.9, 0, 2.4, 0, '#2c5aa0'); // roof
  part(3.2, 0.08, 0.45, 0, 0.5, 0.45, '#8a6a45'); // bench
  for (const x of [-1.95, 1.95]) part(0.1, 2.35, 0.1, x, 1.18, 0.8, '#555');
  part(0.08, 3.2, 0.08, 2.5, 1.6, -0.4, '#666'); // sign pole
  part(0.7, 0.7, 0.06, 2.5, 3.0, -0.4, '#1f5fbf', '#1f5fbf'); // sign
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.heading);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(2.1, 1.25, 0.12)
      .setTranslation(center.x + r.x * 0.8, base + 1.25, center.z + r.z * 0.8)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    fixed,
  );
}

function prismPoints(footprint: Vec2[], y0: number, y1: number): Float32Array {
  return new Float32Array(footprint.flatMap((p) => [p.x, y0, p.z, p.x, y1, p.z]));
}

/** Convex hull points for a ramp (wedge) or speed hump (arched profile), draped on the ground. */
function featurePoints(f: Feature, h: (p: Vec2) => number): THREE.Vector3[] {
  const fw = forward(f.heading);
  const rt = right(f.heading);
  const base = h(f.pos);
  const w = (along: number, y: number, across: number) =>
    new THREE.Vector3(f.pos.x + fw.x * along + rt.x * across, base + y, f.pos.z + fw.z * along + rt.z * across);
  const pts: THREE.Vector3[] = [];
  const half = f.length / 2;
  for (const side of [-f.width / 2, f.width / 2]) {
    if (f.kind === 'ramp') {
      pts.push(w(-half, 0, side), w(half, 0, side), w(half, f.height, side), w(-half, -0.3, side), w(half, -0.3, side));
    } else {
      for (let k = 0; k <= 8; k++) {
        const t = -half + (k / 8) * f.length;
        pts.push(w(t, (f.height * (1 + Math.cos((Math.PI * t) / half))) / 2, side));
      }
      pts.push(w(-half, -0.3, side), w(half, -0.3, side));
    }
  }
  return pts;
}

