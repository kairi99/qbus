import { Rng } from '../../core/rng';
import type { Building, CityData, Feature, Horizon, Prop, Road, Stop, Vec2 } from '../cityData';
import { forward, inPlayArea, right, stopZone } from '../cityData';
import { distToPolyline, pointInPolygon, polygonToPolylineDistance } from '../geom';
import { type Terrain, smoothHeights } from '../terrain';
import { buildRoadGraph, dirAt, projectOnPath } from '../roadGraph';
import { importLines } from './lines';
import { importStations, widenMedians } from './stations';
import { importCampuses } from './campus';
import { CLEARANCE, type Level, separateGrades } from './grades';
import { liftAlong, projectOnRoad } from '../elevation';

/** Subset of the Overpass JSON (`out geom;`) we use. */
export interface OsmJson {
  elements: OsmElement[];
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; ref?: number; role: string; lat?: number; lon?: number; geometry?: { lat: number; lon: number }[] }[];
}

/** Elevation raster in lat/lon (row 0 = north edge). */
export interface Dem {
  lon0: number;
  lat0: number;
  dLon: number;
  /** Negative: latitude decreases with row. */
  dLat: number;
  cols: number;
  rows: number;
  values: ArrayLike<number>;
}

export interface ImportOptions {
  name: string;
  /** south, west, north, east */
  bbox: [number, number, number, number];
  seed?: number;
  terrainCell?: number;
  /** Extra terrain beyond the city so the edges aren't a cliff. */
  terrainMargin?: number;
  /** Gaussian-ish smoothing radius, meters (removes buildings/trees baked into the DSM). */
  smoothing?: number;
  /** OSM way ids to leave out (known mapping errors). */
  dropWays?: number[];
}

const SIDEWALK = 3;
const LANE = 3.3;
const FLOOR = 3.2;
/** One tree per this many square meters of park. */
const PARK_TREE_AREA = 110;
const BUILDING_CLEARANCE = 1.5;

/** Drivable road classes and their defaults. */
const ROAD_CLASSES: Record<string, { lanes: number; onewayLanes: number; kind: Road['kind'] }> = {
  trunk: { lanes: 4, onewayLanes: 3, kind: 'avenue' },
  primary: { lanes: 4, onewayLanes: 3, kind: 'avenue' },
  secondary: { lanes: 2, onewayLanes: 2, kind: 'street' },
  tertiary: { lanes: 2, onewayLanes: 2, kind: 'street' },
  unclassified: { lanes: 2, onewayLanes: 1, kind: 'street' },
  residential: { lanes: 2, onewayLanes: 2, kind: 'street' },
  living_street: { lanes: 2, onewayLanes: 1, kind: 'street' },
  trunk_link: { lanes: 1, onewayLanes: 1, kind: 'street' },
  primary_link: { lanes: 1, onewayLanes: 1, kind: 'street' },
  secondary_link: { lanes: 1, onewayLanes: 1, kind: 'street' },
  tertiary_link: { lanes: 1, onewayLanes: 1, kind: 'street' },
};

const WALLS = ['#f2e8d5', '#e9d3b4', '#d8e2dc', '#f4c7a1', '#c9d6e8', '#f0d98c', '#e6b8b8', '#fbfaf5', '#cfd8c4', '#b9c4cc'];
const TERRACOTTA = '#b5563a';
const CONCRETE_ROOF = '#9a9a96';

/** Equirectangular projection around the bbox center: x = east, z = south, meters. */
export function makeProjection(bbox: [number, number, number, number]) {
  const lat0 = (bbox[0] + bbox[2]) / 2;
  const lon0 = (bbox[1] + bbox[3]) / 2;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mz = 110574;
  return {
    toXZ: (lat: number, lon: number): Vec2 => ({ x: (lon - lon0) * mx, z: -(lat - lat0) * mz }),
    toLatLon: (p: Vec2) => ({ lat: lat0 - p.z / mz, lon: lon0 + p.x / mx }),
  };
}

/** Converts Overpass data + a DEM into a drivable CityData. */
/** Optional extra data for a zone: Overpass downloads (see tools/fetch-osm.ts) and a wide DEM. */
export interface ExtraData {
  /** Bus route relations: real lines. */
  routes?: OsmJson;
  /** Rapid-transit stop positions and Metro stations (needs `routes`). */
  stations?: OsmJson;
  /** Campus grounds that get walls. */
  areas?: OsmJson;
  /** Elevation covering `HORIZON_HALF` meters around the zone: the view's far terrain. */
  horizonDem?: Dem;
}

/** The far terrain reaches this far from the zone's center, in cells this big. */
export const HORIZON_HALF = 13000;
const HORIZON_CELL = 100;

