import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { RAPIER } from '../physics/world';
import type { CityData, Road, Vec2 } from './cityData';
import { terrainAt } from './cityData';
import { type RoadProfile, profileAt, projectOnRoad, roadProfiles, surfaceY } from './elevation';
import { pointInPolygon } from './geom';
import type { ChunkedMeshBuilder } from './meshBuilder';
import { type RoadGraph, convexHull } from './roadGraph';

/** Deck slab thickness under a bridge's road surface. */
const SLAB = 0.8;
/** Concrete strip either side of an underpass road, between the asphalt and the wall. */
const SHOULDER = 0.6;
const WALL = 0.5;
const PARAPET = 1.0;
/** A bridge higher than this over the ground stands on pillars; lower, on an embankment. */
const PILLAR_CLEARANCE = 5.3;
/** Lift at which a road counts as dug in (an underpass) or up on a deck. */
const DUG = -0.03;
const RAISED = 0.05;
/** How far an underpass's shoulders and walls reach past the end of their road, into the next road's. */
const JOINT_OVERLAP = 1.2;
const FINE = 1;
const CONCRETE = '#b9b5ad';
const CONCRETE_DARK = '#8e8a83';
const RAIL = '#6b7078';

type Ground = (p: Vec2) => number;

/** Where the terrain is replaced by a finer patch with the underpass cut out of it. */
export interface TrenchPlan {
  /** Terrain cells (row * (cols - 1) + col) the patch replaces. */
  cells: Set<number>;
  /** Heightfield vertices sunk out of the way (row * cols + col), and how deep. */
  pit: Set<number>;
  pitY: number;
}

interface Lowered {
  road: Road;
  index: number;
  profile: RoadProfile;
  half: number;
  box: Box;
  /** Streets at ground level nearby: where one runs alongside, the cut stops halfway to it. */
  rivals: { road: Road; index: number; box: Box }[];
  city: CityData;
}

interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function boxOf(pts: Vec2[], pad: number): Box {
  const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const p of pts) (b.x0 = Math.min(b.x0, p.x)), (b.x1 = Math.max(b.x1, p.x)), (b.z0 = Math.min(b.z0, p.z)), (b.z1 = Math.max(b.z1, p.z));
  return { x0: b.x0 - pad, x1: b.x1 + pad, z0: b.z0 - pad, z1: b.z1 + pad };
}

const inBox = (b: Box, p: Vec2) => p.x >= b.x0 && p.x <= b.x1 && p.z >= b.z0 && p.z <= b.z1;

/** Road bounding boxes (padded by their half width plus `pad`), cached per city. */
const boxCache = new WeakMap<CityData, Box[]>();
function roadBoxes(city: CityData): Box[] {
  let b = boxCache.get(city);
  if (!b) boxCache.set(city, (b = city.roads.map((r) => boxOf(r.points, r.width / 2 + 2))));
  return b;
}

/** Roads that dip into an underpass somewhere. */
function loweredRoads(city: CityData): Lowered[] {
  const profiles = roadProfiles(city);
  const boxes = roadBoxes(city);
  const out: Lowered[] = [];
  city.roads.forEach((road, index) => {
    const profile = profiles[index];
    if (!profile || !profile.lift.some((l) => l < DUG)) return;
    const box = boxOf(road.points, road.width / 2 + SHOULDER + UNDER_WALL);
    out.push({ road, index, profile, half: road.width / 2 + SHOULDER, box, rivals: [], city });
  });
  const dug = new Set(out.map((l) => l.index));
  for (const l of out)
    city.roads.forEach((road, index) => {
      const b = boxes[index];
      if (!dug.has(index) && b.x0 < l.box.x1 && b.x1 > l.box.x0 && b.z0 < l.box.z1 && b.z1 > l.box.z0) l.rivals.push({ road, index, box: b });
    });
  return out;
}

/** Direction of a road's centerline `s` meters along it. */
function dirOnRoad(r: Road, s: number): Vec2 {
  let cum = 0;
  for (let i = 0; i < r.points.length - 1; i++) {
    const len = Math.hypot(r.points[i + 1].x - r.points[i].x, r.points[i + 1].z - r.points[i].z);
    if (s <= cum + len || i === r.points.length - 2) return unit(r.points[i], r.points[i + 1]);
    cum += len;
  }
  return { x: 1, z: 0 };
}

const PARALLEL = 0.7;
/**
 * The ground is dug this far past the shoulder: under the retaining wall and one patch cell's
 * diagonal past it, so the slope up from the floor starts behind the wall wherever the grid
 * lies (a vertex just past a shorter reach tilts its triangles up across the shoulder, onto
 * the asphalt: lips and saw-teeth along the wall's foot).
 */
const UNDER_WALL = WALL + FINE * Math.SQRT2;
/** Concrete walkway along the top of a retaining wall, over the dug ground behind it. */
const APRON = 1.4;
/**
 * Ground over a cut only stays on as a roof where there's headroom under it, measured to the
 * underside of the lintel hung along its open edges (LINTEL): the tallest bus is ~3.45 m over
 * the road, plus room for its suspension and pitch on a ramp.
 */
const LINTEL = 0.6;
const HEADROOM = 4.2 + LINTEL;
/** How far the ground over an underpass reaches beyond the edge of a street crossing over it. */
const ROOF_MARGIN = 3;

/** Another lowered road's asphalt (plus a little) covers `p`: its floor, not ours, goes there. */
function otherFloor(lowered: Lowered[], self: Lowered, p: Vec2): boolean {
  return lowered.some((o) => {
    if (o === self || !inBox(o.box, p)) return false;
    const { s, d } = projectOnRoad(o.road, p);
    return d < o.road.width / 2 + 0.3 && profileAt(o.profile, s).lift < DUG;
  });
}

/**
 * The asphalt of another road with an underpass ramp at `p` (partway along it, not just its end
 * touching ours at a joint), its surface within a meter or so of `y` (it may not be dug in yet).
 */
