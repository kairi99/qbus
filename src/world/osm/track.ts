import type { CityData, Road, Vec2 } from '../cityData';
import { type Terrain, smoothHeights } from '../terrain';
import type { TrackData, TrackScenery } from '../track';
import { Rng } from '../../core/rng';
import { type Dem, type OsmJson, type OsmElement, LANDMARKS, buildHorizon, makeProjection, sampleDem } from './import';

/** A point on the map: where a track starts or ends, and its name. */
export interface TrackEnd {
  lat: number;
  lon: number;
  name: string;
}

export interface TrackOptions {
  name: string;
  /** south, west, north, east: the terrain covers it (plus `margin`). */
  bbox: [number, number, number, number];
  from: TrackEnd;
  to: TrackEnd;
  seed?: number;
  /** Absent = páramo. */
  biome?: TrackData['biome'];
  /** The highway's name, shown as the street label (absent: the Vía Interoceánica). */
  road?: string;
  /** Hairpins tighter than this radius (m) are eased out to it (absent: OSM's line as drawn). */
  minRadius?: number;
}

/** Asphalt width: one lane each way plus a strip of shoulder (m). */
export const TRACK_WIDTH = 8.4;
/** Road before the start line (the grid) and after the finish (to stop in), m. */
const LEAD = 70;
const RUNOFF = 160;
/** Centerline sample spacing (m). */
const STEP = 3;
const CELL = 8;
const MARGIN = 350;
/** The road never climbs or drops steeper than this (the 30 m DEM along a valley side is noisy). */
const MAX_GRADE = 0.11;
/** Cut slope rising from the ditch on the uphill side (rise per meter). */
const CUT = 1.6;
/** The road's fill bank: flat this far past the asphalt, then down at this slope (rise per meter). */
const SHOULDER = 0.6;
const FILL = 1.5;
/** The drop below the road is this much deeper right at its edge, fading out DEEPEN_REACH m away. */
const DEEPEN = 1.3;
const DEEPEN_REACH = 90;
/** Valley shaping per biome: the cloud forest's quebradas fall away harder (steeper bank, deeper drop, farther out). */
export const SHAPING = {
  paramo: { fill: FILL, deepen: DEEPEN, reach: DEEPEN_REACH },
  cloudforest: { fill: 2.3, deepen: 2.4, reach: 150 },
} as const;
/** Terrain under the asphalt sits this far under the deck (hidden, never poking through). */
const UNDER = 0.08;
/** A drop deeper than this, measured `DROP_AT` m past the asphalt's edge, is a ravine side. */
const DROP = 5;
const DROP_AT = 7;
/** Share of the ravine side left without a guardrail, in gaps this long (m). */
const OPEN_SHARE = 0.28;
const GAP: [number, number] = [25, 55];
/** No gaps this close to the start (the grid) or the finish. */
const SAFE_START = 250;
const SAFE_END = 120;
/** Nitro pickups: a pair across the road every this many meters. */
const PICKUP_EVERY = 480;

/**
 * Imports a stretch of a real highway as a race track: its ways (Overpass `out geom`) chained
 * from `from` to `to`, smoothed into a centerline (OSM's nodes are tens of meters apart on a
 * mountain road), its height from the DEM smoothed and kept under MAX_GRADE, and the terrain
 * around it from the same DEM: carved flat under the asphalt, cut into the slope on the uphill
 * side, left to fall away on the downhill side. The road lies on a deck of its own (`surface`),
 * so the ravine can start right at its edge. Rails go along most of the drops, not all.
 */
