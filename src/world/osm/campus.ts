import type { Building, Road, Vec2, Wall } from '../cityData';
import { bbox, pointInPolygon } from '../geom';
import { type OsmJson, nearestOnRoads } from './import';

/** Campuses smaller than this (m²) are just a building: no wall. */
const MIN_AREA = 2500;
const STEP = 2;
/** Walls stand this far out from the asphalt edge: behind the sidewalk. */
const SETBACK = 3.3;
/** Straight gaps between wall runs up to this long are closed with a plain wall. */
const MAX_BRIDGE = 14;

interface Context {
  toXZ: (lat: number, lon: number) => Vec2;
  roads: Road[];
  buildings: Building[];
  onJunction: (p: Vec2) => boolean;
  inside: (p: Vec2) => boolean;
  /** Spots walls must leave alone (shelters, Metro entrances, platforms). */
  keepClear: (p: Vec2) => boolean;
}

type Kind = 'wall' | 'crossing' | 'gap';

/**
 * Walls around closed campus grounds (universities, schools, hospitals, barracks): the bus
 * can't cut through them. The OSM outline is walked in 2 m steps; where it runs along a
 * street it's pushed back behind the sidewalk, and buildings on the outline stand in for the
 * wall. Public streets running through the grounds stay open, walled on both sides.
 */
export function importCampuses(osm: OsmJson, ctx: Context): Wall[] {
  const walls: Wall[] = [];
  for (const e of osm.elements) {
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 4) continue;
    const ring = e.geometry.map((g) => ctx.toXZ(g.lat, g.lon));
    if (Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].z - ring[ring.length - 1].z) > 1) continue;
    const area = signedArea(ring);
    if (Math.abs(area) < MIN_AREA || !ring.some((p) => ctx.inside(p))) continue;
    // Counter-clockwise on the map (area > 0): the inside is to the left of travel.
    const inward = (d: Vec2): Vec2 => (area > 0 ? { x: d.z, z: -d.x } : { x: -d.z, z: d.x });
    const box = bbox(ring);
    const roads = ctx.roads.filter((r) => {
      const b = bbox(r.points);
      return b.min.x < box.max.x + 30 && b.max.x > box.min.x - 30 && b.min.z < box.max.z + 30 && b.max.z > box.min.z - 30;
    });

    const samples: { p: Vec2; kind: Kind }[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const inn = inward(d);
      for (let s = 0; s < len; s += STEP) {
        const p = { x: a.x + d.x * s, z: a.z + d.z * s };
        samples.push(placeSample(p, d, inn, roads, ctx));
      }
    }
    if (samples.length < 3) continue;

    // Rotate so the loop starts on a wall piece, then split it into runs of the same kind.
    const start = samples.findIndex((s) => s.kind === 'wall');
    if (start < 0) continue;
    const loop = [...samples.slice(start), ...samples.slice(0, start)];
    const runs: { kind: Kind; pts: Vec2[] }[] = [];
    for (const s of loop) {
      const last = runs[runs.length - 1];
      if (last && last.kind === s.kind) last.pts.push(s.p);
      else runs.push({ kind: s.kind, pts: [s.p] });
    }
    // Close the loop: the last run ends where the first begins.
    runs[runs.length - 1].pts.push(loop[0].p);

    let cur: Vec2[] = [];
    const flush = () => {
      if (cur.length > 1) walls.push({ points: cur });
      cur = [];
    };
    runs.forEach((run, i) => {
      if (run.kind === 'wall') {
        // A sample pushed out past the wrong street at a corner lands across it: never run a
        // wall over the asphalt to get there.
        for (const p of run.pts) {
          if (cur.length && crossesStreet(cur[cur.length - 1], p, roads)) flush();
          cur.push(p);
        }
        return;
      }
      const before = runs[i - 1]?.pts.at(-1);
      const after = runs[i + 1]?.pts[0] ?? loop[0].p;
      // A street runs in: the walls along it take over.
      if (run.kind === 'crossing') return flush();
      // A gap (building, junction corner, something to keep clear): bridge it if short and clear.
      if (before && after && Math.hypot(after.x - before.x, after.z - before.z) < MAX_BRIDGE && clearLine(before, after, roads, ctx)) return;
      flush();
    });
    flush();
    walls.push(...throughStreetWalls(ring, roads, ctx));
  }
  return walls;
}

