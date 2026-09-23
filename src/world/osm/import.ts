import { Rng } from '../../core/rng';
import type { Building, CityData, Feature, Prop, Road, Stop, Vec2 } from '../cityData';
import { right } from '../cityData';
import { distToPolyline, pointInPolygon, polygonToPolylineDistance } from '../geom';
import { type Terrain, smoothHeights } from '../terrain';
import { buildRoadGraph } from '../roadGraph';

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
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
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
}

const SIDEWALK = 3;
const LANE = 3.3;
const FLOOR = 3.2;
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
export function importOsm(osm: OsmJson, dem: Dem, opts: ImportOptions): CityData {
  const rng = new Rng(opts.seed ?? 1);
  const proj = makeProjection(opts.bbox);
  const sw = proj.toXZ(opts.bbox[0], opts.bbox[1]);
  const ne = proj.toXZ(opts.bbox[2], opts.bbox[3]);
  const bounds = { min: { x: sw.x, z: ne.z }, max: { x: ne.x, z: sw.z } };
  const inside = (p: Vec2, pad = 0) =>
    p.x >= bounds.min.x - pad && p.x <= bounds.max.x + pad && p.z >= bounds.min.z - pad && p.z <= bounds.max.z + pad;

  const roads = importRoads(osm, proj.toXZ, bounds);
  // Junction areas are paved (the game draws them as asphalt): nothing may stand on them.
  const hulls = buildRoadGraph({ roads } as CityData)
    .nodes.filter((n) => n.hull)
    .map((n) => n.hull!);
  const onJunction = (p: Vec2) => hulls.some((h) => pointInPolygon(p, h));
  const terrain = buildTerrain(dem, proj.toLatLon, bounds, roads, opts);
  const buildings = importBuildings(osm, proj.toXZ, inside, roads, rng).filter(
    (b) => !b.footprint.some(onJunction) && !hulls.some((h) => h.some((q) => pointInPolygon(q, b.footprint))),
  );
  const stops = importStops(osm, proj.toXZ, inside, roads, buildings).filter((st) => !onJunction(st.pos));
  const parks = osm.elements
    .filter((e) => e.type === 'way' && e.geometry && (e.tags?.leisure || e.tags?.landuse))
    .map((e) => closedRing(e.geometry!.map((g) => proj.toXZ(g.lat, g.lon))))
    .filter((ring) => ring.length >= 3 && ring.some((p) => inside(p)));
  const blockedByBuilding = (p: Vec2) => buildings.some((b) => pointInPolygon(p, b.footprint));
  const offRoad = (p: Vec2, margin: number) => roads.every((r) => distToPolyline(p, r.points) > r.width / 2 + margin);
  const trees = osm.elements
    .filter((e) => e.type === 'node' && e.tags?.natural === 'tree')
    .map((e) => proj.toXZ(e.lat!, e.lon!))
    .filter((p) => inside(p) && offRoad(p, 0.8) && !blockedByBuilding(p) && !onJunction(p));
  const props = scatterProps(roads, stops, buildings, rng, inside).filter((pr) => !onJunction(pr.pos));
  const features = placeFeatures(roads, rng);
  const spawn = pickSpawn(roads, bounds);

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
    attribution: '© OpenStreetMap contributors (ODbL); elevation: Copernicus GLO-30 DEM',
  };
}

function importRoads(osm: OsmJson, toXZ: (lat: number, lon: number) => Vec2, bounds: { min: Vec2; max: Vec2 }): Road[] {
  const roads: Road[] = [];
  for (const e of osm.elements) {
    const t = e.tags ?? {};
    const cls = ROAD_CLASSES[t.highway];
    if (e.type !== 'way' || !cls || !e.geometry || t.tunnel === 'yes' || t.area === 'yes') continue;
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
): Terrain {
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
  return t;
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
function scatterProps(roads: Road[], stops: Stop[], buildings: Building[], rng: Rng, inside: (p: Vec2) => boolean): Prop[] {
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
function placeFeatures(roads: Road[], rng: Rng): Feature[] {
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
      const roll = rng.next();
      // No ramps: real streets are too narrow for traffic to pass beside one.
      if (roll < 0.12) out.push({ kind: 'hump', pos: mid, heading, length: 3, width: road.width, height: 0.22 });
    }
  }
  return out;
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