export function importTrack(osm: OsmJson, dem: Dem, opts: TrackOptions, horizonDem?: Dem, sceneryOsm?: OsmJson): CityData {
  const proj = makeProjection(opts.bbox);
  const sw = proj.toXZ(opts.bbox[0], opts.bbox[1]);
  const ne = proj.toXZ(opts.bbox[2], opts.bbox[3]);
  const bounds = { min: { x: sw.x, z: ne.z }, max: { x: ne.x, z: sw.z } };

  const nodes = chainWays(osm, opts.from).map((g) => proj.toXZ(g.lat, g.lon));
  const from = proj.toXZ(opts.from.lat, opts.from.lon);
  const to = proj.toXZ(opts.to.lat, opts.to.lon);
  const drawn = resample(catmullRom(dedupe(nodes, 2), STEP), STEP);
  const smooth = opts.minRadius ? resample(easeBends(drawn, opts.minRadius), STEP) : drawn;
  const s0 = nearestAlong(smooth, from);
  const s1 = nearestAlong(smooth, to);
  if (s1 <= s0) throw new Error('track runs the wrong way: `to` is before `from` along the chained road');
  const pts = slice(smooth, s0 - LEAD, s1 + RUNOFF);
  const cum = cumulative(pts);
  const len = cum[cum.length - 1];

  // Terrain grid over the bbox, from the DEM with a light blur (no buildings to take out here).
  const minX = Math.floor((bounds.min.x - MARGIN) / CELL) * CELL;
  const minZ = Math.floor((bounds.min.z - MARGIN) / CELL) * CELL;
  const cols = Math.ceil((bounds.max.x + MARGIN - minX) / CELL) + 1;
  const rows = Math.ceil((bounds.max.z + MARGIN - minZ) / CELL) + 1;
  const raw: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const { lat, lon } = proj.toLatLon({ x: minX + c * CELL, z: minZ + r * CELL });
      raw.push(sampleDem(dem, lat, lon));
    }
  const ground = smoothHeights(raw, cols, rows, 1, 2);
  const groundAt = (p: Vec2) => bilinear(ground, cols, rows, (p.x - minX) / CELL, (p.z - minZ) / CELL);

  const y = gradeProfile(pts.map(groundAt), cum);
  const segs = new SegmentIndex(pts, y);
  const hw = TRACK_WIDTH / 2;
  const inGrid = (p: Vec2, pad: number) => p.x > minX + pad && p.z > minZ + pad && p.x < minX + (cols - 1) * CELL - pad && p.z < minZ + (rows - 1) * CELL - pad;
  // The rivers run in their beds: carved into the valley floor before the road's cuts and fills.
  const rivers = sceneryOsm ? importRivers(sceneryOsm, proj.toXZ, groundAt, (p) => inGrid(p, 16)) : [];
  for (const rv of rivers) carveRiver(ground, cols, rows, minX, minZ, rv);

  // The ground beside the road: cut into the slope uphill (never above any road nearby past its
  // ditch, a hairpin's other leg too, rising at CUT), steepened downhill (a mountain road is
  // benched into the slope: the fill and cliff below it are steeper than the 30 m DEM's average).
  const carved = new Array<number>(cols * rows);
  const shape = SHAPING[opts.biome ?? 'paramo'];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      const p = { x: minX + c * CELL, z: minZ + r * CELL };
      const q = segs.nearest(p);
      const below = q.y - ground[k];
      const deepen = below > 0 ? 1 + shape.deepen * (1 - smoothstep(0, shape.reach, q.d - hw)) : 1;
      // Off the downhill edge a fill bank comes down at FILL first (the road's own embankment), so
      // the slope begins at the road instead of a sheer wall under its edge.
      const fill = q.y - UNDER - shape.fill * Math.max(0, q.d - hw - SHOULDER);
      carved[k] = Math.min(Math.max(q.y - below * deepen, fill), segs.cap(p, hw + 0.5, CUT, UNDER));
    }
  // Then under the asphalt it must lie below the deck: wherever a terrain triangle still pokes
  // up through the road (sampled on a 2 m grid inside each triangle), its corners come down by
  // just that much, a few passes until none does. Only what's needed: lowering whole triangles
  // to the deck left flat 8 m shelves stair-stepping along the road's edge.
  fitUnderDeck(carved, cols, rows, minX, minZ, pts, y, hw + 0.3, UNDER);

  // Heights relative to the lowest point inside the bbox, like a city.
  let base = Infinity;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = minX + c * CELL;
      const z = minZ + r * CELL;
      if (x >= bounds.min.x && x <= bounds.max.x && z >= bounds.min.z && z <= bounds.max.z) base = Math.min(base, carved[r * cols + c]);
    }
  const terrain: Terrain = { minX, minZ, cell: CELL, cols, rows, heights: carved.map((h) => round(h - base, 2)), scale: 1 };
  const surface = y.map((h) => round(h - base, 2));
  const tAt = (p: Vec2) => bilinear(terrain.heights, cols, rows, (p.x - minX) / CELL, (p.z - minZ) / CELL);

  // Ravine sides: where the ground DROP_AT m past the edge is DROP under the road.
  const drop = (i: number, side: 1 | -1) => {
    const j = Math.min(i, pts.length - 2);
    const dx = (pts[j + 1].x - pts[j].x) / (cum[j + 1] - cum[j] || 1);
    const dz = (pts[j + 1].z - pts[j].z) / (cum[j + 1] - cum[j] || 1);
    const off = side * (hw + DROP_AT);
    return surface[i] - tAt({ x: pts[i].x - dz * off, z: pts[i].z + dx * off });
  };
  const rng = new Rng(opts.seed ?? 3);
  const start = LEAD;
  const finish = len - RUNOFF;
  const rails: TrackData['rails'] = [];
  const drops: TrackData['drops'] = [];
  for (const side of [1, -1] as const) {
    for (const run of runs(cum, (i) => drop(i, side) > DROP, 12)) {
      // Leave gaps along the run (never near the start or finish): those are the risky bits.
      // Rail and gap stretches alternate, the rails about (1 - OPEN_SHARE) of the way.
      const open: { s0: number; s1: number }[] = [];
      for (let at = run.s0 + rng.range(20, 120); at < run.s1; ) {
        const g = rng.range(...GAP);
        if (at > start + SAFE_START && at + g < Math.min(run.s1, finish - SAFE_END)) open.push({ s0: at, s1: at + g });
        at += g + (g * (1 - OPEN_SHARE)) / OPEN_SHARE * rng.range(0.6, 1.4);
      }
      let a = run.s0;
      for (const o of open) {
        if (o.s0 - a > 4) rails.push({ s0: round(a, 1), s1: round(o.s0, 1), side });
        drops.push({ s0: round(o.s0, 1), s1: round(o.s1, 1), side });
        a = o.s1;
      }
      if (run.s1 - a > 4) rails.push({ s0: round(a, 1), s1: round(run.s1, 1), side });
    }
  }
  rails.sort((p, q) => p.s0 - q.s0);
  drops.sort((p, q) => p.s0 - q.s0);
  const pickups: TrackData['pickups'] = [];
  for (let s = start + 300; s < finish - 150; s += PICKUP_EVERY) for (const off of [-1.9, 1.9]) pickups.push({ s: round(s, 1), off });

  const road: Road = { name: opts.road ?? 'Vía Interoceánica (E20)', kind: 'street', points: pts, width: TRACK_WIDTH, lanes: 2, surface };
  const offRoad = (p: Vec2, pad: number) => segs.nearest(p).d > hw + pad;
  const scenery: TrackScenery | undefined = sceneryOsm
    ? {
        rivers: rivers.map((rv) => ({ points: rv.points, y: rv.y.map((h) => round(h - base, 2)), width: rv.width })),
        pipes: importPipes(sceneryOsm, proj.toXZ, (p) => inGrid(p, 16) && segs.nearest(p).d < PIPE_REACH, (p) => offRoad(p, 3)),
        buildings: importHouses(sceneryOsm, proj.toXZ, (p) => inGrid(p, 16) && offRoad(p, 2.5), (p) => segs.nearest(p)),
      }
    : undefined;
  const race: TrackData = { from: opts.from.name, to: opts.to.name, points: pts, y: surface, cum: cum.map((v) => round(v, 2)), width: TRACK_WIDTH, start, finish: round(finish, 1), rails, drops, pickups, scenery };
  if (opts.biome && opts.biome !== 'paramo') race.biome = opts.biome;
  const heading = Math.atan2(-(pts[1].z - pts[0].z), pts[1].x - pts[0].x);
  const horizon = horizonDem ? buildHorizon(horizonDem, proj.toLatLon, base) : undefined;
  const landmarks = horizonDem
    ? LANDMARKS.filter((l) => l.kind === 'volcano').map((l) => ({ kind: l.kind, name: l.name, pos: proj.toXZ(l.lat, l.lon), y: round((l.summit ?? 0) - base, 1) }))
    : undefined;
  return {
    name: opts.name,
    roads: [road],
    blocks: [],
    buildings: [],
    stops: [],
    features: [],
    props: [],
    trees: [],
    spawn: { pos: pts[Math.round(LEAD / STEP)], heading },
    bounds,
    terrain,
    horizon,
    landmarks,
    race,
    attribution: '© OpenStreetMap contributors (ODbL); elevation: Copernicus GLO-30 DEM',
  };
}

