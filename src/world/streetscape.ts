import * as THREE from 'three';
import { RAPIER } from '../physics/world';
import type { CityData, Vec2 } from './cityData';
import { groundHeightAt, inPlayArea, stopZone } from './cityData';
import { distToPolyline } from './geom';
import { BuildingIndex } from './facades';
import { type ChunkedMeshBuilder, ChunkedUVQuadBuilder, InstancedTiles, MeshBuilder, hash2, vertexColorMaterial } from './meshBuilder';
import type { RoadGraph } from './roadGraph';
import type { RoadIndex } from './roadIndex';
import type { SidewalkSection } from './sidewalks';
import type { Lighting } from './sky';

/** Lamp: pole height, and how far its arm reaches out over the street. */
const LAMP_HEIGHT = 7.6;
const LAMP_REACH = 1.85;
/** Radius of the pool of light a lamp casts on the ground at night. */
const POOL = 6.5;
/** Trees and lamps are cheap to draw: big tiles, few draw calls. */
const TILE = 500;

type TreeKind = 'broad' | 'conifer';
/** Crown colors (instance tints over a light gray crown): greens, and Quito's purple jacarandas. */
const LEAVES = ['#6fae4c', '#5d9c45', '#7cb356', '#6aa04a'];
const JACARANDA = '#b48ae6';

export interface StreetscapeContext {
  city: CityData;
  graph: RoadGraph;
  sections: SidewalkSection[][];
  roads: RoadIndex;
  avenues: RoadIndex;
  /** Roads on bridges, in underpasses or on their ramps: nothing stands near them. */
  lifted: RoadIndex;
  buildings: BuildingIndex;
  /** Height of the drawn ground (draped layers) at a point. */
  ground: (p: Vec2) => number;
  /** Where lamp bulbs go: the glowing layer when they're on. */
  bulbs: ChunkedMeshBuilder;
  light: Lighting;
  /** Other street furniture (traffic light poles): nothing stands within 2 m. */
  keepClear?: Vec2[];
  world: RAPIER.World;
  fixed: RAPIER.RigidBody;
}

/**
 * Trees and street lamps. OSM trees (and the park trees scattered at import) stand where the
 * data puts them; avenues get rows of trees (some of them jacarandas) and lamps on both
 * sidewalks, side streets lamps on one side and trees only on some. Nothing is placed on
 * asphalt, junctions or crossings, near stops, stations, Metro entrances, ramps, or the map
 * edge. Trunks and poles are solid (a cylinder the size of the drawn trunk or pole); crowns,
 * lamp arms and light are not. All of it is instanced, by tiles.
 */