/** Walls along both sides of streets that cross the grounds (not ones along its edge). */
function throughStreetWalls(ring: Vec2[], roads: Road[], ctx: Context): Wall[] {
  const out: Wall[] = [];
  for (const r of roads) {
    const reach = r.width / 2 + SETBACK;
    for (const side of [1, -1]) {
      let cur: Vec2[] = [];
      const flush = () => {
        if (cur.length > 1) out.push({ points: cur });
        cur = [];
      };
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i];
        const b = r.points[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 1e-6) continue;
        const d = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
        const n = { x: -d.z * side, z: d.x * side };
        for (let s = 0; s <= len; s += STEP) {
          const c = { x: a.x + d.x * s, z: a.z + d.z * s };
          const p = { x: c.x + n.x * reach, z: c.z + n.z * reach };
          const across = { x: c.x - n.x * reach, z: c.z - n.z * reach };
          const ok =
            pointInPolygon(p, ring) &&
            pointInPolygon(across, ring) &&
            !ctx.onJunction(p) &&
            !ctx.keepClear(p) &&
            !ctx.buildings.some((bd) => pointInPolygon(p, bd.footprint)) &&
            roads.every((o) => (nearestOnRoads([o], p)?.dist ?? Infinity) >= o.width / 2 + SETBACK - 0.1);
          if (ok) cur.push(p);
          else flush();
        }
      }
      flush();
    }
  }
  return out;
}

/**
 * Where a wall sample goes: pushed out of the street and its sidewalk toward the grounds;
 * a crossing where a street runs into the grounds; a gap where a building (or something to
 * keep clear) is already there.
 */
function placeSample(p: Vec2, dir: Vec2, inward: Vec2, roads: Road[], ctx: Context): { p: Vec2; kind: Kind } {
  let q = p;
  for (let pass = 0; pass < 3; pass++) {
    const near = nearestOnRoads(roads, q);
    if (!near) break;
    const reach = near.road.width / 2 + SETBACK;
    if (near.dist >= reach) break;
    // The outline crosses the street (rather than running along it): a gate.
    if (near.dist < near.road.width / 2 + 0.5 && Math.abs(dir.x * near.dir.x + dir.z * near.dir.z) < 0.7) return { p: q, kind: 'crossing' };
    // Push behind the sidewalk, on the grounds' side of the street.
    let n = { x: -near.dir.z, z: near.dir.x };
    if (n.x * inward.x + n.z * inward.z < 0) n = { x: -n.x, z: -n.z };
    q = { x: near.point.x + n.x * (reach + 0.05), z: near.point.z + n.z * (reach + 0.05) };
  }
  const onRoad = roads.some((r) => (nearestOnRoads([r], q)?.dist ?? Infinity) < r.width / 2 + SETBACK - 0.1);
  if (ctx.onJunction(q)) return { p: q, kind: onRoad ? 'crossing' : 'gap' };
  if (onRoad || ctx.keepClear(q) || ctx.buildings.some((b) => pointInPolygon(q, b.footprint))) return { p: q, kind: 'gap' };
  return { p: q, kind: 'wall' };
}

/** Whether a straight wall from `a` to `b` would run over a street's asphalt. */
function crossesStreet(a: Vec2, b: Vec2, roads: Road[]): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  for (let s = 0; s <= len; s += 0.5) {
    const p = { x: a.x + ((b.x - a.x) * s) / (len || 1), z: a.z + ((b.z - a.z) * s) / (len || 1) };
    if (roads.some((r) => (nearestOnRoads([r], p)?.dist ?? Infinity) < r.width / 2)) return true;
  }
  return false;
}

function clearLine(a: Vec2, b: Vec2, roads: Road[], ctx: Context): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  for (let s = 0; s <= len; s += 1) {
    const p = { x: a.x + ((b.x - a.x) * s) / len, z: a.z + ((b.z - a.z) * s) / len };
    if (ctx.onJunction(p) || roads.some((r) => (nearestOnRoads([r], p)?.dist ?? Infinity) < r.width / 2 + 1)) return false;
  }
  return true;
}

function signedArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i].x * ring[i + 1].z - ring[i + 1].x * ring[i].z;
  // x east, z south: flip so counter-clockwise on the map is positive.
  return -a / 2;
}