/** Rivers and streams: bed width (m), and how deep the channel is cut under its banks. */
const RIVER_WIDTH = { river: 9, stream: 3 };
const RIVER_DEPTH = 1.6;
/** The banks climb out of the channel at this slope (rise per meter). */
const BANK = 0.45;
/** Pipelines are drawn this far from the road at most (m). */
const PIPE_REACH = 420;
/** Andean small-town walls (painted block) and roofs (corrugated tin, a few clay tiles). */
const HOUSE_WALLS = ['#f1ece0', '#e9dcc0', '#bcd6e4', '#e8c88f', '#e7b9b0', '#c9dcb4', '#f2f2f2', '#d9c7e3'];
const HOUSE_ROOFS = ['#8e9599', '#7f8890', '#a5abad', '#9c4a34'];
/** What a roadside business's sign says: its trade, never its real name. */
const TRADE_SIGNS: Record<string, string[]> = {
  restaurant: ['TRUCHAS', 'CALDO DE TRUCHA', 'PICANTERÍA', 'COMEDOR', 'ASADERO'],
  cafe: ['TORTILLAS DE TIESTO', 'CAFÉ'],
  pharmacy: ['FARMACIA'],
  hostel: ['HOSTAL'],
  hotel: ['HOSTERÍA'],
  guest_house: ['HOSTAL'],
};