function rampAlongside(lowered: Lowered[], self: Lowered, p: Vec2, y: number): boolean {
  return lowered.some((o) => {
    if (o === self || !inBox(o.box, p)) return false;
    const { s, d } = projectOnRoad(o.road, p);
    const len = o.profile.cum[o.profile.cum.length - 1];
    if (d > o.road.width / 2 + 0.3 || s < 0.5 || s > len - 0.5) return false;
    return Math.abs(profileAt(o.profile, s).y - y) < 1.2;
  });
}

/** A junction down in an underpass cut. */
interface SunkJunction {
  poly: Vec2[];
  y: number;
  box: Box;
}

function sunkJunctions(city: CityData, graph: RoadGraph): SunkJunction[] {
  return graph.nodes
    .filter((n) => n.hull && n.y !== null && n.lift < DUG)
    .map((n) => ({ poly: n.hull!, y: n.y!, box: boxOf(n.hull!, 0) }));
}

/**
 * Over a lowered road's floor (asphalt and shoulders, which are solid), where it's dug in. (A
 * bus's overhang sweeps the shoulder on a bend: ground sloping up there is a wall to it.)
 */
function overRoadFloor(lowered: Lowered[], p: Vec2): boolean {
  return lowered.some((l) => {
    if (!inBox(l.box, p)) return false;
    const { s, d } = projectOnRoad(l.road, p);
    return d <= l.half && profileAt(l.profile, s).lift < DUG;
  });
}

/** Whether `p` (`d` meters off the centerline of `l`, `s` along it) is nearer a street alongside at ground level. */
function claimedByRival(l: Lowered, p: Vec2, s: number, d: number): boolean {
  // Never on the lowered road's own asphalt where it's down in its cut. (At the shallow top
  // of a ramp a street-level road drawn overlapping it keeps its ground, but only where that
  // ground isn't above the ramp's asphalt: kept there, it's a lip the bus crashes into.)
  // Down in the cut the shoulders are ours too: ground kept there slopes
  // up over the curb lane (a lip a bus scrapes along).
  if (d <= l.half) {
    const h = profileAt(l.profile, s);
    if (h.lift < -0.5) return false;
    if (d <= l.road.width / 2 && terrainAt(l.city, p) - surfaceY(l.city, h, p) > 0.1) return false;
  }
  const dir = dirOnRoad(l.road, s);
  return l.rivals.some((r) => {
    if (!inBox(r.box, p)) return false;
    const o = projectOnRoad(r.road, p);
    if (o.d - r.road.width / 2 >= d - l.road.width / 2) return false;
    const od = dirOnRoad(r.road, o.s);
    return Math.abs(od.x * dir.x + od.z * dir.z) > PARALLEL;
  });
}

/**
 * Inside an underpass cut (at `p`): how deep its floor is there and which way the cut runs (the
 * nearest cut, where two meet). `reach` widens the cut past the shoulders, e.g. to dig the
 * ground under the retaining walls so its slope stays hidden behind them.
 */
function trenchAt(lowered: Lowered[], p: Vec2, sunk: SunkJunction[] = [], reach = 0): { y: number; road: number; dir: Vec2 | null } | null {
  // On the asphalt of more than one cut (carriageways drawn overlapping): the deepest floor, so
  // no road is ever buried. Otherwise the nearest cut.
  let best: Cut | null = null;
  for (const c of cutsAt(lowered, p, sunk, reach)) if (!best || c.rank < best.rank) best = c;
  return best && { y: best.y, road: best.road, dir: best.dir };
}

interface Cut {
  y: number;
  road: number;
  dir: Vec2 | null;
  rank: number;
}

/** Every cut `p` is in (see trenchAt): a sunk junction alone, else each lowered road's. */
function cutsAt(lowered: Lowered[], p: Vec2, sunk: SunkJunction[], reach: number): Cut[] {
  for (const j of sunk) if (inBox(j.box, p) && pointInPolygon(p, j.poly)) return [{ y: j.y, road: -1, dir: null, rank: -Infinity }];
  const out: Cut[] = [];
  for (const l of lowered) {
    if (!inBox(l.box, p)) continue;
    const { s, d } = projectOnRoad(l.road, p);
    if (d > l.half + reach) continue;
    const h = profileAt(l.profile, s);
    if (h.lift >= DUG || claimedByRival(l, p, s, d)) continue;
    // Past the wall's own footing, never under a street at ground level (a pit in its lanes).
    if (d > l.half + WALL && l.rivals.some((r) => inBox(r.box, p) && projectOnRoad(r.road, p).d < r.road.width / 2 + 0.3)) continue;
    const y = surfaceY(l.city, h, p);
    out.push({ y, road: l.index, dir: dirOnRoad(l.road, s), rank: d <= l.road.width / 2 ? y - 1000 : d });
  }
  return out;
}

/**
 * Whether the ground at `p` stays on as a roof over the cut(s) under it: some street covers one
 * of them, and there's headroom over every floor there. Decided over all of them, not just the
 * nearest: where two cuts meet, choosing by the nearest one flips the roof on and off cell by
 * cell, and every flip is a cliff of ground standing in the tunnel.
 */
function roofAt(city: CityData, lowered: Lowered[], p: Vec2, sunk: SunkJunction[], reach: number, covered: (p: Vec2, dir?: Vec2 | null, cutRoad?: number) => boolean): boolean {
  const cuts = cutsAt(lowered, p, sunk, reach);
  if (!cuts.length) return false;
  const g = terrainAt(city, p);
  // Headroom over every asphalt there (or the nearest cut's floor, off the asphalt).
  const floors = cuts.some((c) => c.rank < -500) ? cuts.filter((c) => c.rank < -500) : [cuts.reduce((a, b) => (a.rank < b.rank ? a : b))];
  return floors.every((c) => g - c.y > HEADROOM) && cuts.some((c) => covered(p, c.dir, c.road));
}

/**
 * Where the ground stays on over an underpass: under the roads that cross over it (with a little
 * margin) and the junctions it runs beneath. The rest of the cut is open to the sky. `dir` is
 * the way the cut runs there (roads alongside it don't cover it).
 */