/** Landmarks seen from anywhere in Quito (`summit`: meters above sea level, for volcanoes). */
const LANDMARKS: { kind: 'virgen' | 'volcano'; name: string; lat: number; lon: number; summit?: number }[] = [
  // OSM way 302694122, "La Virgen de El Panecillo".
  { kind: 'virgen', name: 'Virgen del Panecillo', lat: -0.22885, lon: -78.51858 },
  { kind: 'volcano', name: 'Cotopaxi', lat: -0.6804, lon: -78.4378, summit: 5897 },
  { kind: 'volcano', name: 'Antisana', lat: -0.4814, lon: -78.1414, summit: 5704 },
  { kind: 'volcano', name: 'Cayambe', lat: 0.0292, lon: -77.9864, summit: 5790 },
];

/** The map edge is closed off this far in (roadworks), so its end is never in reach. */
const EDGE_INSET = 70;

export function importOsm(source: OsmJson, dem: Dem, opts: ImportOptions, extra: ExtraData = {}): CityData {
  const { routes: routesOsm, stations: stationsOsm, areas: areasOsm } = extra;
  const drop = new Set(opts.dropWays ?? []);
  const osm = drop.size ? { ...source, elements: source.elements.filter((e) => !(e.type === 'way' && drop.has(e.id))) } : source;
  const rng = new Rng(opts.seed ?? 1);
  const proj = makeProjection(opts.bbox);
  const sw = proj.toXZ(opts.bbox[0], opts.bbox[1]);
  const ne = proj.toXZ(opts.bbox[2], opts.bbox[3]);
  const bounds = { min: { x: sw.x, z: ne.z }, max: { x: ne.x, z: sw.z } };
  const inside = (p: Vec2, pad = 0) =>
    p.x >= bounds.min.x - pad && p.x <= bounds.max.x + pad && p.z >= bounds.min.z - pad && p.z <= bounds.max.z + pad;

  // Median stations need room between the carriageways: make it before anything else uses the roads.
  const flat =
    stationsOsm && routesOsm
      ? widenMedians(importRoads(osm, proj.toXZ, bounds), stationsOsm, routesOsm, proj.toXZ, (p) => inside(p))
      : importRoads(osm, proj.toXZ, bounds);
  // Bridges go up and underpasses down, with ramps; roads on different levels don't meet.
  // Then again with every junction's paved area (as the road graph clusters and trims them)
  // kept level on the ramps that run into it, until none still climbs there. One that would
  // cost a crossing (no room left for a ramp: the roads would meet at grade) isn't kept, and
  // past the play area's edge (nobody drives there) nothing is reshaped.
  const playBox = { playArea: { min: { x: bounds.min.x + EDGE_INSET, z: bounds.min.z + EDGE_INSET }, max: { x: bounds.max.x - EDGE_INSET, z: bounds.max.z - EDGE_INSET } } };
  let { roads, crossings } = separateGrades(flat);
  const level: Level[] = [];
  const tried = new Set<string>();
  const key = (l: Level) => `${l.road}@${l.area.map((p) => `${p.x.toFixed(0)},${p.z.toFixed(0)}`).join(';')}`;
  for (let pass = 0; pass < 3; pass++) {
    const more = rampsIntoJunctions(roads).filter((l) => !tried.has(key(l)) && l.area.some((p) => inPlayArea(playBox, p)));
    if (!more.length) break;
    for (const l of more) {
      tried.add(key(l));
      const next = separateGrades(flat, [...level, l]);
      if (next.crossings.length < crossings.length) continue;
      // Nor one that folds a ramp into a sharp V or crest (a long bus high-centers on it).
      if (next.roads.some((r, i) => r !== roads[i] && sharpestBend(r) > Math.max(sharpestBend(roads[i]), MAX_BEND) + 0.01)) continue;
      level.push(l);
      ({ roads, crossings } = next);
    }
  }
  for (const c of crossings)
    if (c.gap < CLEARANCE * 0.8) console.warn(`grade crossing squeezed to ${c.gap.toFixed(1)} m: ${roads[c.upper].name} over ${roads[c.lower].name}`);
  // Junction areas are paved (the game draws them as asphalt): nothing may stand on them.
  const hulls = buildRoadGraph({ roads } as CityData)
    .nodes.filter((n) => n.hull)
    .map((n) => n.hull!);
  const onJunction = (p: Vec2) => hulls.some((h) => pointInPolygon(p, h));
  const { terrain, base } = buildTerrain(dem, proj.toLatLon, bounds, roads, opts);
  const far = extra.horizonDem;
  const horizon = far ? buildHorizon(far, proj.toLatLon, base) : undefined;
  const landmarks = far
    ? LANDMARKS.map((l) => ({ kind: l.kind, name: l.name, pos: proj.toXZ(l.lat, l.lon), y: round((l.summit ?? sampleDem(far, l.lat, l.lon)) - base, 1) }))
    : undefined;
  const buildings = importBuildings(osm, proj.toXZ, inside, roads, rng).filter(
    (b) => !b.footprint.some(onJunction) && !hulls.some((h) => h.some((q) => pointInPolygon(q, b.footprint))),
  );
  const playArea = {
    min: { x: bounds.min.x + EDGE_INSET, z: bounds.min.z + EDGE_INSET },
    max: { x: bounds.max.x - EDGE_INSET, z: bounds.max.z - EDGE_INSET },
  };
  const playable = (p: Vec2) => inPlayArea({ playArea }, p, 15);
  let stops = importStops(osm, proj.toXZ, inside, roads, buildings).filter((st) => !onJunction(st.pos) && playable(st.pos));
  const transit =
    stationsOsm && routesOsm ? importStations(stationsOsm, routesOsm, { toXZ: proj.toXZ, roads, buildings, onJunction, inside: playable }) : undefined;
  // Keep station platforms and Metro canopies free of shelters, trees and street furniture.
  const occupied = (p: Vec2, pad: number) =>
    !!transit &&
    (transit.stations.some((s) => inFootprint(p, s.pos, s.heading, s.length / 2 + pad, s.width / 2 + pad)) ||
      transit.metro.some((m) => Math.hypot(p.x - m.pos.x, p.z - m.pos.z) < 4 + pad));
  if (transit) stops = [...stops.filter((st) => !occupied(st.pos, 3)), ...transit.stops];
  // Stops only count where a bus can get to them: on a lane going their way that traffic
  // (and route planning) uses. Near the roadworks some streets are closed.
  const graph = buildRoadGraph({ roads, playArea } as CityData);
  const servable = (st: Stop) => {
    const z = stopZone(st);
    const f = forward(st.heading);
    return graph.edges.some((e) => {
      if (!e.drivable) return false;
      const { s, d } = projectOnPath(e.center, z);
      const dir = dirAt(e.center, s);
      return d < 10 && dir.x * f.x + dir.z * f.z > 0.5;
    });
  };
  // ...and not on a ramp, bridge or underpass (a shelter can't stand there).
  stops = stops.filter((st) => servable(st) && !nearLifted(roads, stopZone(st), 6));
  const walls = areasOsm
    ? importCampuses(areasOsm, {
        toXZ: proj.toXZ,
        roads,
        buildings,
        onJunction,
        inside: (p) => inside(p),
        keepClear: (p) => occupied(p, 1) || stops.some((st) => Math.hypot(p.x - st.pos.x, p.z - st.pos.z) < 4.5),
      })
    : undefined;
  const greens = osm.elements.filter((e) => e.type === 'way' && e.geometry && (e.tags?.leisure || e.tags?.landuse));
  const ringOf = (e: OsmElement) => closedRing(e.geometry!.map((g) => proj.toXZ(g.lat, g.lon)));
  const parks = greens.map(ringOf).filter((ring) => ring.length >= 3 && ring.some((p) => inside(p)));
  const blockedByBuilding = (p: Vec2) => buildings.some((b) => pointInPolygon(p, b.footprint));
  const offRoad = (p: Vec2, margin: number) => roads.every((r) => distToPolyline(p, r.points) > r.width / 2 + margin);
  const treeSpots = osm.elements.filter((e) => e.type === 'node' && e.tags?.natural === 'tree').map((e) => proj.toXZ(e.lat!, e.lon!));
  // Parks and gardens get trees scattered over them (not pitches or courts), from their own
  // seed so nothing else in the city moves.
  const parkRng = new Rng((opts.seed ?? 1) + 7919);
  for (const e of greens) {
    const t = e.tags!;
    if (!(t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'recreation_ground')) continue;
    const ring = ringOf(e);
    if (ring.length < 3) continue;
    const xs = ring.map((p) => p.x);
    const zs = ring.map((p) => p.z);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const n = Math.min(200, Math.round(Math.abs(area(ring)) / PARK_TREE_AREA));
    for (let i = 0; i < n; i++) {
      const p = { x: parkRng.range(x0, x1), z: parkRng.range(z0, z1) };
      if (pointInPolygon(p, ring) && distToPolyline(p, [...ring, ring[0]]) > 2) treeSpots.push(p);
    }
  }
  const trees: Vec2[] = [];
  for (const p of treeSpots)
    if (inside(p) && offRoad(p, 0.8) && !blockedByBuilding(p) && !onJunction(p) && !occupied(p, 2) && !nearLifted(roads, p, 4) && trees.every((q) => Math.hypot(p.x - q.x, p.z - q.z) > 2.5))
      trees.push(p);
  // Props and humps roll their dice per road segment (seeded by where it starts), so adding or
  // dropping a way only moves what's on it, not furniture all over the city.
  const props = scatterProps(roads, stops, buildings, opts.seed ?? 1, inside).filter((pr) => !onJunction(pr.pos) && !occupied(pr.pos, 1) && !nearLifted(roads, pr.pos, 4));
  // Humps only where the game happens, and never on a ramp, bridge or underpass.
  // Humps also keep well clear of a ramp's ends along the road (a car comes off the top of a
  // ramp pitched up and fast): nearLifted only looks across the lifted stretch.
  const features = placeFeatures(roads, opts.seed ?? 1).filter((f) => playable(f.pos) && !nearLifted(roads, f.pos, 20) && !nearRampPoint(roads, f.pos, 25));
  const spawn = pickSpawn(roads.filter((r) => !r.lift), bounds);

  return {
    name: opts.name,
    roads,
    blocks: [],
    buildings,
    stops,
    features,
    props,
    trees,
    spawn,
    bounds,
    terrain,
    parks,
    lines: routesOsm ? importLines(routesOsm, proj.toXZ, stops) : undefined,
    stations: transit?.stations,
    metro: transit?.metro,
    playArea,
    walls,
    horizon,
    landmarks,
    attribution: '© OpenStreetMap contributors (ODbL); elevation: Copernicus GLO-30 DEM',
  };
}