interface River {
  points: Vec2[];
  /** Water surface height at each point. */
  y: number[];
  width: number;
}

/**
 * Rivers and streams inside the terrain, resampled every 6 m, their water level from the ground
 * along them never rising downstream (OSM draws a waterway in its flow direction).
 */
function importRivers(osm: OsmJson, toXZ: (lat: number, lon: number) => Vec2, groundAt: (p: Vec2) => number, inside: (p: Vec2) => boolean): River[] {
  const out: River[] = [];
  for (const e of osm.elements) {
    const kind = e.tags?.waterway as keyof typeof RIVER_WIDTH | undefined;
    if (e.type !== 'way' || !e.geometry || !kind || !(kind in RIVER_WIDTH)) continue;
    for (const run of insideRuns(e.geometry.map((g) => (g ? toXZ(g.lat, g.lon) : null)), inside)) {
      const points = resample(run, 6);
      if (points.length < 3) continue;
      let y = gauss(points.map(groundAt), 3);
      for (let i = 1; i < y.length; i++) y[i] = Math.min(y[i], y[i - 1]);
      y = y.map((h) => h - 0.4);
      out.push({ points, y, width: RIVER_WIDTH[kind] });
    }
  }
  return out;
}

/** Cuts a river's channel into the ground grid (in place): RIVER_DEPTH under its water, banks at BANK. */
function carveRiver(h: number[], cols: number, rows: number, minX: number, minZ: number, rv: River): void {
  const half = rv.width / 2;
  const reach = half + 12;
  for (let i = 0; i < rv.points.length - 1; i++) {
    const [a, b] = [rv.points[i], rv.points[i + 1]];
    const c0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - minX) / CELL));
    const c1 = Math.min(cols - 1, Math.ceil((Math.max(a.x, b.x) + reach - minX) / CELL));
    const r0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - minZ) / CELL));
    const r1 = Math.min(rows - 1, Math.ceil((Math.max(a.z, b.z) + reach - minZ) / CELL));
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const x = minX + c * CELL;
        const z = minZ + r * CELL;
        const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
        const d = Math.hypot(x - a.x - dx * u, z - a.z - dz * u);
        if (d > reach) continue;
        const water = rv.y[i] + (rv.y[i + 1] - rv.y[i]) * u;
        const k = r * cols + c;
        h[k] = Math.min(h[k], water - RIVER_DEPTH + BANK * Math.max(0, d - half * 0.5));
      }
  }
}

/**
 * The oil pipelines (SOTE, OCP, the poliducto) as runs of points every 6 m near the road, broken
 * where they pass under it (a pipe crosses a road buried).
 */
function importPipes(osm: OsmJson, toXZ: (lat: number, lon: number) => Vec2, near: (p: Vec2) => boolean, clearOfRoad: (p: Vec2) => boolean): TrackScenery['pipes'] {
  const out: TrackScenery['pipes'] = [];
  let n = 0;
  for (const e of osm.elements) {
    if (e.type !== 'way' || !e.geometry || e.tags?.man_made !== 'pipeline') continue;
    const diameter = n++ % 2 ? 0.75 : 0.55;
    for (const run of insideRuns(e.geometry.map((g) => (g ? toXZ(g.lat, g.lon) : null)), near))
      for (const part of insideRuns(resample(run, 6), clearOfRoad)) if (part.length >= 3) out.push({ points: part.map((p) => ({ x: round(p.x, 2), z: round(p.z, 2) })), diameter });
  }
  return out;
}