function coverTest(city: CityData, graph: RoadGraph, lowered: Lowered[]): (p: Vec2, dir?: Vec2 | null, cutRoad?: number) => boolean {
  const profiles = roadProfiles(city);
  const box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const l of lowered)
    for (const p of l.road.points) (box.x0 = Math.min(box.x0, p.x)), (box.x1 = Math.max(box.x1, p.x)), (box.z0 = Math.min(box.z0, p.z)), (box.z1 = Math.max(box.z1, p.z));
  const near = (p: Vec2) => p.x > box.x0 - 60 && p.x < box.x1 + 60 && p.z > box.z0 - 60 && p.z < box.z1 + 60;
  const boxes = roadBoxes(city);
  // Roads with a ramp of their own count too where they're back at street level (a link coming
  // up out of its cut and crossing over another underpass).
  const over = city.roads.map((r, i) => ({ r, i })).filter(({ r }) => r.points.some(near));
  const underpass = lowered.flatMap((l) => l.road.points.filter((_, k) => l.profile.lift[k] < DUG));
  const hulls = graph.nodes
    .filter((n) => n.hull && n.y === null && near(n.pos))
    .map((n) => ({ poly: n.hull!, box: boxOf(n.hull!, 0) }))
    .filter((h) => underpass.some((q) => inBox(h.box, q) && pointInPolygon(q, h.poly)));
  return (p, dir, cutRoad) =>
    hulls.some((h) => inBox(h.box, p) && pointInPolygon(p, h.poly)) ||
    over.some(({ r, i }) => {
      if (i === cutRoad || !inBox(boxes[i], p)) return false;
      const { s, d } = projectOnRoad(r, p);
      // Well past the street's edge, so its whole width (and sidewalk) has ground under it.
      if (d > r.width / 2 + ROOF_MARGIN) return false;
      if (dir) {
        const od = dirOnRoad(r, s);
        // Running alongside the cut doesn't cover it, unless OSM puts it on a higher level than
        // the cut's road (stacked, like an overpass above an underpass).
        const stacked = cutRoad !== undefined && cutRoad >= 0 && (r.layer ?? 0) > (city.roads[cutRoad].layer ?? 0);
        if (Math.abs(od.x * dir.x + od.z * dir.z) > PARALLEL && !stacked) return false;
      }
      const prof = profiles[i];
      return !prof || profileAt(prof, s).lift > DUG;
    });
}

/** Terrain cells to replace with the fine patch around every underpass. */
export function planTrenches(city: CityData, graph: RoadGraph): TrenchPlan | null {
  const t = city.terrain;
  const lowered = loweredRoads(city);
  if (!t || !lowered.length) return null;
  const cols = t.cols - 1;
  const base = new Set<number>();
  let floor = Infinity;
  const addCell = (q: Vec2) => {
    const c = Math.floor((q.x - t.minX) / t.cell);
    const r = Math.floor((q.z - t.minZ) / t.cell);
    if (c >= 0 && r >= 0 && c < cols && r < t.rows - 1) base.add(r * cols + c);
  };
  for (const j of sunkJunctions(city, graph)) {
    floor = Math.min(floor, j.y);
    for (let x = j.box.x0 - 1; x <= j.box.x1 + 1; x += 1) for (let z = j.box.z0 - 1; z <= j.box.z1 + 1; z += 1) addCell({ x, z });
  }
  for (const l of lowered) {
    const pts = l.road.points;
    for (let i = 0; i < pts.length; i++) {
      if (l.profile.lift[i] >= DUG) continue;
      floor = Math.min(floor, l.profile.y[i]);
      const d = i + 1 < pts.length ? unit(pts[i], pts[i + 1]) : unit(pts[i - 1], pts[i]);
      for (let o = -l.half - 1; o <= l.half + 1; o += 1) addCell({ x: pts[i].x - d.z * o, z: pts[i].z + d.x * o });
    }
  }
  // One more ring of cells, so the sunk heightfield never shows at the edge of the patch.
  const cells = new Set<number>();
  for (const k of base) {
    const r = Math.floor(k / cols);
    const c = k % cols;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < t.rows - 1 && cc < cols) cells.add(rr * cols + cc);
      }
  }
  const pit = new Set<number>();
  for (let r = 1; r < t.rows - 1; r++)
    for (let c = 1; c < t.cols - 1; c++) {
      const around = [(r - 1) * cols + c - 1, (r - 1) * cols + c, r * cols + c - 1, r * cols + c];
      if (around.every((k) => cells.has(k))) pit.add(r * t.cols + c);
    }
  return { cells, pit, pitY: floor - 4 };
}

/**
 * Bridges, underpasses and ramps: deck slabs, railings, embankments and pillars for raised
 * roads; floors, retaining walls, and the ground left on as a roof where streets pass over for
 * dug-in ones. The terrain over underpasses (the `plan` cells) is rebuilt here, finer, with the
 * open part of the cut left out.
 */