/** Inside a rectangle centered at `c`, `halfL` along `heading` and `halfW` across. */
/** Steepest change of grade a ramp may get from keeping it level at a junction (one where a ramp starts at its foot). */
const MAX_BEND = 0.16;

/** Biggest change of grade of a road's lift over a bus's length (two 6 m stretches). */
function sharpestBend(r: Road): number {
  if (!r.lift) return 0;
  let len = 0;
  for (let i = 1; i < r.points.length; i++) len += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].z - r.points[i - 1].z);
  let worst = 0;
  for (let s = 0; s + 12 <= len; s += 1) {
    const [a, b, c] = [liftAlong(r, s), liftAlong(r, s + 6), liftAlong(r, s + 12)];
    worst = Math.max(worst, Math.abs((c - b) / 6 - (b - a) / 6));
  }
  return worst;
}

/** Roads whose ramp is still off street level where it runs into a junction at street level, with that junction's paved area. */
function rampsIntoJunctions(roads: Road[]): Level[] {
  const graph = buildRoadGraph({ roads } as CityData);
  const out: Level[] = [];
  for (const n of graph.nodes) {
    if (!n.hull || Math.abs(n.lift) > 0.3) continue;
    const ends = [...n.in.map((id) => [id, -1] as const), ...n.out.map((id) => [id, 0] as const)];
    for (const [id, at] of ends) {
      const e = graph.edges[id];
      if (e.lift && Math.abs(e.lift.at(at)!) > 0.05 && !out.some((l) => l.road === e.roadIndex && l.area === n.hull)) out.push({ road: e.roadIndex, area: n.hull });
    }
  }
  return out;
}