export function addStreetscape(ctx: StreetscapeContext): THREE.Mesh[] {
  const { city, light } = ctx;
  const trees = new InstancedTiles<TreeKind>(
    {
      broad: { geometry: treeGeometry('broad'), material: vertexColorMaterial(), shadow: true },
      conifer: { geometry: treeGeometry('conifer'), material: vertexColorMaterial(), shadow: true },
    },
    TILE,
  );
  const lamps = new InstancedTiles<'pole'>({ pole: { geometry: lampGeometry(), material: vertexColorMaterial() } }, TILE);
  const bulb = new THREE.BoxGeometry(0.55, 0.05, 0.26).translate(LAMP_REACH, LAMP_HEIGHT - 0.23, 0);
  const hulls = new BuildingIndex(ctx.graph.nodes.filter((n) => n.hull).map((n) => n.hull!), 40);
  const placed = new SpotIndex();
  const color = new THREE.Color();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);

  const plantTree = (p: Vec2, kind: TreeKind | 'jacaranda', s: number) => {
    const base = groundHeightAt(city, p);
    const r = hash2(p.x, p.z, 3);
    q.setFromAxisAngle(up, r * Math.PI * 2);
    const flat = kind === 'jacaranda' ? 0.88 : 1;
    m.compose(new THREE.Vector3(p.x, base, p.z), q, new THREE.Vector3(s, s * flat * (0.9 + hash2(p.x, p.z, 4) * 0.25), s));
    color.set(kind === 'jacaranda' ? JACARANDA : kind === 'conifer' ? '#ffffff' : LEAVES[Math.floor(r * LEAVES.length)]).multiplyScalar(0.9 + r * 0.2);
    trees.add(kind === 'jacaranda' ? 'broad' : kind, m, color);
    ctx.world.createCollider(RAPIER.ColliderDesc.cylinder(1.6 * s, 0.26 * s).setTranslation(p.x, base + 1.3 * s, p.z), ctx.fixed);
    placed.add(p, 'tree');
  };

  for (const t of city.trees) {
    const r = hash2(t.x, t.z, 1);
    plantTree(t, r < 0.55 ? 'broad' : r < 0.82 ? 'conifer' : 'jacaranda', 0.8 + hash2(t.x, t.z, 2) * 0.5);
  }

  // What a tree or lamp on the sidewalk must keep clear of.
  const stops = city.stops.flatMap((s) => [s.pos, stopZone(s)]);
  const free = (p: Vec2, pad: number) =>
    inPlayArea(city, p, 4) &&
    hulls.distance(p) > 4.5 &&
    ctx.lifted.clearance(p) > 10 &&
    stops.every((s) => Math.hypot(p.x - s.x, p.z - s.z) > 7) &&
    (city.stations ?? []).every((s) => Math.hypot(p.x - s.pos.x, p.z - s.pos.z) > s.length / 2 + 4) &&
    (city.metro ?? []).every((e) => Math.hypot(p.x - e.pos.x, p.z - e.pos.z) > 7) &&
    (city.monuments ?? []).every((e) => Math.hypot(p.x - e.pos.x, p.z - e.pos.z) > 20) &&
    city.props.every((pr) => Math.hypot(p.x - pr.pos.x, p.z - pr.pos.z) > 2) &&
    (ctx.keepClear ?? []).every((q) => Math.hypot(p.x - q.x, p.z - q.z) > 2) &&
    (city.walls ?? []).every((w) => distToPolyline(p, w.points) > 1) &&
    ctx.buildings.distance(p) > pad;

  const pools = light.pools ? new ChunkedUVQuadBuilder(250) : null;
  const addLamp = (p: Vec2, toRoad: Vec2) => {
    const base = groundHeightAt(city, p);
    q.setFromAxisAngle(up, Math.atan2(-toRoad.z, toRoad.x));
    m.compose(new THREE.Vector3(p.x, base, p.z), q, new THREE.Vector3(1, 1, 1));
    lamps.add('pole', m);
    ctx.bulbs.at(p.x, p.z).add(bulb, m, light.lamps ? '#ffe3ae' : '#c9ccce');
    ctx.world.createCollider(RAPIER.ColliderDesc.cylinder(LAMP_HEIGHT / 2, 0.11).setTranslation(p.x, base + LAMP_HEIGHT / 2, p.z), ctx.fixed);
    placed.add(p, 'lamp');
    if (pools) pool(pools, { x: p.x + toRoad.x * LAMP_REACH * 0.8, z: p.z + toRoad.z * LAMP_REACH * 0.8 }, ctx.ground);
  };

  for (const run of ctx.sections) {
    const mid = run[Math.floor(run.length / 2)];
    const side = Math.sign(mid.from);
    const avenue = ctx.avenues.clearance(mid.p) < 0;
    const key = hash2(Math.round(mid.p.x), Math.round(mid.p.z), 9);
    // Side streets: lamps on one side only, trees only on some.
    const lampsHere = avenue || (side > 0) === key < 0.5;
    const treesHere = avenue || key < 0.25 || key > 0.8;
    const lampEvery = avenue ? 28 : 36;
    const treeEvery = avenue ? 11 : 15;
    let s = 0;
    let nextLamp = lampEvery * (0.3 + key * 0.4);
    let nextTree = treeEvery * 0.5;
    for (let i = 0; i < run.length; i++) {
      const sec = run[i];
      if (i > 0) s += Math.hypot(sec.p.x - run[i - 1].p.x, sec.p.z - run[i - 1].p.z);
      const w = Math.abs(sec.to - sec.from);
      const at = (off: number): Vec2 => ({ x: sec.p.x - sec.dir.z * off, z: sec.p.z + sec.dir.x * off });
      const toRoad = { x: sec.dir.z * side, z: -sec.dir.x * side };
      if (lampsHere && s >= nextLamp && w >= 0.9) {
        const p = at(sec.from + side * 0.45);
        if (ctx.roads.clearance(p) > 0.3 && !placed.near(p, 3) && free(p, 0.6)) {
          addLamp(p, toRoad);
          nextLamp = s + lampEvery;
        }
      }
      if (treesHere && s >= nextTree && w >= 1.5) {
        // On a wide sidewalk away from the curb (crowns clear of the bus), else mid-strip.
        const off = w >= 2.4 ? 1.35 : w / 2;
        const p = at(sec.from + side * off);
        const k = hash2(p.x, p.z, 5);
        if (k > 0.12 && ctx.roads.clearance(p) > 0.5 && !placed.near(p, 4) && free(p, 1.8)) {
          plantTree(p, avenue && k < 0.4 ? 'jacaranda' : 'broad', 0.9 + k * 0.25);
          nextTree = s + treeEvery * (0.85 + k * 0.3);
        }
      }
    }
  }

  const out: THREE.Mesh[] = [...trees.build(), ...lamps.build()];
  if (pools) {
    const mat = new THREE.MeshBasicMaterial({
      map: glowTexture(),
      color: '#ffcf87',
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    for (const mesh of pools.build(mat)) {
      mesh.renderOrder = 1;
      out.push(mesh);
    }
  }
  return out;
}

/** A pool of lamp light on the ground: a small grid draped over it. */
function pool(b: ChunkedUVQuadBuilder, c: Vec2, ground: (p: Vec2) => number): void {
  const N = 4;
  const mb = b.at(c.x, c.z);
  const v = (i: number, j: number) => {
    const x = c.x - POOL + (2 * POOL * i) / N;
    const z = c.z - POOL + (2 * POOL * j) / N;
    return { x, y: ground({ x, z }) + 0.12, z };
  };
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) mb.quad(v(i, j), v(i, j + 1), v(i + 1, j + 1), v(i + 1, j), [j / N, i / N, (j + 1) / N, (i + 1) / N]); // facing up
}