export function buildGrades(
  city: CityData,
  graph: RoadGraph,
  plan: TrenchPlan | null,
  solid: ChunkedMeshBuilder,
  groundColor: (x: number, z: number, out: THREE.Color) => THREE.Color,
  world: RAPIER.World,
  fixed: RAPIER.RigidBody,
): THREE.Mesh[] {
  const ground: Ground = (p) => terrainAt(city, p);
  const profiles = roadProfiles(city);
  const boxes = roadBoxes(city);
  const hullBoxes = graph.nodes.map((n) => (n.hull ? boxOf(n.hull, 0) : null));
  const deck = new Tris();
  /** A solid collider with exactly the shape of the given corner points (so it matches what's drawn). */
  const solidHull = (pts: THREE.Vector3Like[]) => {
    const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(pts.flatMap((p) => [p.x, p.y, p.z])));
    if (desc) world.createCollider(desc, fixed);
  };
  /** Another road's asphalt at `p` at a clearly different height than `y` (passing under or over). */
  const otherLevel = (self: number, p: Vec2, y: number) =>
    city.roads.some((r, i) => {
      if (i === self || !inBox(boxes[i], p)) return false;
      const { s, d } = projectOnRoad(r, p);
      if (d > r.width / 2 + 0.5) return false;
      const prof = profiles[i];
      const oy = prof ? profileAt(prof, s).y : ground(p);
      return Math.abs(oy - y) > 2;
    });
  /** Another road's asphalt at `p` whose surface is within a vehicle's height of `y`: no wall may stand there. */
  const onTraffic = (self: number, p: Vec2, y: number) =>
    city.roads.some((r, i) => {
      if (i === self || !inBox(boxes[i], p)) return false;
      const { s, d } = projectOnRoad(r, p);
      if (d > r.width / 2 + 0.3) return false;
      const prof = profiles[i];
      const oy = prof ? profileAt(prof, s).y : ground(p);
      return oy > y - 3.5 && oy < y + 1.5;
    });
  /** The lowest surface of another road whose asphalt is at `p` between `lo` and `hi` (it would run through a wall spanning those heights), or null. */
  const through = (self: number, p: Vec2, lo: number, hi: number): number | null => {
    let low: number | null = null;
    city.roads.forEach((r, i) => {
      if (i === self || !inBox(boxes[i], p)) return;
      const { s, d } = projectOnRoad(r, p);
      if (d > r.width / 2 + 0.3) return;
      const prof = profiles[i];
      const oy = prof ? profileAt(prof, s).y : ground(p);
      if (oy > lo && oy < hi && (low === null || oy < low)) low = oy;
    });
    return low;
  };
  /** Another road (or junction) joining at this height: no railing across it. */
  const joins = (self: number, p: Vec2, y: number) =>
    city.roads.some((r, i) => {
      if (i === self || !inBox(boxes[i], p)) return false;
      const { s, d } = projectOnRoad(r, p);
      if (d > r.width / 2 + 0.3) return false;
      const prof = profiles[i];
      const oy = prof ? profileAt(prof, s).y : ground(p);
      return Math.abs(oy - y) < 1.5;
    }) || graph.nodes.some((n, k) => n.hull && inBox(hullBoxes[k]!, p) && Math.abs((n.y ?? ground(n.pos)) - y) < 1.5 && pointInPolygon(p, n.hull));

  // ---- Raised roads: bridge decks and their ramps ------------------------------------------
  city.roads.forEach((road, ri) => {
    const prof = profiles[ri];
    if (!prof || !prof.lift.some((l) => l > RAISED)) return;
    const half = road.width / 2;
    const secs = sections(road, prof, 2);
    let pillarAt = -Infinity;
    for (let k = 1; k < secs.length; k++) {
      const a = secs[k - 1];
      const b = secs[k];
      if (Math.max(a.lift, b.lift) <= RAISED) continue;
      const mb = solid.at((a.p.x + b.p.x) / 2, (a.p.z + b.p.z) / 2);
      const edge = (s: Sec, o: number) => ({ x: s.p.x - s.d.z * o, z: s.p.z + s.d.x * o });
      const slab = (s: Sec) => Math.min(SLAB, Math.max(0.05, s.lift));
      // Road surface (the asphalt ribbon is drawn separately) is solid; the slab under it is not.
      const [la, ra, lb, rb] = [edge(a, -half), edge(a, half), edge(b, -half), edge(b, half)];
      deck.quad(v3(la, surfaceY(city, a, la)), v3(lb, surfaceY(city, b, lb)), v3(rb, surfaceY(city, b, rb)), v3(ra, surfaceY(city, a, ra)));
      mb.quad(v3(la, a.y - slab(a)), v3(ra, a.y - slab(a)), v3(rb, b.y - slab(b)), v3(lb, b.y - slab(b)), CONCRETE_DARK);
      for (const [side, pa, pb] of [
        [-1, la, lb],
        [1, ra, rb],
      ] as const) {
        mb.quad(v3(pa, a.y - slab(a)), v3(pb, b.y - slab(b)), v3(pb, b.y), v3(pa, a.y), CONCRETE);
        const mid = { x: (pa.x + pb.x) / 2, z: (pa.z + pb.z) / 2 };
        const y = (a.y + b.y) / 2;
        const heading = Math.atan2(-(pb.z - pa.z), pb.x - pa.x);
        const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        const out = { x: mid.x + (side * -a.d.z) * 1, z: mid.z + side * a.d.x * 1 };
        // Railing along the edge, unless a street joins here at the same height.
        if (Math.min(a.lift, b.lift) > 0.4 && !joins(ri, out, y) && !onTraffic(ri, mid, y)) {
          wallStrip(mb, pa, pb, a.y, b.y, PARAPET, 0.3, CONCRETE);
          solidHull(stripCorners(pa, pb, a.y - 0.2, b.y - 0.2, PARAPET + 0.2, 0.3));
        }
        // Under the edge: open over a road below, pillars when high, else an embankment wall.
        const g = Math.min(ground(pa), ground(pb));
        const bottom = Math.min(a.y - slab(a), b.y - slab(b));
        if (otherLevel(ri, mid, y) || bottom - g > PILLAR_CLEARANCE || bottom - g < 0.1) continue;
        mb.quad(v3(pa, g - 0.3), v3(pb, g - 0.3), v3(pb, b.y - slab(b)), v3(pa, a.y - slab(a)), CONCRETE_DARK);
        // Solid from that face inward, under the deck (nothing sticks out past the drawn edge).
        const ia = edge(a, side * (half - 0.3));
        const ib = edge(b, side * (half - 0.3));
        solidHull([v3(pa, g - 0.3), v3(pb, g - 0.3), v3(pa, a.y - slab(a)), v3(pb, b.y - slab(b)), v3(ia, g - 0.3), v3(ib, g - 0.3), v3(ia, a.y - slab(a)), v3(ib, b.y - slab(b))]);
      }
      // Pillars under the middle of high spans (not standing in a road below).
      if (a.s - pillarAt >= 12 && a.y - SLAB - ground(a.p) > PILLAR_CLEARANCE && !otherLevel(ri, a.p, a.y)) {
        pillarAt = a.s;
        const g = ground(a.p) - 0.3;
        const top = a.y - SLAB;
        const col = new THREE.CylinderGeometry(0.7, 0.8, top - g, 10);
        mb.add(col, new THREE.Matrix4().makeTranslation(a.p.x, (g + top) / 2, a.p.z), CONCRETE, CONCRETE);
        col.dispose();
        world.createCollider(RAPIER.ColliderDesc.cylinder((top - g) / 2, 0.8).setTranslation(a.p.x, (g + top) / 2, a.p.z), fixed);
      }
    }
  });
  // Nodes up on a deck (and down in a cut): a slab over the area where their roads meet, so
  // two pieces of deck meeting at an angle leave no gap.
  for (const n of graph.nodes) {
    if (n.y === null || Math.abs(n.lift) < RAISED) continue;
    const h = n.hull ?? nodeArea(graph, n.id);
    // A little under the roads' own surfaces (they slope across it): it only fills gaps.
    const y = n.y - 0.35;
    const at = (_q: Vec2) => y;
    for (let i = 1; i < h.length - 1; i++) deck.tri(v3(h[0], at(h[0])), v3(h[i], at(h[i])), v3(h[i + 1], at(h[i + 1])));
    // Drawn too (as concrete under the road), so no part of it is ever an invisible ledge.
    if (n.lift > 0) {
      const slab = new ConvexGeometry([...h.map((q) => new THREE.Vector3(q.x, at(q), q.z)), ...h.map((q) => new THREE.Vector3(q.x, at(q) - 0.6, q.z))]);
      solid.at(n.pos.x, n.pos.z).add(slab, new THREE.Matrix4(), CONCRETE_DARK, CONCRETE);
      slab.dispose();
    }
  }

  // ---- Dug-in roads: underpasses and their ramps --------------------------------------------
  const lowered = loweredRoads(city);
  const sunk = sunkJunctions(city, graph);
  const covered = lowered.length ? coverTest(city, graph, lowered) : () => false;
  for (const l of lowered) {
    const secs = sections(l.road, l.profile, 1.5);
    for (let k = 1; k < secs.length; k++) {
      const a = secs[k - 1];
      const b = secs[k];
      if (Math.min(a.lift, b.lift) >= DUG) continue;
      // Near the top of a ramp the dipped ground is the floor; a slab there would stick up
      // through a street-level road drawn overlapping it.
      const center = { x: (a.p.x + b.p.x) / 2, z: (a.p.z + b.p.z) / 2 };
      if (Math.min(a.lift, b.lift) > -0.5 && l.rivals.some((r) => inBox(r.box, center) && projectOnRoad(r.road, center).d < r.road.width / 2 + 1)) continue;
      const mb = solid.at((a.p.x + b.p.x) / 2, (a.p.z + b.p.z) / 2);
      const edge = (s: Sec, o: number) => ({ x: s.p.x - s.d.z * o, z: s.p.z + s.d.x * o });
      // Floor: the asphalt, plus a concrete shoulder each side unless another carriageway's
      // road is right there (divided avenues drawn close together).
      const w2 = l.road.width / 2;
      // Each vertex at the road surface under it (follows the ground's cross slope near the top).
      const fv = (s: Sec, o: number, lift = 0, along = 0) => {
        const e = edge(s, o);
        const q = { x: e.x + s.d.x * along, z: e.z + s.d.z * along };
        return v3(q, surfaceY(city, s, q) + lift);
      };
      // The shoulders and walls reach a little past the road's two ends, into the next road's:
      // where two ways meet at an angle, pieces that stop exactly at the joint leave a slit.
      const back = k === 1 ? -JOINT_OVERLAP : 0;
      const fore = k === secs.length - 1 ? JOINT_OVERLAP : 0;
      deck.quad(fv(a, -w2), fv(b, -w2), fv(b, w2), fv(a, w2));
      for (const side of [-1, 1]) {
        const o0 = side * w2;
        const o1 = side * l.half;
        const shoulderMid = { x: (edge(a, (o0 + o1) / 2).x + edge(b, (o0 + o1) / 2).x) / 2, z: (edge(a, (o0 + o1) / 2).z + edge(b, (o0 + o1) / 2).z) / 2 };
        if (otherFloor(lowered, l, shoulderMid)) continue;
        deck.quad(fv(a, o0), fv(b, o0), fv(b, o1), fv(a, o1));
        mb.quad(fv(a, o0, 0.01, back), fv(b, o0, 0.01, fore), fv(b, o1, 0.01, fore), fv(a, o1, 0.01, back), CONCRETE);
        // Retaining wall just outside the shoulder, or halfway to a street alongside, unless the
        // neighboring carriageway shares the cut.
        const reach = (sec: Sec) => {
          let o = l.half + WALL;
          while (o > l.road.width / 2 + WALL && claimedByRival(l, edge(sec, side * o), sec.s, o)) o -= 0.25;
          return o;
        };
        const ra = reach(a);
        const rb = reach(b);
        const pa = edge(a, side * (ra - WALL / 2));
        const pb = edge(b, side * (rb - WALL / 2));
        const mid = { x: (pa.x + pb.x) / 2, z: (pa.z + pb.z) / 2 };
        const beyond = edge(a, side * (l.half + WALL + 0.8));
        // (Sharing means a floor at about ours: a ramp passing over the cut near the top of its
        // own climb is a street above it, and the wall stands under it.)
        const shared = trenchAt(lowered.filter((o) => o !== l), beyond, sunk);
        if (shared && Math.abs(shared.y - (a.y + b.y) / 2) < 2.5) continue;
        // Another ramp's asphalt right where the wall would stand, at about our floor's height: a
        // carriageway alongside that starts down a little later (so not `shared` here). A wall
        // there stands across its lanes.
        if (rampAlongside(lowered, l, mid, (a.y + b.y) / 2)) continue;
        const ga = ground(pa);
        const gb = ground(pb);
        if (Math.max(ga - a.y, gb - b.y) < 0.2) continue;
        // Under a street passing over, the wall stops at the roof; in the open it has a parapet.
        // Roofed if any of it is under the roof: a parapet must never stand up into the street above.
        const deep = Math.min(ga - a.y, gb - b.y) > HEADROOM;
        const roof = deep && (covered(mid, a.d, l.index) || covered(pa, a.d, l.index) || covered(pb, a.d, l.index));
        let top = roof ? -0.05 : PARAPET;
        // Another road running where the wall would stand (OSM draws some carriageways
        // overlapping): one coming in partway down (a link branching off) leaves an opening;
        // a street at ground level just gets the wall stopping flush under it, as under a roof
        // (no wall at all would leave the cut's side open, see-through).
        const other = through(l.index, mid, Math.min(a.y, b.y) + 0.5, Math.min(ga, gb) + top - 0.1);
        if (other !== null && other < Math.min(ga, gb) - 0.6) continue;
        if (other !== null) top = -0.05;
        const flush = roof || other !== null;
        const reachOut = (q: Vec2, sec: Sec, along: number) => ({ x: q.x + sec.d.x * along, z: q.z + sec.d.z * along });
        const inner = { a: reachOut(edge(a, side * (ra - WALL)), a, back), b: reachOut(edge(b, side * (rb - WALL)), b, fore) };
        const outer = { a: reachOut(edge(a, side * ra), a, back), b: reachOut(edge(b, side * rb), b, fore) };
        mb.quad(v3(inner.a, a.y - 0.2), v3(inner.b, b.y - 0.2), v3(inner.b, gb + top), v3(inner.a, ga + top), CONCRETE);
        mb.quad(v3(inner.a, ga + top), v3(inner.b, gb + top), v3(outer.b, gb + top), v3(outer.a, ga + top), CONCRETE_DARK);
        // The back and the ends too, even when buried: next to another cut (a link splitting
        // off) they're in the open, and an undrawn face there is an invisible wall.
        mb.quad(v3(outer.a, a.y - 0.3), v3(outer.b, b.y - 0.3), v3(outer.b, gb + top), v3(outer.a, ga + top), CONCRETE);
        mb.quad(v3(inner.a, a.y - 0.3), v3(outer.a, a.y - 0.3), v3(outer.a, ga + top), v3(inner.a, ga + top), CONCRETE);
        mb.quad(v3(inner.b, b.y - 0.3), v3(outer.b, b.y - 0.3), v3(outer.b, gb + top), v3(inner.b, gb + top), CONCRETE);
        if (!flush) {
          // Walkway along the top, over the ground dug under the wall (unless a street is there).
          const apron = { a: edge(a, side * (ra + APRON)), b: edge(b, side * (rb + APRON)) };
          const apronMid = { x: (apron.a.x + apron.b.x) / 2, z: (apron.a.z + apron.b.z) / 2 };
          if (!onTraffic(l.index, apronMid, ground(apronMid))) {
            mb.quad(v3(outer.a, ga + 0.04), v3(outer.b, gb + 0.04), v3(apron.b, ground(apron.b) + 0.04), v3(apron.a, ground(apron.a) + 0.04), CONCRETE);
          }
        }
        // Solid exactly where the wall is drawn: from its inner face out to its outer face. Two
        // hulls split along the drawn top's diagonal: where the wall's two ends stand at different
        // offsets its top isn't flat, and one hull would bulge over the drawn triangles.
        const [ia, ib, oa, ob] = [inner.a, inner.b, outer.a, outer.b];
        solidHull([v3(ia, a.y - 0.3), v3(ib, b.y - 0.3), v3(ob, b.y - 0.3), v3(ia, ga + top), v3(ib, gb + top), v3(ob, gb + top)]);
        solidHull([v3(ia, a.y - 0.3), v3(ob, b.y - 0.3), v3(oa, a.y - 0.3), v3(ia, ga + top), v3(ob, gb + top), v3(oa, ga + top)]);
      }
    }
  }
  // Junctions down in a cut: solid floor, and a wall along each side no road comes in from.
  for (const j of sunk) {
    const h = j.poly;
    for (let i = 1; i < h.length - 1; i++) deck.tri(v3(h[0], j.y), v3(h[i], j.y), v3(h[i + 1], j.y));
    const cx = h.reduce((acc, q) => acc + q.x, 0) / h.length;
    const cz = h.reduce((acc, q) => acc + q.z, 0) / h.length;
    for (let i = 0; i < h.length; i++) {
      const a = h[i];
      const b = h[(i + 1) % h.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 0.5) continue;
      const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      let n = { x: -d.z, z: d.x };
      if (n.x * ((a.x + b.x) / 2 - cx) + n.z * ((a.z + b.z) / 2 - cz) < 0) n = { x: -n.x, z: -n.z };
      const steps = Math.max(1, Math.round(len / 1.5));
      for (let k = 0; k < steps; k++) {
        const pa = { x: a.x + d.x * (len * k) / steps, z: a.z + d.z * (len * k) / steps };
        const pb = { x: a.x + d.x * (len * (k + 1)) / steps, z: a.z + d.z * (len * (k + 1)) / steps };
        const mid = { x: (pa.x + pb.x) / 2, z: (pa.z + pb.z) / 2 };
        // A road comes in here: no wall across it.
        if (trenchAt(lowered, { x: mid.x + n.x * 1.2, z: mid.z + n.z * 1.2 })) continue;
        const ga = ground(pa);
        const gb = ground(pb);
        if (Math.max(ga, gb) - j.y < 0.2) continue;
        const top = covered(mid) && Math.min(ga, gb) - j.y > HEADROOM ? -0.05 : PARAPET;
        const mb = solid.at(mid.x, mid.z);
        mb.quad(v3(pa, j.y - 0.2), v3(pb, j.y - 0.2), v3(pb, gb + top), v3(pa, ga + top), CONCRETE);
        const qa = { x: pa.x + n.x * WALL, z: pa.z + n.z * WALL };
        const qb = { x: pb.x + n.x * WALL, z: pb.z + n.z * WALL };
        // Top, back and ends (see the retaining walls above).
        mb.quad(v3(pa, ga + top), v3(pb, gb + top), v3(qb, gb + top), v3(qa, ga + top), CONCRETE);
        mb.quad(v3(qa, j.y - 0.3), v3(qb, j.y - 0.3), v3(qb, gb + top), v3(qa, ga + top), CONCRETE);
        mb.quad(v3(pa, j.y - 0.3), v3(qa, j.y - 0.3), v3(qa, ga + top), v3(pa, ga + top), CONCRETE);
        mb.quad(v3(pb, j.y - 0.3), v3(qb, j.y - 0.3), v3(qb, gb + top), v3(pb, gb + top), CONCRETE);
        solidHull([v3(pa, j.y - 0.3), v3(pb, j.y - 0.3), v3(pa, ga + top), v3(pb, gb + top), v3(qa, j.y - 0.3), v3(qb, j.y - 0.3), v3(qa, ga + top), v3(qb, gb + top)]);
      }
    }
  }

  const meshes: THREE.Mesh[] = [];
  if (plan && city.terrain) meshes.push(...terrainPatch(city, plan, lowered, sunk, covered, groundColor, solid, world, fixed));
  if (deck.count) world.createCollider(RAPIER.ColliderDesc.trimesh(deck.positions(), deck.indices()).setFriction(1), fixed);
  return meshes;
}