function inFootprint(p: Vec2, c: Vec2, heading: number, halfL: number, halfW: number): boolean {
  const f = { x: Math.cos(heading), z: -Math.sin(heading) };
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  return Math.abs(dx * f.x + dz * f.z) <= halfL && Math.abs(dx * f.z - dz * f.x) <= halfW;
}

function importRoads(osm: OsmJson, toXZ: (lat: number, lon: number) => Vec2, bounds: { min: Vec2; max: Vec2 }): Road[] {
  const roads: Road[] = [];
  for (const e of osm.elements) {
    const t = e.tags ?? {};
    const cls = ROAD_CLASSES[t.highway];
    if (e.type !== 'way' || !cls || !e.geometry || t.area === 'yes' || t.tunnel === 'building_passage') continue;
    // Bridges and underpasses sit on their own level (see grades.ts); `layer` alone means nothing.
    const layer = t.bridge && t.bridge !== 'no' ? Number(t.layer) || 1 : t.tunnel && t.tunnel !== 'no' ? Number(t.layer) || -1 : 0;
    let pts = e.geometry.map((g) => toXZ(g.lat, g.lon));
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || t.junction === 'roundabout';
    if (t.oneway === '-1') pts.reverse();
    const lanes = clampInt(t.lanes, 1, 6) ?? (oneway ? cls.onewayLanes : cls.lanes);
    const width = oneway ? Math.max(6, lanes * LANE + 1) : Math.max(7, lanes * LANE + 1);
    for (const piece of clipPolyline(simplify(pts, 0.4), bounds)) {
      if (length(piece) < 3) continue;
      roads.push({
        name: shortName(t.name ?? t.ref ?? 'Calle sin nombre'),
        kind: lanes >= 4 || (cls.kind === 'avenue' && !oneway) ? 'avenue' : 'street',
        points: piece,
        width: round(width, 1),
        lanes,
        oneway,
        ...(layer ? { layer } : {}),
      });
    }
  }
  return roads;
}