/** Soft round falloff (white in the middle, black at the rim), built in code so it works headless. */
export function glowTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2;
      const v = Math.round(255 * Math.max(0, 1 - d) ** 1.6);
      data.set([v, v, v, 255], (y * size + x) * 4);
    }
  const tex = new THREE.DataTexture(data, size, size);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Low-poly trees, base at the origin (sunk a little for slopes), crowns well over a bus roof. */
function treeGeometry(kind: TreeKind): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const at = (y: number) => new THREE.Matrix4().makeTranslation(0, y, 0);
  if (kind === 'conifer') {
    mb.add(new THREE.CylinderGeometry(0.15, 0.26, 3.0, 5), at(1.2), '#5e4128');
    mb.add(new THREE.ConeGeometry(1.5, 6.2, 7), at(5.4), '#3f6b3a', '#355d31');
  } else {
    // Gray crown: each tree's own color comes from its instance tint (which darkens the trunk a bit).
    mb.add(new THREE.CylinderGeometry(0.15, 0.26, 3.9, 5), at(1.65), '#a07a58');
    mb.add(new THREE.IcosahedronGeometry(2.0, 0), at(5.1).multiply(new THREE.Matrix4().makeScale(1.05, 0.8, 1.05)), '#d8d8d8', '#b0b0b0');
  }
  return mb.build();
}

/** Street lamp, pole at the origin, arm out along +x toward the street. */
function lampGeometry(): THREE.BufferGeometry {
  const mb = new MeshBuilder();
  const at = (x: number, y: number) => new THREE.Matrix4().makeTranslation(x, y, 0);
  mb.add(new THREE.CylinderGeometry(0.07, 0.11, LAMP_HEIGHT + 0.3, 6), at(0, (LAMP_HEIGHT - 0.3) / 2), '#5d6166');
  mb.add(new THREE.BoxGeometry(LAMP_REACH, 0.08, 0.08), at(LAMP_REACH / 2, LAMP_HEIGHT - 0.05), '#5d6166');
  mb.add(new THREE.BoxGeometry(0.7, 0.16, 0.32), at(LAMP_REACH, LAMP_HEIGHT - 0.12), '#43474b');
  return mb.build();
}

/** Grid-hashed points already taken by a tree or lamp. */
class SpotIndex {
  private cells = new Map<string, Vec2[]>();

  add(p: Vec2, _what: 'tree' | 'lamp'): void {
    const key = `${Math.floor(p.x / 8)},${Math.floor(p.z / 8)}`;
    const list = this.cells.get(key);
    if (list) list.push(p);
    else this.cells.set(key, [p]);
  }

  near(p: Vec2, r: number): boolean {
    const cx = Math.floor(p.x / 8);
    const cz = Math.floor(p.z / 8);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let z = cz - 1; z <= cz + 1; z++) for (const q of this.cells.get(`${x},${z}`) ?? []) if (Math.hypot(p.x - q.x, p.z - q.z) < r) return true;
    return false;
  }
}