/**
 * The terrain over and around underpasses, at 1 m resolution: the open part of the cut left
 * out, the part under streets kept as a roof (with a ceiling under it and railings at its open
 * edges). Replaces the coarse terrain (mesh and collider) in the plan's cells.
 */
function terrainPatch(
  city: CityData,
  plan: TrenchPlan,
  lowered: Lowered[],
  sunk: SunkJunction[],
  covered: (p: Vec2, dir?: Vec2 | null, cutRoad?: number) => boolean,
  groundColor: (x: number, z: number, out: THREE.Color) => THREE.Color,
  solid: ChunkedMeshBuilder,
  world: RAPIER.World,
  fixed: RAPIER.RigidBody,
): THREE.Mesh[] {
  const t = city.terrain!;
  const cols = t.cols - 1;
  const n = Math.round(t.cell / FINE);
  const tris = new Tris();
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const open = new Map<string, boolean>();
  const isOpen = (x: number, z: number) => {
    const key = `${x},${z}`;
    let v = open.get(key);
    if (v === undefined) {
      const p = { x: x + FINE / 2, z: z + FINE / 2 };
      v = !!trenchAt(lowered, p, sunk) && !roofAt(city, lowered, p, sunk, 0, covered);
      open.set(key, v);
    }
    return v;
  };
  // Vertices: the ground, dipped down to the road floor inside the open part of the cut (so the
  // ground meets the floor with no edge a car could catch on). Under a roof it stays up.
  const vert = new Map<string, { y: number; roof: boolean; dipped: boolean }>();
  const vertex = (x: number, z: number) => {
    const key = `${x},${z}`;
    let v = vert.get(key);
    if (!v) {
      const g = terrainAt(city, { x, z });
      const cut = trenchAt(lowered, { x, z }, sunk, UNDER_WALL);
      const roof = !!cut && roofAt(city, lowered, { x, z }, sunk, UNDER_WALL, covered);
      const dipped = !!cut && !roof && cut.y - 0.03 < g;
      vert.set(key, (v = { y: dipped ? cut!.y - 0.03 : g, roof, dipped }));
    }
    return v;
  };
  const h = (x: number, z: number) => vertex(x, z).y;
  for (const k of plan.cells) {
    const r = Math.floor(k / cols);
    const cc = k % cols;
    const x0 = t.minX + cc * t.cell;
    const z0 = t.minZ + r * t.cell;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = x0 + i * FINE;
        const z = z0 + j * FINE;
        // A tunnel mouth: roof on one side, cut floor on the other. Left open (the road floor
        // is under it); anywhere else the dipped ground is the floor.
        const corners = [vertex(x, z), vertex(x, z + FINE), vertex(x + FINE, z), vertex(x + FINE, z + FINE)];
        // (Only where the road passes well below the roof; a shallow mouth is just a slope.)
        const roofY = Math.max(...corners.filter((q) => q.roof).map((q) => q.y));
        const floorY = Math.min(...corners.filter((q) => q.dipped).map((q) => q.y));
        if (roofY - floorY > 2 && overRoadFloor(lowered, { x: x + FINE / 2, z: z + FINE / 2 })) continue;
        const v = [
          { x, y: h(x, z), z },
          { x, y: h(x, z + FINE), z: z + FINE },
          { x: x + FINE, y: h(x + FINE, z), z },
          { x: x + FINE, y: h(x + FINE, z + FINE), z: z + FINE },
        ];
        for (const [a, b, d] of [
          [0, 1, 2],
          [2, 1, 3],
        ]) {
          for (const q of [v[a], v[b], v[d]]) {
            pos.push(q.x, q.y, q.z);
            // Ground dug down into the cut reads as part of its concrete walls.
            if (terrainAt(city, q) - q.y > 0.5) c.set(CONCRETE);
            else groundColor(q.x, q.z, c);
            col.push(c.r, c.g, c.b);
          }
          tris.tri(v[a], v[b], v[d]);
        }
        // Over the cut: a ceiling under the roof, and railings where the roof meets the open cut.
        const mid = { x: x + FINE / 2, z: z + FINE / 2 };
        const under = trenchAt(lowered, mid, sunk);
        if (!under || !roofAt(city, lowered, mid, sunk, 0, covered)) continue;
        const mb = solid.at(mid.x, mid.z);
        const y = h(mid.x, mid.z);
        mb.quad({ x, y: y - LINTEL, z }, { x: x + FINE, y: y - LINTEL, z }, { x: x + FINE, y: y - LINTEL, z: z + FINE }, { x, y: y - LINTEL, z: z + FINE }, CONCRETE_DARK);
        // And a dark bottom under it, just below the tunnel floor, so nothing looks through into the void.
        const fy = under.y - 0.15;
        mb.quad({ x, y: fy, z: z + FINE }, { x: x + FINE, y: fy, z: z + FINE }, { x: x + FINE, y: fy, z }, { x, y: fy, z }, CONCRETE_DARK);
        for (const [dx, dz, ax, az, bx, bz] of [
          [-1, 0, x, z, x, z + FINE],
          [1, 0, x + FINE, z, x + FINE, z + FINE],
          [0, -1, x, z, x + FINE, z],
          [0, 1, x, z + FINE, x + FINE, z + FINE],
        ]) {
          if (!isOpen(x + dx * FINE, z + dz * FINE)) continue;
          // A railing only where there's a real drop into the cut.
          if (y - h(x + dx * FINE + FINE / 2, z + dz * FINE + FINE / 2) < 1.5) continue;
          const pa = { x: ax, z: az };
          const pb = { x: bx, z: bz };
          // Lintel under the roof edge, and a railing on top.
          mb.quad(v3(pa, y - LINTEL), v3(pb, y - LINTEL), v3(pb, y), v3(pa, y), CONCRETE);
          wallStrip(mb, pa, pb, y, y, PARAPET, 0.12, RAIL);
          const desc = RAPIER.ColliderDesc.convexHull(new Float32Array(stripCorners(pa, pb, y - LINTEL, y - LINTEL, PARAPET + LINTEL, 0.12).flatMap((q) => [q.x, q.y, q.z])));
          if (desc) world.createCollider(desc, fixed);
        }
      }
  }
  // A dark floor under the whole patch at pit depth: any opening shows shadow, never the sky.
  const under = new THREE.Color(CONCRETE_DARK).multiplyScalar(0.45);
  for (const k of plan.cells) {
    const x0 = t.minX + (k % cols) * t.cell;
    const z0 = t.minZ + Math.floor(k / cols) * t.cell;
    const y = plan.pitY + 3.5;
    for (const [qx, qz] of [
      [x0, z0], [x0, z0 + t.cell], [x0 + t.cell, z0],
      [x0 + t.cell, z0], [x0, z0 + t.cell], [x0 + t.cell, z0 + t.cell],
    ]) {
      pos.push(qx, y, qz);
      col.push(under.r, under.g, under.b);
    }
  }
  world.createCollider(RAPIER.ColliderDesc.trimesh(tris.positions(), tris.indices()).setFriction(1), fixed);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g);
  mesh.name = 'trenchPatch';
  return [mesh];
}