/**
 * The town's buildings: block walls and tin roofs, one or two floors; a roadside business gets its
 * trade's sign. A business mapped only as a point (the trout restaurants along the road) gets a
 * small building of its own there, set back from the road and square to it.
 */
function importHouses(
  osm: OsmJson,
  toXZ: (lat: number, lon: number) => Vec2,
  ok: (p: Vec2) => boolean,
  road: (p: Vec2) => { d: number; at: Vec2; dir: Vec2 },
): TrackScenery['buildings'] {
  const shops = osm.elements.filter((e): e is OsmElement & { lat: number; lon: number } => e.type === 'node' && e.lat !== undefined && !!(e.tags?.amenity || e.tags?.tourism));
  const out: TrackScenery['buildings'] = [];
  for (const e of osm.elements) {
    if (e.type !== 'way' || !e.geometry || !e.tags?.building) continue;
    // (`out geom(bbox)` leaves the nodes outside the box null: such a building is cut off, skip it.)
    if (e.geometry.some((g) => !g)) continue;
    const ring = e.geometry.map((g) => toXZ(g.lat, g.lon));
    if (ring.length > 3 && Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].z - ring[ring.length - 1].z) < 0.5) ring.pop();
    if (ring.length < 3 || !ring.every(ok)) continue;
    const c = { x: ring.reduce((a, p) => a + p.x, 0) / ring.length, z: ring.reduce((a, p) => a + p.z, 0) / ring.length };
    const hash = Math.abs(Math.sin(c.x * 12.9898 + c.z * 78.233) * 43758.5453) % 1;
    let sign: string | undefined;
    let best = 30;
    for (const sh of shops) {
      const p = toXZ(sh.lat, sh.lon);
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      const trade = sh.tags!.amenity ?? sh.tags!.tourism;
      if (d < best && TRADE_SIGNS[trade]) (best = d), (sign = TRADE_SIGNS[trade][Math.floor(hash * TRADE_SIGNS[trade].length)]);
    }
    out.push({
      footprint: ring.map((p) => ({ x: round(p.x, 2), z: round(p.z, 2) })),
      floors: hash < 0.6 ? 1 : 2,
      wall: HOUSE_WALLS[Math.floor(hash * 997) % HOUSE_WALLS.length],
      roof: HOUSE_ROOFS[Math.floor(hash * 7919) % HOUSE_ROOFS.length],
      sign,
    });
  }
  const signed = out.filter((b) => b.sign);
  for (const sh of shops) {
    const trade = sh.tags!.amenity ?? sh.tags!.tourism;
    if (!TRADE_SIGNS[trade]) continue;
    const p = toXZ(sh.lat, sh.lon);
    if (signed.some((b) => b.footprint.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 20))) continue;
    const { d, at, dir } = road(p);
    if (d > 60) continue;
    // 8 m along the road, 6 m deep, its front 4 m off the asphalt (or where the point is, if further).
    const away = d > 0.5 ? { x: (p.x - at.x) / d, z: (p.z - at.z) / d } : { x: -dir.z, z: dir.x };
    const front = Math.max(d, TRACK_WIDTH / 2 + 4);
    const c = { x: at.x + away.x * (front + 3), z: at.z + away.z * (front + 3) };
    const corner = (u: number, v: number) => ({ x: round(c.x + dir.x * u + away.x * v, 2), z: round(c.z + dir.z * u + away.z * v, 2) });
    const footprint = [corner(-4, -3), corner(4, -3), corner(4, 3), corner(-4, 3)];
    if (!footprint.every(ok)) continue;
    const hash = Math.abs(Math.sin(p.x * 12.9898 + p.z * 78.233) * 43758.5453) % 1;
    const sign = TRADE_SIGNS[trade][Math.floor(hash * TRADE_SIGNS[trade].length)];
    out.push({ footprint, floors: 1, wall: HOUSE_WALLS[Math.floor(hash * 997) % HOUSE_WALLS.length], roof: HOUSE_ROOFS[Math.floor(hash * 7919) % HOUSE_ROOFS.length], sign });
    signed.push(out[out.length - 1]);
  }
  return out;
}