/** Smoothed, city-relative heights, flattened across every road so streets are level side to side. */
function buildTerrain(
  dem: Dem,
  toLatLon: (p: Vec2) => { lat: number; lon: number },
  bounds: { min: Vec2; max: Vec2 },
  roads: Road[],
  opts: ImportOptions,
): { terrain: Terrain; base: number } {
  const cell = opts.terrainCell ?? 8;
  const margin = opts.terrainMargin ?? 400;
  const minX = Math.floor((bounds.min.x - margin) / cell) * cell;
  const minZ = Math.floor((bounds.min.z - margin) / cell) * cell;
  const cols = Math.ceil((bounds.max.x + margin - minX) / cell) + 1;
  const rows = Math.ceil((bounds.max.z + margin - minZ) / cell) + 1;
  const raw: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const { lat, lon } = toLatLon({ x: minX + c * cell, z: minZ + r * cell });
      raw.push(sampleDem(dem, lat, lon));
    }
  const radius = Math.max(1, Math.round((opts.smoothing ?? 40) / cell / 1.7));
  const smooth = smoothHeights(raw, cols, rows, radius, 3);
  const t: Terrain = { minX, minZ, cell, cols, rows, heights: smooth, scale: 1 };

  // Carve: every vertex under a road (plus sidewalks and one cell) takes the height of the
  // nearest point on that road's centerline.
  const sample = (x: number, z: number) => bilinear(smooth, cols, rows, (x - minX) / cell, (z - minZ) / cell);
  const carved = smooth.slice();
  const bestD = new Array<number>(carved.length).fill(Infinity);
  for (const road of roads) {
    const reach = road.width / 2 + SIDEWALK + cell;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - minX) / cell));
      const c1 = Math.min(cols - 1, Math.ceil((Math.max(a.x, b.x) + reach - minX) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - minZ) / cell));
      const r1 = Math.min(rows - 1, Math.ceil((Math.max(a.z, b.z) + reach - minZ) / cell));
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const x = minX + c * cell;
          const z = minZ + r * cell;
          const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
          const px = a.x + u * dx;
          const pz = a.z + u * dz;
          const d = Math.hypot(x - px, z - pz);
          const k = r * cols + c;
          if (d <= reach && d < bestD[k]) {
            bestD[k] = d;
            carved[k] = sample(px, pz);
          }
        }
    }
  }
  // City-relative: the lowest point inside the city is 0.
  let base = Infinity;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = minX + c * cell;
      const z = minZ + r * cell;
      if (x >= bounds.min.x && x <= bounds.max.x && z >= bounds.min.z && z <= bounds.max.z) base = Math.min(base, carved[r * cols + c]);
    }
  t.heights = carved.map((h) => round(h - base, 2));
  return { terrain: t, base };
}

/** Coarse real terrain around the zone, lightly averaged (the DSM has buildings in it). */
function buildHorizon(dem: Dem, toLatLon: (p: Vec2) => { lat: number; lon: number }, base: number): Horizon {
  const cell = HORIZON_CELL;
  const n = Math.round((2 * HORIZON_HALF) / cell) + 1;
  const heights: number[] = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const x = -HORIZON_HALF + c * cell;
      const z = -HORIZON_HALF + r * cell;
      let sum = 0;
      for (const dx of [-cell / 3, 0, cell / 3])
        for (const dz of [-cell / 3, 0, cell / 3]) {
          const { lat, lon } = toLatLon({ x: x + dx, z: z + dz });
          sum += sampleDem(dem, lat, lon);
        }
      heights.push(Math.round(sum / 9 - base));
    }
  return { minX: -HORIZON_HALF, minZ: -HORIZON_HALF, cell, cols: n, rows: n, heights };
}