interface Sec {
  s: number;
  p: Vec2;
  d: Vec2;
  y: number;
  lift: number;
}

/** Cross-sections along a lifted road every `step` meters (and at its points). */
function sections(road: Road, prof: RoadProfile, step: number): Sec[] {
  const out: Sec[] = [];
  const pts = road.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const u = k / n;
      const s = prof.cum[i] + len * u;
      const h = profileAt(prof, s);
      out.push({ s, p: { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }, d, y: h.y, lift: h.lift });
    }
  }
  const last = pts[pts.length - 1];
  const h = profileAt(prof, prof.cum[prof.cum.length - 1]);
  out.push({ s: prof.cum[prof.cum.length - 1], p: last, d: out.length ? out[out.length - 1].d : { x: 1, z: 0 }, y: h.y, lift: h.lift });
  return out;
}

/** The 8 corners of a wall like wallStrip's (for a collider of exactly that shape). */
function stripCorners(a: Vec2, b: Vec2, ya: number, yb: number, height: number, thick: number): THREE.Vector3Like[] {
  const d = unit(a, b);
  const o = { x: (-d.z * thick) / 2, z: (d.x * thick) / 2 };
  return [-1, 1].flatMap((s) => [
    { x: a.x + o.x * s, y: ya, z: a.z + o.z * s },
    { x: a.x + o.x * s, y: ya + height, z: a.z + o.z * s },
    { x: b.x + o.x * s, y: yb, z: b.z + o.z * s },
    { x: b.x + o.x * s, y: yb + height, z: b.z + o.z * s },
  ]);
}