/** The stretches of a polyline whose points pass `test` (two points at least; a null point breaks it). */
function insideRuns(pts: (Vec2 | null)[], test: (p: Vec2) => boolean): Vec2[][] {
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (const p of pts) {
    if (p && test(p)) cur.push(p);
    else {
      if (cur.length >= 2) out.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

/**
 * The ways chained end to end into one road, starting from the end nearest `from` (a way's last
 * node shared with the next one's first or last). Overpass `out geom` gives each way's nodes.
 */
function chainWays(osm: OsmJson, from: TrackEnd): { lat: number; lon: number }[] {
  const ways = osm.elements.filter((e) => e.type === 'way' && e.geometry && e.geometry.length >= 2);
  const key = (p: { lat: number; lon: number }) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const ends = new Map<string, number>();
  for (const w of ways) for (const p of [w.geometry![0], w.geometry![w.geometry!.length - 1]]) ends.set(key(p), (ends.get(key(p)) ?? 0) + 1);
  // Start at a loose end (shared by one way only) nearest `from`.
  let first: { lat: number; lon: number } | null = null;
  let best = Infinity;
  for (const w of ways)
    for (const p of [w.geometry![0], w.geometry![w.geometry!.length - 1]]) {
      const d = Math.hypot(p.lat - from.lat, p.lon - from.lon);
      if (ends.get(key(p)) === 1 && d < best) [first, best] = [p, d];
    }
  if (!first) throw new Error('no loose end to start the track from');
  const used = new Set<number>();
  const out: { lat: number; lon: number }[] = [];
  let cur = key(first);
  for (;;) {
    const w = ways.find((w) => !used.has(w.id) && (key(w.geometry![0]) === cur || key(w.geometry![w.geometry!.length - 1]) === cur));
    if (!w) break;
    used.add(w.id);
    const g = key(w.geometry![0]) === cur ? w.geometry! : [...w.geometry!].reverse();
    out.push(...(out.length ? g.slice(1) : g));
    cur = key(g[g.length - 1]);
  }
  return out;
}

function dedupe(pts: Vec2[], min: number): Vec2[] {
  const out = [pts[0]];
  for (const p of pts.slice(1)) if (Math.hypot(p.x - out[out.length - 1].x, p.z - out[out.length - 1].z) >= min) out.push(p);
  return out;
}

/** A centripetal Catmull-Rom spline through the points, sampled about every `step` meters. */
export function catmullRom(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const t = (a: Vec2, b: Vec2) => Math.max(1e-3, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)));
    const t1 = t(p0, p1);
    const t2 = t1 + t(p1, p2);
    const t3 = t2 + t(p2, p3);
    const n = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let k = 0; k < n; k++) {
      const u = t1 + ((t2 - t1) * k) / n;
      const lerp = (a: Vec2, b: Vec2, ta: number, tb: number) => {
        const w = (u - ta) / (tb - ta || 1);
        return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
      };
      const a1 = lerp(p0, p1, 0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, 0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Evenly spaced points along a polyline. */
/** Bend radius at `i` (m), through the points `k` either side. */
function radiusAt(pts: Vec2[], i: number, k: number): number {
  const a = pts[i - k], b = pts[i], c = pts[i + k];
  const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
  const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  return cross < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cross);
}

/**
 * Hairpins tighter than `minRadius` eased out: each point of such a bend moves halfway to its
 * neighbors' midpoint, again and again, until every bend is at least that wide. A long bus
 * steering round OSM's 16 m hairpins (the Silante's) runs wide into the bank whatever its speed;
 * the real road is wider there anyway. Moves a hairpin's apex a few meters, nothing elsewhere.
 */
function easeBends(drawn: Vec2[], minRadius: number): Vec2[] {
  const pts = drawn.map((p) => ({ ...p }));
  const k = 3;
  for (let pass = 0; pass < 400; pass++) {
    let tight = false;
    for (let i = k; i < pts.length - k; i++) {
      if (radiusAt(pts, i, k) >= minRadius) continue;
      tight = true;
      for (let j = Math.max(1, i - k); j <= Math.min(pts.length - 2, i + k); j++) {
        const m = { x: (pts[j - 1].x + pts[j + 1].x) / 2, z: (pts[j - 1].z + pts[j + 1].z) / 2 };
        pts[j].x += (m.x - pts[j].x) / 2;
        pts[j].z += (m.z - pts[j].z) / 2;
      }
    }
    if (!tight) break;
  }
  return pts;
}

function resample(pts: Vec2[], step: number): Vec2[] {
  const cum = cumulative(pts);
  const len = cum[cum.length - 1];
  const n = Math.max(1, Math.round(len / step));
  const out: Vec2[] = [];
  let i = 0;
  for (let k = 0; k <= n; k++) {
    const s = (len * k) / n;
    while (i < pts.length - 2 && cum[i + 1] < s) i++;
    const u = Math.max(0, Math.min(1, (s - cum[i]) / (cum[i + 1] - cum[i] || 1)));
    out.push({ x: round(pts[i].x + (pts[i + 1].x - pts[i].x) * u, 2), z: round(pts[i].z + (pts[i + 1].z - pts[i].z) * u, 2) });
  }
  return out;
}

/** The stretch of a polyline from `a` to `b` meters along it. */
function slice(pts: Vec2[], a: number, b: number): Vec2[] {
  const cum = cumulative(pts);
  return pts.filter((_, i) => cum[i] >= a && cum[i] <= b);
}

function cumulative(pts: Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return cum;
}

function nearestAlong(pts: Vec2[], q: Vec2): number {
  const cum = cumulative(pts);
  let best = Infinity;
  let at = 0;
  pts.forEach((p, i) => {
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (d < best) [best, at] = [d, cum[i]];
  });
  return at;
}

/**
 * The road's height along it: the ground under the centerline, smoothed over ~60 m, then held
 * under MAX_GRADE (passes both ways until it settles) and smoothed a little again.
 */
function gradeProfile(ground: number[], cum: number[]): number[] {
  let y = gauss(ground, 10);
  for (let pass = 0; pass < 20; pass++) {
    for (let i = 1; i < y.length; i++) {
      const ds = cum[i] - cum[i - 1];
      y[i] = Math.max(y[i - 1] - MAX_GRADE * ds, Math.min(y[i - 1] + MAX_GRADE * ds, y[i]));
    }
    for (let i = y.length - 2; i >= 0; i--) {
      const ds = cum[i + 1] - cum[i];
      y[i] = Math.max(y[i + 1] - MAX_GRADE * ds, Math.min(y[i + 1] + MAX_GRADE * ds, y[i]));
    }
  }
  y = gauss(y, 4);
  return y;
}

/** Gaussian blur along an array, sigma in samples. */
function gauss(v: number[], sigma: number): number[] {
  const r = Math.ceil(sigma * 2.5);
  const w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
  return v.map((_, i) => {
    let sum = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = Math.max(0, Math.min(v.length - 1, i + k));
      sum += v[j] * w[k + r];
      ws += w[k + r];
    }
    return sum / ws;
  });
}

/** Stretches (in meters along) where `test(i)` holds, closing gaps shorter than `bridge` m. */
function runs(cum: number[], test: (i: number) => boolean, bridge: number): { s0: number; s1: number }[] {
  const out: { s0: number; s1: number }[] = [];
  let open = -1;
  for (let i = 0; i < cum.length; i++) {
    const on = test(i);
    if (on && open < 0) open = i;
    if ((!on || i === cum.length - 1) && open >= 0) {
      const s0 = cum[open];
      const s1 = cum[i];
      const last = out[out.length - 1];
      if (last && s0 - last.s1 < bridge) last.s1 = s1;
      else out.push({ s0, s1 });
      open = -1;
    }
  }
  return out.filter((r) => r.s1 - r.s0 > 10);
}

/** The centerline's segments in a coarse grid, for nearest-road queries over the terrain. */
class SegmentIndex {
  private cell = 32;
  private grid = new Map<string, number[]>();

  constructor(
    private pts: Vec2[],
    private y: number[],
  ) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const x0 = Math.floor(Math.min(a.x, b.x) / this.cell);
      const x1 = Math.floor(Math.max(a.x, b.x) / this.cell);
      const z0 = Math.floor(Math.min(a.z, b.z) / this.cell);
      const z1 = Math.floor(Math.max(a.z, b.z) / this.cell);
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          const k = `${x},${z}`;
          const list = this.grid.get(k);
          if (list) list.push(i);
          else this.grid.set(k, [i]);
        }
    }
  }

  /** Segments within one grid cell of `p` (about 32–64 m). */
  private around(p: Vec2, f: (i: number) => void): void {
    const cx = Math.floor(p.x / this.cell);
    const cz = Math.floor(p.z / this.cell);
    for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) for (const i of this.grid.get(`${x},${z}`) ?? []) f(i);
  }

  private project(p: Vec2, i: number): { d: number; y: number; at: Vec2; dir: Vec2 } {
    const [a, b] = [this.pts[i], this.pts[i + 1]];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    const l = Math.hypot(dx, dz) || 1;
    const at = { x: a.x + dx * u, z: a.z + dz * u };
    return { d: Math.hypot(p.x - at.x, p.z - at.z), y: this.y[i] + (this.y[i + 1] - this.y[i]) * u, at, dir: { x: dx / l, z: dz / l } };
  }

  /** The nearest point of the road within a grid cell or so: how far, its height, where, and the road's direction there. */
  nearest(p: Vec2): { d: number; y: number; at: Vec2; dir: Vec2 } {
    let best = { d: Infinity, y: 0, at: p, dir: { x: 1, z: 0 } };
    this.around(p, (i) => {
      const q = this.project(p, i);
      if (q.d < best.d) best = q;
    });
    return best;
  }

  /** The highest the ground may be at `p`: under every road nearby, past its ditch (`edge`) rising at `slope`. */
  cap(p: Vec2, edge: number, slope: number, under: number): number {
    let cap = Infinity;
    this.around(p, (i) => {
      const q = this.project(p, i);
      cap = Math.min(cap, q.y - under + slope * Math.max(0, q.d - edge));
    });
    return cap;
  }
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

