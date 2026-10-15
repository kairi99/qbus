import type { Road, Vec2 } from '../cityData';
import { distToPolyline } from '../geom';
import { liftAlong, projectOnRoad } from '../elevation';

/**
 * Segregated BRT busways (Trolebús, Ecovía, Metrobus lanes), imported as roads with
 * `access: 'brt'`.
 *
 * Which OSM ways count: `highway=service` + `access=no` + `bus=designated|yes` or
 * `psv=designated|yes` (35 ways in La Mariscal; the trolley-wire ones are the Trolebús). They are
 * physically separate carriageways, usually in the median of a divided avenue, which is what
 * makes them a different thing from the *painted* bus lanes of Av. América (`bus:lanes=designated||`)
 * and the `psv:lanes` of 12 de Octubre/Universitaria: those share the carriageway with cars
 * (the lane is just one of the `lanes` of an ordinary road), so they stay ordinary roads.
 */
export function isBusway(t: Record<string, string>): boolean {
  if (t.highway !== 'service' || t.access !== 'no') return false;
  const on = (v: string | undefined) => v === 'designated' || v === 'yes';
  return on(t.bus) || on(t.psv);
}

/** One busway lane, meters: a 2.55 m articulated bus with room to spare. */
export const BUSWAY_LANE = 3.4;
/** Clear space kept between a busway's edge and an ordinary road's asphalt (a curb strip). */
export const BUSWAY_GAP = 0.5;
/** Name of a busway road (OSM has none): never used as a street name. */
export const BUSWAY_NAME = 'Carril exclusivo';

/** Width of a busway road: one lane per direction. */
export function buswayWidth(lanes: number, oneway: boolean): number {
  return round(BUSWAY_LANE * (oneway ? lanes : Math.max(2, lanes)), 1);
}

/** Roads that ordinary traffic can use. */
export const generalRoads = (roads: Road[]): Road[] => roads.filter((r) => !r.access);

/** The nearest busway road to `p` within `reach` (centerline distance), with the nearest point and its direction. */
export function nearestBusway(roads: Road[], p: Vec2, reach: number): { road: Road; point: Vec2; dir: Vec2; dist: number } | null {
  let best: { road: Road; point: Vec2; dir: Vec2; dist: number } | null = null;
  for (const road of roads) {
    if (road.access !== 'brt') continue;
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
      if (dist <= reach && (!best || dist < best.dist)) best = { road, point, dir: { x: dx / len, z: dz / len }, dist };
    }
  }
  return best;
}

/** Spacing of the resampled interior points of a busway pushed off ordinary asphalt. */
const STEP = 4;
/** A busway only moves this far sideways (OSM puts it right, the avenues' generic widths are fat). */
const MAX_PUSH = 3.2;
/** Original vertices this close to another road are junction joins: never moved. */
const PIN = 0.06;
/** The push tapers to nothing this far from a pinned point. */
const TAPER = 14;

/**
 * Pushes each busway sideways, off the asphalt of ordinary roads it would overlap (OSM draws the
 * median busway right against the carriageways, and ours are drawn with generic lane widths), so
 * it keeps `BUSWAY_GAP` of curb from their edge when the median has the room. The ends of the
 * way and every vertex shared with another road (a junction) stay exactly where OSM put them,
 * and the push tapers off toward them, so every join in the road graph stays exact.
 */
export function clearBusways(roads: Road[]): Road[] {
  const general = generalRoads(roads);
  const busways = roads.filter((r) => r.access === 'brt');
  return roads.map((road) => {
    if (road.access !== 'brt' || road.points.length < 2) return road;
    const { pts, pin, cum, toPin } = resampled(road, roads);
    if (pts.length < 3) return road;
    const hw = road.width / 2;
    const need = hw + BUSWAY_GAP;
    const push = pts.map((p, i): Vec2 => {
      if (pin[i]) return { x: 0, z: 0 };
      // Away from the nearest asphalt that's too close; skipped where the centerlines coincide.
      let v = { x: 0, z: 0 };
      for (const o of general) {
        const q = nearestPoint(o.points, p);
        const d = Math.hypot(p.x - q.x, p.z - q.z);
        const m = d - o.width / 2;
        if (d < 0.3 || m >= need) continue;
        const k = Math.min(MAX_PUSH, need - m);
        v = { x: v.x + ((p.x - q.x) / d) * k, z: v.z + ((p.z - q.z) / d) * k };
      }
      const l = Math.hypot(v.x, v.z);
      if (l > MAX_PUSH) v = { x: (v.x / l) * MAX_PUSH, z: (v.z / l) * MAX_PUSH };
      // A lane apart from a busway alongside: a pair of one-way busways in a median gets pushed
      // inward by both carriageways and would merge into one lane, where oncoming buses meet nose
      // to nose. Each keeps half of the room between their lanes (the other one moves too), and
      // where OSM draws them closer (fanning out of a shared node) each moves half the shortfall
      // away. Only a busway beside this one counts, not the next piece of the way ahead.
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      for (const o of busways) {
        if (o === road) continue;
        const q = nearestPoint(o.points, p);
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < 0.3) continue;
        const n = { x: (q.x - p.x) / d, z: (q.z - p.z) / d };
        if (Math.abs((n.x * (b.x - a.x) + n.z * (b.z - a.z)) / tl) > 0.5) continue;
        const room = (d - hw - o.width / 2) / 2;
        const over = v.x * n.x + v.z * n.z - room;
        if (over > 0) v = { x: v.x - n.x * over, z: v.z - n.z * over };
      }
      return v;
    });
    // Smooth the pushes along the way, then taper them toward the pinned points.
    for (let pass = 0; pass < 3; pass++)
      for (let i = 1; i < pts.length - 1; i++) {
        if (pin[i]) continue;
        push[i] = { x: (push[i - 1].x + 2 * push[i].x + push[i + 1].x) / 4, z: (push[i - 1].z + 2 * push[i].z + push[i + 1].z) / 4 };
      }
    const moved = pts.map((p, i) => {
      if (pin[i]) return p;
      const k = Math.min(1, toPin[i] / TAPER);
      return { x: round(p.x + push[i].x * k, 2), z: round(p.z + push[i].z * k, 2) };
    });
    return { ...road, points: moved.filter((p, i) => i === 0 || Math.hypot(p.x - moved[i - 1].x, p.z - moved[i - 1].z) > 0.05 || i === moved.length - 1) };
  });
}