/** A thin wall `height` tall along a-b standing on the given heights (both faces and the top). */
function wallStrip(mb: { quad: ChunkedMeshBuilder['quad'] }, a: Vec2, b: Vec2, ya: number, yb: number, height: number, thick: number, color: string): void {
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

/** Triangles for a static trimesh collider. */
class Tris {
  private pos: number[] = [];
  get count(): number {
    return this.pos.length / 9;
  }
  tri(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
  quad(a: THREE.Vector3Like, b: THREE.Vector3Like, c: THREE.Vector3Like, d: THREE.Vector3Like): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  positions(): Float32Array {
    return new Float32Array(this.pos);
  }
  indices(): Uint32Array {
    return new Uint32Array(this.pos.length / 3).map((_, i) => i);
  }
}

const v3 = (p: Vec2, y: number) => ({ x: p.x, y, z: p.z });

/** Convex area covered by the ends of the edges meeting at a node (for nodes without a hull). */
export function nodeArea(graph: RoadGraph, id: number): Vec2[] {
  const n = graph.nodes[id];
  const pts: Vec2[] = [];
  const add = (p: Vec2, d: Vec2, w: number) => pts.push({ x: p.x - d.z * (w / 2), z: p.z + d.x * (w / 2) }, { x: p.x + d.z * (w / 2), z: p.z - d.x * (w / 2) });
  for (const e of n.in) add(graph.edges[e].b, graph.edges[e].endDir, graph.edges[e].roadWidth);
  for (const e of n.out) add(graph.edges[e].a, graph.edges[e].dir, graph.edges[e].roadWidth);
  return convexHull(pts);
}

function unit(a: Vec2, b: Vec2): Vec2 {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
}