/**
 * Lowers terrain vertices (in place) until the ground is nowhere higher than the deck minus
 * `under` across the road (out to `half` either side of the centerline). Sampled on the road
 * itself, every 0.5 m along and across it, edges included: past the edge the ground climbs
 * (a cut), so the edge is where it would poke through. The surface is the heightfield's two
 * triangles per cell, split along (r, c+1)-(r+1, c) like `terrainHeight`.
 */
function fitUnderDeck(h: number[], cols: number, rows: number, minX: number, minZ: number, pts: Vec2[], y: number[], half: number, under: number): void {
  const samples: { v: [number, number, number]; w: [number, number, number]; y: number }[] = [];
  const offs: number[] = [];
  for (let o = -half; o < half; o += 0.5) offs.push(o);
  offs.push(half);
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const [nx, nz] = [-(b.z - a.z) / len, (b.x - a.x) / len];
    const steps = Math.max(1, Math.ceil(len / 0.5));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const cx = a.x + (b.x - a.x) * t;
      const cz = a.z + (b.z - a.z) * t;
      const deck = y[i] + (y[i + 1] - y[i]) * t - under;
      for (const o of offs) {
        const fx = Math.max(0, Math.min(cols - 1.0001, (cx + nx * o - minX) / CELL));
        const fz = Math.max(0, Math.min(rows - 1.0001, (cz + nz * o - minZ) / CELL));
        const c = Math.floor(fx);
        const r = Math.floor(fz);
        const u = fx - c;
        const v = fz - r;
        const i00 = r * cols + c;
        if (u + v <= 1) samples.push({ v: [i00, i00 + 1, i00 + cols], w: [1 - u - v, u, v], y: deck });
        else samples.push({ v: [i00 + cols + 1, i00 + cols, i00 + 1], w: [u + v - 1, 1 - u, 1 - v], y: deck });
      }
    }
  }
  for (let pass = 0; pass < 20; pass++) {
    let worst = 0;
    for (const s of samples) {
      const z = h[s.v[0]] * s.w[0] + h[s.v[1]] * s.w[1] + h[s.v[2]] * s.w[2];
      const over = z - s.y;
      if (over <= 0.001) continue;
      worst = Math.max(worst, over);
      // Bring the corners carrying the most weight down the most; the sample lands on the deck.
      const w2 = s.w[0] * s.w[0] + s.w[1] * s.w[1] + s.w[2] * s.w[2];
      for (let k = 0; k < 3; k++) h[s.v[k]] -= (over * s.w[k]) / w2;
    }
    if (worst <= 0.001) break;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function round(v: number, d: number): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