function importBuildings(
  osm: OsmJson,
  toXZ: (lat: number, lon: number) => Vec2,
  inside: (p: Vec2) => boolean,
  roads: Road[],
  rng: Rng,
): Building[] {
  const out: Building[] = [];
  for (const e of osm.elements) {
    const t = e.tags ?? {};
    if (!t.building || t.building === 'roof') continue;
    const rings =
      e.type === 'way' && e.geometry
        ? [e.geometry]
        : (e.members ?? []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry!);
    for (const g of rings) {
      const ring = closedRing(g.map((p) => toXZ(p.lat, p.lon)));
      if (ring.length < 3 || Math.abs(area(ring)) < 12 || !inside(centroid(ring))) continue;
      // OSM footprints and road centerlines don't always agree; keep asphalt and the walking line
      // (1.1 m past the curb) clear.
      if (roads.some((r) => polygonToPolylineDistance(ring, r.points) < r.width / 2 + BUILDING_CLEARANCE)) continue;
      const levels = parseFloat(t['building:levels'] ?? '');
      const height = parseFloat(t.height ?? '');
      const floors = !isNaN(levels)
        ? Math.max(1, levels)
        : !isNaN(height)
          ? Math.max(1, Math.round(height / FLOOR))
          : defaultFloors(t.building, rng);
      out.push({
        footprint: area(ring) < 0 ? ring.reverse() : ring,
        height: round(!isNaN(height) ? height : floors * FLOOR, 1),
        color: rng.pick(WALLS),
        roof: floors <= 3 ? TERRACOTTA : CONCRETE_ROOF,
        ...(t.building !== 'yes' ? { use: t.building } : {}),
        ...(t.shop || t.amenity ? { shop: t.shop || t.amenity } : {}),
      });
    }
  }
  return out;
}

function defaultFloors(type: string, rng: Rng): number {
  switch (type) {
    case 'house':
    case 'detached':
      return rng.int(1, 2);
    case 'apartments':
      return rng.int(5, 10);
    case 'commercial':
    case 'office':
      return rng.int(3, 8);
    case 'retail':
      return rng.int(1, 3);
    default:
      return rng.int(2, 5);
  }
}

/** Bus stops snapped to the right-hand sidewalk of the road they serve. */
function importStops(
  osm: OsmJson,
  toXZ: (lat: number, lon: number) => Vec2,
  inside: (p: Vec2, pad?: number) => boolean,
  roads: Road[],
  buildings: Building[],
): Stop[] {
  const stops: Stop[] = [];
  for (const e of osm.elements) {
    if (e.type !== 'node' || e.tags?.highway !== 'bus_stop') continue;
    const raw = e.tags.name?.trim();
    if (raw && /metrob|trole|ecov/i.test(raw)) continue; // BRT platforms in the median
    // Some stops are just called "Bus" or "Parada": name those after the corner instead.
    const tidy = raw ? tidyStopName(raw) : '';
    const name = tidy && !/^(bus|parada|bus stop|parada de bus)$/i.test(tidy) && !/sin nombre/i.test(tidy) ? tidy : undefined;
    const p = toXZ(e.lat!, e.lon!);
    if (!inside(p, -40)) continue;
    const near = nearestOnRoads(roads.filter((r) => r.kind === 'avenue' || r.lanes >= 2), p);
    if (!near || near.dist > 30) continue;
    const { road, point, dir } = near;
    const along = Math.atan2(-dir.z, dir.x);
    // Two-way roads: serve the side the stop is mapped on. One-way: always travel direction.
    const leftSide = dir.x * (p.z - point.z) - dir.z * (p.x - point.x) < 0;
    const heading = !road.oneway && leftSide ? along + Math.PI : along;
    const r = right(heading);
    const d = road.width / 2 + 1.2;
    const pos = { x: point.x + r.x * d, z: point.z + r.z * d };
    const shelter = { x: pos.x + r.x * 0.9, z: pos.z + r.z * 0.9 };
    if (buildings.some((b) => pointInPolygon(shelter, b.footprint) || pointInPolygon(pos, b.footprint))) continue;
    if (stops.some((s) => Math.hypot(s.pos.x - pos.x, s.pos.z - pos.z) < 25)) continue;
    const cross = nearestOnRoads(
      roads.filter((o) => o.name !== road.name && !/sin nombre/i.test(o.name)),
      point,
    );
    stops.push({
      id: `osm${e.id}`,
      name: tidyStopName(name ?? (cross && cross.dist < 120 && !/sin nombre/i.test(road.name) ? `${road.name.replace(/^Av\. /, '')} y ${cross.road.name.replace(/^Av\. /, '')}` : `Parada ${road.name.replace(/^Av\. /, '')}`)),
      pos,
      heading: round(heading, 4),
    });
  }
  return stops;
}

