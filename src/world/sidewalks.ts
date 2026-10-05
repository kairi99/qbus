import type { CityData, Vec2 } from './cityData';
import { bbox, pointInPolygon } from './geom';
import { type RoadGraph, dirAt, makePath, pointAt } from './roadGraph';
import { RoadIndex } from './roadIndex';
import { LIFTED, liftAlong } from './elevation';

export const SIDEWALK_WIDTH = 3;
const STEP = 3;
const PROBE = 0.25;
const HULL_CELL = 40;

/** A sidewalk cross-section: from/to are signed offsets (right of `dir`) from the road centerline. */
export interface SidewalkSection {
  p: Vec2;
  dir: Vec2;
  from: number;
  to: number;
}

/**
 * Sidewalk strips along both sides of every road, narrowed wherever they'd run onto asphalt
 * (a neighboring carriageway) or a paved junction. Returns runs of consecutive sections; a
 * gap in coverage starts a new run.
 */
export function sidewalkSections(city: CityData, graph: RoadGraph): SidewalkSection[][] {
  const roads = new RoadIndex(city.roads);
  const hulls = graph.nodes
    .filter((n) => n.hull)
    .map((n) => ({ poly: n.hull!, box: bbox(n.hull!) }));
  // Junction hulls bucketed by grid cell: each probe only looks at the few nearby.
  const cell = (x: number, z: number) => Math.floor(x / HULL_CELL) * 65536 + Math.floor(z / HULL_CELL);
  const near = new Map<number, typeof hulls>();
  for (const h of hulls)
    for (let x = Math.floor(h.box.min.x / HULL_CELL); x <= Math.floor(h.box.max.x / HULL_CELL); x++)
      for (let z = Math.floor(h.box.min.z / HULL_CELL); z <= Math.floor(h.box.max.z / HULL_CELL); z++) {
        const k = x * 65536 + z;
        const list = near.get(k);
        if (list) list.push(h);
        else near.set(k, [h]);
      }
  const paved = (q: Vec2) =>
    roads.onAsphalt(q, 0.05) ||
    (near.get(cell(q.x, q.z)) ?? []).some(
      (h) => q.x >= h.box.min.x && q.x <= h.box.max.x && q.z >= h.box.min.z && q.z <= h.box.max.z && pointInPolygon(q, h.poly),
    );

  const out: SidewalkSection[][] = [];
  for (const r of city.roads) {
    const path = makePath(r.points);
    const samples = new Set<number>([path.len]);
    for (let s = 0; s < path.len; s += STEP) samples.add(s);
    const along = [...samples].sort((a, b) => a - b);
    for (const side of [-1, 1]) {
      let run: SidewalkSection[] = [];
      for (const s of along) {
        const p = pointAt(path, s);
        // No sidewalk on bridges, in underpasses or up their ramps.
        if (Math.abs(liftAlong(r, s)) > LIFTED) {
          if (run.length > 1) out.push(run);
          run = [];
          continue;
        }
        const d = dirAt(path, Math.min(s, path.len - 0.01));
        // Widest clear strip starting at the curb, probed outward.
        const curb = r.width / 2 + 0.02;
        let clear = 0;
        for (let o = PROBE; o <= SIDEWALK_WIDTH + 1e-6; o += PROBE) {
          const off = side * (curb + o);
          if (paved({ x: p.x - d.z * off, z: p.z + d.x * off })) break;
          clear = o;
        }
        if (clear < PROBE * 2) {
          if (run.length > 1) out.push(run);
          run = [];
          continue;
        }
        // Stop half a probe short of whatever blocked us.
        const w = clear >= SIDEWALK_WIDTH ? SIDEWALK_WIDTH : clear - PROBE / 2;
        run.push({ p, dir: d, from: side * curb, to: side * (curb + w) });
      }
      if (run.length > 1) out.push(run);
    }
  }
  return out;
}