/** A busway resampled every few meters; `pin` marks the points that must not move (ends, shared vertices), `toPin` the way-distance to the nearest one. */
function resampled(road: Road, roads: Road[]): { pts: Vec2[]; pin: boolean[]; cum: number[]; toPin: number[] } {
  const pinned = (p: Vec2) => roads.some((o) => o !== road && distToPolyline(p, o.points) < PIN);
  const pts: Vec2[] = [];
  const pin: boolean[] = [];
  for (let i = 0; i < road.points.length; i++) {
    const p = road.points[i];
    pts.push(p);
    pin.push(i === 0 || i === road.points.length - 1 || pinned(p));
    if (i < road.points.length - 1) {
      const q = road.points[i + 1];
      const n = Math.floor(Math.hypot(q.x - p.x, q.z - p.z) / STEP);
      for (let k = 1; k < n; k++) pts.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n }), pin.push(false);
    }
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const toPin = pts.map((_, i) => {
    let d = Infinity;
    pin.forEach((is, j) => {
      if (is) d = Math.min(d, Math.abs(cum[i] - cum[j]));
    });
    return d;
  });
  return { pts, pin, cum, toPin };
}

/**
 * Moves a busway sideways by `shift` around a station at `at` (full over `flat` meters along
 * `axis`, tapering to nothing `taper` meters further), keeping its ends and junction vertices exactly.
 */
export function shiftBusway(road: Road, roads: Road[], at: Vec2, axis: Vec2, shift: Vec2, flat = 18, taper = 16): Road {
  const { pts, pin, toPin } = resampled(road, roads);
  const moved = pts.map((p, i) => {
    if (pin[i]) return p;
    const t = Math.abs((p.x - at.x) * axis.x + (p.z - at.z) * axis.z);
    const k = Math.min(1, toPin[i] / TAPER) * Math.max(0, Math.min(1, (flat + taper - t) / taper));
    return k > 0 ? { x: round(p.x + shift.x * k, 2), z: round(p.z + shift.z * k, 2) } : p;
  });
  return { ...road, points: moved };
}

function nearestPoint(poly: Vec2[], p: Vec2): Vec2 {
  let best = poly[0];
  let bestD = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
    const q = { x: a.x + dx * u, z: a.z + dz * u };
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (d < bestD) (bestD = d), (best = q);
  }
  return best;
}

/** A busway keeps this far (from its edge) clear of a bridge, underpass or ramp's asphalt. */
const STRUCTURE_MARGIN = 12;
/** Pieces of a clipped busway shorter than this are dropped. */
const MIN_PIECE = 12;

/**
 * Busways run on the ground and the grade solver leaves them out, so where one would lie over or
 * beside a bridge, underpass or ramp (a street-level road above a cut, or alongside its walls) the
 * stretch is not imported: the structures stay exactly what they are without busways (their roofs,
 * walls and ramps were solved for the street network alone). Returns the busways cut into the
 * pieces that remain; cut ends are plain dead ends (no junction), whole busways away from any
 * structure come back untouched (same object).
 */
export function clipBusways(busways: Road[], roads: Road[]): Road[] {
  const lifted = roads.filter((r) => !r.access && r.lift?.some((l) => Math.abs(l) > 0.3));
  const near = (p: Vec2, hw: number) =>
    lifted.some((o) => {
      if (distToPolyline(p, o.points) >= o.width / 2 + hw + STRUCTURE_MARGIN) return false;
      // Off the ground there, or within 30 m along the road of where it is (a ramp's foot).
      const { s } = projectOnRoad(o, p);
      for (let k = -30; k <= 30; k += 10) if (Math.abs(liftAlong(o, Math.max(0, s + k))) > 0.3) return true;
      return false;
    });
  const out: Road[] = [];
  for (const road of busways) {
    const { pts, pin, cum } = resampled(road, busways.concat(roads));
    const bad = pts.map((p) => near(p, road.width / 2));
    if (!bad.some(Boolean)) {
      out.push(road);
      continue;
    }
    let from = -1;
    const flush = (to: number) => {
      if (from >= 0 && cum[to] - cum[from] >= MIN_PIECE) out.push({ ...road, points: pts.slice(from, to + 1) });
      from = -1;
    };
    pts.forEach((_, i) => {
      if (bad[i]) flush(i - 1);
      else if (from < 0) from = i;
    });
    flush(pts.length - 1);
    void pin;
  }
  return out;
}

/** True when `p` is on a busway's asphalt. */
export function onBusway(roads: Road[], p: Vec2): boolean {
  return roads.some((r) => r.access === 'brt' && distToPolyline(p, r.points) < r.width / 2);
}

function round(v: number, d: number): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