/** Street furniture along the sidewalks: trash cans, fruit stands, the odd cluster of cones. */
function scatterProps(roads: Road[], stops: Stop[], buildings: Building[], seed: number, inside: (p: Vec2) => boolean): Prop[] {
  const props: Prop[] = [];
  const ok = (p: Vec2) =>
    inside(p) &&
    !buildings.some((b) => pointInPolygon(p, b.footprint)) &&
    roads.every((r) => distToPolyline(p, r.points) > r.width / 2 + 0.25) &&
    !stops.some((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < 7) &&
    !props.some((q) => Math.hypot(q.pos.x - p.x, q.pos.z - p.z) < 3);
  for (const road of roads) {
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const heading = Math.atan2(-dir.z, dir.x);
      const rng = new Rng(spotSeed(seed, a, b));
      for (let s = 8; s < len - 8; s += 18) {
        for (const side of [-1, 1]) {
          const roll = rng.next();
          if (roll > 0.28) continue;
          const r = right(heading);
          const at = (off: number) => ({ x: a.x + dir.x * s + r.x * side * off, z: a.z + dir.z * s + r.z * side * off });
          // Curb furniture sits just off the asphalt; fruit stands stand behind where people walk.
          const curb = at(road.width / 2 + 0.45);
          const stand = at(road.width / 2 + 2.3);
          if (roll < 0.24 && roll >= 0.12) {
            if (ok(stand) && ok(at(road.width / 2 + 1.75)) && ok(at(road.width / 2 + 2.85))) props.push({ kind: 'fruitStand', pos: stand, heading });
            continue;
          }
          const p = curb;
          if (!ok(p)) continue;
          if (roll < 0.12) props.push({ kind: 'trashcan', pos: p, heading: 0 });
          else
            for (let c = 0; c < 4; c++) {
              const q = { x: p.x + dir.x * c * 1.2, z: p.z + dir.z * c * 1.2 };
              if (ok(q)) props.push({ kind: 'cone', pos: q, heading: 0 });
            }
        }
      }
    }
  }
  return props;
}

/** A few speed humps on side streets and ramps on long straight ones (it's an arcade game). */
/** Within `margin` of a road's asphalt where it's off the ground (ramps, bridges, underpasses). */
function nearLifted(roads: Road[], p: Vec2, margin: number): boolean {
  return roads.some((r) => {
    if (!r.lift) return false;
    const { s, d } = projectOnRoad(r, p);
    return d < r.width / 2 + margin && Math.abs(liftAlong(r, s)) > 0.05;
  });
}

/** Within `reach` of any point of a road that's off the ground (a ramp, deck or cut). */
function nearRampPoint(roads: Road[], p: Vec2, reach: number): boolean {
  return roads.some((r) => r.lift && r.points.some((q, i) => Math.abs(r.lift![i]) > 0.05 && Math.hypot(q.x - p.x, q.z - p.z) < reach));
}

function placeFeatures(roads: Road[], seed: number): Feature[] {
  const out: Feature[] = [];
  for (const road of roads) {
    if (road.kind === 'avenue') continue;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 45) continue;
      const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const heading = Math.atan2(-dir.z, dir.x);
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      if (out.some((f) => Math.hypot(f.pos.x - mid.x, f.pos.z - mid.z) < 60)) continue;
      const roll = new Rng(spotSeed(seed + 104729, a, b)).next();
      // No ramps: real streets are too narrow for traffic to pass beside one.
      if (roll < 0.12) out.push({ kind: 'hump', pos: mid, heading, length: 3, width: road.width, height: 0.22 });
    }
  }
  return out;
}

/** A seed for the dice of one road segment, from its ends (rounded to the centimeter). */
function spotSeed(seed: number, a: Vec2, b: Vec2): number {
  let h = Math.imul(seed, 0x9e3779b1);
  for (const v of [a.x, a.z, b.x, b.z]) h = Math.imul(h ^ Math.round(v * 100), 0x85ebca6b) ^ (h >>> 13);
  return h >>> 0;
}

/** In the right-hand lane of Av. Amazonas nearest the middle of the map (or the longest avenue). */
function pickSpawn(roads: Road[], bounds: { min: Vec2; max: Vec2 }): { pos: Vec2; heading: number } {
  const center = { x: (bounds.min.x + bounds.max.x) / 2, z: (bounds.min.z + bounds.max.z) / 2 };
  const amazonas = roads.filter((r) => /Amazonas/.test(r.name));
  const pool = amazonas.length ? amazonas : roads.filter((r) => r.kind === 'avenue');
  const near = nearestOnRoads(pool.length ? pool : roads, center)!;
  let dir = near.dir;
  if (!near.road.oneway && dir.z > 0) dir = { x: -dir.x, z: -dir.z }; // head north when we can choose
  const heading = Math.atan2(-dir.z, dir.x);
  const r = right(heading);
  const off = near.road.oneway ? near.road.width / 2 - LANE / 2 - 0.5 : near.road.width / 4;
  return { pos: { x: near.point.x + r.x * off, z: near.point.z + r.z * off }, heading: round(heading, 4) };
}

// ---- small geometry helpers -------------------------------------------------

export function nearestOnRoads(roads: Road[], p: Vec2): { road: Road; point: Vec2; dir: Vec2; dist: number } | null {
  let best: { road: Road; point: Vec2; dir: Vec2; dist: number } | null = null;
  for (const road of roads)
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (len * len)));
      const point = { x: a.x + u * dx, z: a.z + u * dz };
      const dist = Math.hypot(p.x - point.x, p.z - point.z);
      if (!best || dist < best.dist) best = { road, point, dir: { x: dx / len, z: dz / len }, dist };
    }
  return best;
}

/** Keeps the parts of a polyline inside an axis-aligned rectangle. */
export function clipPolyline(pts: Vec2[], b: { min: Vec2; max: Vec2 }): Vec2[][] {
  const ins = (p: Vec2) => p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z;
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (ins(p)) {
      if (!cur.length && i > 0) cur.push(edgeHit(pts[i - 1], p, b));
      cur.push(p);
    } else if (cur.length) {
      cur.push(edgeHit(cur[cur.length - 1], p, b));
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out.filter((l) => l.length > 1);
}

/** Point where segment inside→outside (or outside→inside) crosses the rectangle border. */
function edgeHit(a: Vec2, c: Vec2, b: { min: Vec2; max: Vec2 }): Vec2 {
  let t = 1;
  const dx = c.x - a.x;
  const dz = c.z - a.z;
  for (const [v, d, lo, hi] of [
    [a.x, dx, b.min.x, b.max.x],
    [a.z, dz, b.min.z, b.max.z],
  ] as const) {
    if (d > 0 && v + d * t > hi) t = Math.min(t, (hi - v) / d);
    if (d < 0 && v + d * t < lo) t = Math.min(t, (lo - v) / d);
    if (d > 0 && v < lo) t = Math.min(t, (lo - v) / d);
    if (d < 0 && v > hi) t = Math.min(t, (hi - v) / d);
  }
  return { x: a.x + dx * Math.max(0, t), z: a.z + dz * Math.max(0, t) };
}

/** Douglas-Peucker. */
export function simplify(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1;
    let bestD = tol;
    for (let k = i + 1; k < j; k++) {
      const d = distToPolyline(pts[k], [pts[i], pts[j]]);
      if (d > bestD) (bestD = d), (best = k);
    }
    if (best >= 0) {
      keep[best] = true;
      stack.push([i, best], [best, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function sampleDem(dem: Dem, lat: number, lon: number): number {
  return bilinear(dem.values, dem.cols, dem.rows, (lon - dem.lon0) / dem.dLon - 0.5, (lat - dem.lat0) / dem.dLat - 0.5);
}

function bilinear(v: ArrayLike<number>, cols: number, rows: number, fx: number, fz: number): number {
  fx = Math.max(0, Math.min(cols - 1.0001, fx));
  fz = Math.max(0, Math.min(rows - 1.0001, fz));
  const c = Math.floor(fx);
  const r = Math.floor(fz);
  const u = fx - c;
  const w = fz - r;
  const i = r * cols + c;
  return (v[i] * (1 - u) + v[i + 1] * u) * (1 - w) + (v[i + cols] * (1 - u) + v[i + cols + 1] * u) * w;
}

function closedRing(pts: Vec2[]): Vec2[] {
  const last = pts[pts.length - 1];
  return pts.length > 1 && Math.hypot(pts[0].x - last.x, pts[0].z - last.z) < 0.01 ? pts.slice(0, -1) : pts;
}

/** Shoelace area; positive = counter-clockwise in (x, z). */
function area(ring: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

function centroid(ring: Vec2[]): Vec2 {
  return { x: ring.reduce((s, p) => s + p.x, 0) / ring.length, z: ring.reduce((s, p) => s + p.z, 0) / ring.length };
}

function length(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

function clampInt(s: string | undefined, lo: number, hi: number): number | undefined {
  const n = parseInt(s ?? '', 10);
  return isNaN(n) ? undefined : Math.max(lo, Math.min(hi, n));
}

function round(v: number, d: number): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** "9 de octubre-Washington S-N" → "9 de Octubre y Washington"; "vicente ramón roca" → "Vicente Ramón Roca". */
export function tidyStopName(raw: string): string {
  const small = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e']);
  return raw
    .replace(/\s+[SNEO]-[SNEO]\b/gi, '')
    .replace(/\s*-\s*/g, ' y ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function shortName(n: string): string {
  return n.replace(/^Avenida /, 'Av. ').replace(/^Calle /, '');
}
