import type { Building, MetroEntrance, Road, Station, Stop, TransitSystem, Vec2 } from '../cityData';
import { forward, right } from '../cityData';
import { distToPolyline, pointInPolygon } from '../geom';
import { type OsmJson, nearestOnRoads, tidyStopName } from './import';
import { METRO_ENTRANCE as ENTRANCE } from '../metro';
import { makePath, pointAt } from '../roadGraph';
import { BUSWAY_GAP, generalRoads, nearestBusway, shiftBusway } from './busways';

/** Stop positions of one system closer than this are the same station. */
const CLUSTER = 45;
const MAX_LENGTH = 32;
/** A platform beside a busway needs no more than an articulated bus and a little (keeps shelters and trees nearby). */
const BUSWAY_MAX_LENGTH = 24;
const MIN_LENGTH = 12;
/** A platform this long fits a whole bus with room to spare. */
const GOOD_LENGTH = 20;
const MAX_WIDTH = 11;
const MIN_WIDTH = 2.2;
/** Width of a platform at the curb (no median to fit). */
const CURB_WIDTH = 3;
/** Clear space between a platform and the asphalt. */
const ASPHALT_GAP = 0.5;

/** Trolebús, Ecovía or Metrobus, from a route relation's tags; null for ordinary lines. */
export function transitSystem(t: Record<string, string>): TransitSystem | null {
  const n = `${t.name ?? ''} ${t.ref ?? ''}`.toLowerCase();
  if (/ecov/.test(n)) return 'ecovia';
  if (t.route === 'trolleybus' || /trole/.test(n)) return 'trolebus';
  if (/metro-?bus/.test(n)) return 'metrobus';
  return null;
}

interface Context {
  toXZ: (lat: number, lon: number) => Vec2;
  roads: Road[];
  buildings: Building[];
  onJunction: (p: Vec2) => boolean;
  inside: (p: Vec2) => boolean;
}

type Cluster = { system: TransitSystem; names: string[]; at: Vec2 };

/** Stop positions of Trolebús/Ecovía/Metrobus route relations, clustered into stations. */
function clusterStops(stationsOsm: OsmJson, routesOsm: OsmJson, toXZ: Context['toXZ'], inside: (p: Vec2) => boolean): Cluster[] {
  const systemOf = new Map<number, TransitSystem>();
  for (const e of routesOsm.elements) {
    const sys = e.type === 'relation' ? transitSystem(e.tags ?? {}) : null;
    if (sys) for (const m of e.members ?? []) if (m.type === 'node' && m.ref) systemOf.set(m.ref, sys);
  }
  const clusters: { system: TransitSystem; names: string[]; pts: Vec2[] }[] = [];
  for (const e of stationsOsm.elements) {
    const sys = systemOf.get(e.id);
    if (e.type !== 'node' || !sys || e.tags?.public_transport !== 'stop_position') continue;
    const p = toXZ(e.lat!, e.lon!);
    if (!inside(p)) continue;
    const name = e.tags.name?.trim();
    let c = clusters.find((k) => k.system === sys && k.pts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < CLUSTER));
    if (!c) clusters.push((c = { system: sys, names: [], pts: [] }));
    c.pts.push(p);
    if (name) c.names.push(name);
  }
  return clusters.map((c) => ({ system: c.system, names: c.names, at: { x: avg(c.pts.map((p) => p.x)), z: avg(c.pts.map((p) => p.z)) } }));
}

/**
 * Rapid-transit stations and Metro entrances. BRT stations are built from the stop positions
 * of Trolebús/Ecovía/Metrobus route relations: in the median between the two carriageways of
 * the avenue (boarded from the left, like the real ones), else at the curb. Each carriageway
 * beside a platform gets a stop for the game. Run `widenMedians` on the roads first.
 */
export function importStations(
  stationsOsm: OsmJson,
  routesOsm: OsmJson,
  ctx: Context,
): { stations: Station[]; stops: Stop[]; metro: MetroEntrance[] } {
  const stations: Station[] = [];
  const stops: Stop[] = [];
  for (const c of clusterStops(stationsOsm, routesOsm, ctx.toXZ, ctx.inside)) {
    const name = c.names.length ? tidyStopName(mostCommon(c.names)) : crossName(ctx.roads, c.at);
    for (const built of placeStation(c.at, ctx)) {
      // Stop ids stay distinct across platforms with the same name.
      const k = stations.length;
      stations.push({ name, system: c.system, ...built.platform });
      built.sides.forEach((s, i) =>
        stops.push({ id: `${c.system}-${k}-${i}`, name, pos: s.pos, heading: round(s.heading), side: s.left ? 'left' : undefined, system: c.system }),
      );
    }
  }

  return { stations, stops, metro: importMetro(stationsOsm, ctx) };
}

type Platform = Pick<Station, 'pos' | 'heading' | 'length' | 'width'>;
type RoadPoint = NonNullable<ReturnType<typeof nearestOnRoads>>;
type Built = { platform: Platform; sides: { pos: Vec2; heading: number; left: boolean }[] };

/** Room a median island needs between the asphalt edges. */
const ISLAND_ROOM = 3.2 + 2 * ASPHALT_GAP;
/** Two carriageways of a divided avenue have centerlines at most this far apart. */
const DIVIDED = 30;

/**
 * The divided avenue at `at`: the carriageway nearest it and the nearest parallel one across
 * the median from it, with the median's direction `n` (from `a` toward `b`) and its width.
 */
function dividedPair(at: Vec2, allRoads: Road[]): { a: RoadPoint; b: RoadPoint; n: Vec2; gap: number } | null {
  const roads = generalRoads(allRoads);
  const a = nearestOnRoads(roads, at);
  if (!a) return null;
  let best: { b: RoadPoint; across: number } | null = null;
  for (const r of roads) {
    if (r === a.road) continue;
    const o = nearestOnRoads([r], a.point);
    const dot = o ? o.dir.x * a.dir.x + o.dir.z * a.dir.z : 0;
    // The other half of a divided avenue runs the other way.
    if (!o || Math.abs(dot) < 0.8 || (a.road.oneway && o.road.oneway && dot > 0)) continue;
    // Distance across the avenue (not along it: that's the same carriageway, continued).
    const across = Math.abs((o.point.x - a.point.x) * a.dir.z - (o.point.z - a.point.z) * a.dir.x);
    if (across < 3 || o.dist > DIVIDED || o.road.name !== a.road.name) continue;
    // Off the asphalt, `at` is in the median: the partner is on its side of `a`.
    const side = (o.point.x - a.point.x) * (at.x - a.point.x) + (o.point.z - a.point.z) * (at.z - a.point.z);
    if (a.dist > a.road.width / 2 && side < 0) continue;
    if (!best || across < best.across) best = { b: o, across };
  }
  if (!best) return null;
  // Straight across the avenue, toward `b`.
  const perp = { x: -a.dir.z, z: a.dir.x };
  const sign = Math.sign((best.b.point.x - a.point.x) * perp.x + (best.b.point.z - a.point.z) * perp.z) || 1;
  const n = { x: perp.x * sign, z: perp.z * sign };
  return { a, b: best.b, n, gap: best.across - a.road.width / 2 - best.b.road.width / 2 };
}

/**
 * Makes room for median stations where a divided avenue's carriageways are drawn too close
 * together: each carriageway drops its inner lane along the station stretch (between the
 * nearest junctions), keeping its outer curb where it was, like real station bays. With only
 * two lanes it keeps them and bulges outward instead. Returns the new road list.
 */
export function widenMedians(roads: Road[], stationsOsm: OsmJson, routesOsm: OsmJson, toXZ: Context['toXZ'], inside: (p: Vec2) => boolean): Road[] {
  let out = roads;
  for (const c of clusterStops(stationsOsm, routesOsm, toXZ, inside)) {
    // A busway beside the station takes its platform: the avenue stays as drawn.
    const roomed = makeRoomAtBusway(out, c.at);
    if (roomed) {
      out = roomed;
      continue;
    }
    const pair = dividedPair(c.at, out);
    if (!pair || pair.gap >= ISLAND_ROOM) continue;
    const need = ISLAND_ROOM - pair.gap;
    const mid = { x: (pair.a.point.x + pair.b.point.x) / 2, z: (pair.a.point.z + pair.b.point.z) / 2 };
    for (const [cw, away] of [
      [pair.a, { x: -pair.n.x, z: -pair.n.z }],
      [pair.b, pair.n],
    ] as const) {
      const laneW = cw.road.width / cw.road.lanes;
      const drop = cw.road.lanes >= 3;
      // Outward shift of the centerline: half a lane when dropping one, else half the room needed.
      const shift = drop ? laneW / 2 : Math.min(2.5, need / 2);
      out = reshapeCarriageway(out, cw, mid, away, shift, drop);
    }
  }
  return out;
}

/** A busway may lie this far (m) over its carriageway's asphalt: the avenues are drawn with generic lane widths, a bit fat. */
const OVERLAP_OK = 0.9;
/** Bridges and underpasses (with their ramps) keep clear of this shifting by this far (m). */
const STRUCTURE_REACH = 110;
/** No carriageway moves further than this to clear a busway. */
const CLEAR_SHIFT_MAX = 2.5;

/**
 * After `clearBusways` pushed the busways as far as they go: where a median is still narrower than
 * the carriageways' drawn widths plus the busways, the carriageway moves outward instead (between
 * its nearest junctions, tapering back, the way `reshapeCarriageway` does for a station), most
 * overlapped spot first. Cross streets keep their joins: the shift is zero at every junction.
 */
export function clearCarriageways(roads: Road[]): Road[] {
  // Not near a bridge or underpass: its ramps (not solved yet) and the busway pieces dropped there stay as they are.
  const structures = roads.filter((r) => r.layer);
  const nearStructure = (p: Vec2) => structures.some((r) => distToPolyline(p, r.points) < STRUCTURE_REACH);
  const spots: { p: Vec2; gap: number }[] = [];
  for (const bw of roads) {
    if (bw.access !== 'brt' || bw.points.length < 2) continue;
    const path = makePath(bw.points);
    for (let d = 0; d <= path.len; d += 4) {
      const p = pointAt(path, d);
      const cw = nearestOnRoads(generalRoads(roads), p);
      if (!cw || cw.dist < 0.3) continue;
      const gap = cw.road.width / 2 + bw.width / 2 - cw.dist - OVERLAP_OK;
      if (gap > 0.05 && !nearStructure(p)) spots.push({ p, gap });
    }
  }
  let out = roads;
  for (const { p } of spots.sort((a, b) => b.gap - a.gap)) {
    const cw = nearestOnRoads(generalRoads(out), p);
    const bw = nearestBusway(out, p, 1);
    if (!cw || !bw || cw.dist < 0.3) continue;
    const gap = cw.road.width / 2 + bw.road.width / 2 - cw.dist - OVERLAP_OK;
    if (gap <= 0.05) continue;
    out = reshapeCarriageway(out, cw, p, { x: (cw.point.x - p.x) / cw.dist, z: (cw.point.z - p.z) / cw.dist }, Math.min(CLEAR_SHIFT_MAX, gap + 0.05), false);
  }
  return out;
}

/** Half the length of a platform the pair of busways must have room for. */
const PLATFORM_HALF = 14;

/** Clear ground between a busway's edge and the next asphalt (or busway) for a platform with a curb strip either side. */
const PLATFORM_ROOM = CURB_WIDTH + 2 * ASPHALT_GAP;

/**
 * A station beside a busway (null when there's none within `BUSWAY_NEAR`): makes room for its
 * platform. The opposite busway of the pair is pulled apart from this one until a platform fits
 * between them (both tapering back to where OSM put them, the way ends staying exact), or, with
 * no pair, the carriageway beside the platform's side gives up a lane (`reshapeCarriageway`).
 * Then each busway's outer side gets the same treatment against the carriageway there, so the
 * median reads as busway | platform | busway between the avenue's lanes. Returns the new roads.
 */
function makeRoomAtBusway(roads: Road[], at: Vec2): Road[] | null {
  const a = nearestBusway(roads, at, BUSWAY_NEAR);
  if (!a) return null;
  let out = roads;
  const hwA = a.road.width / 2;
  const left = { x: a.dir.z, z: -a.dir.x };
  const rightV = { x: -left.x, z: -left.z };
  // A one-way busway is boarded from the left (between it and its opposite); a two-way one gets a platform on each side.
  const side = a.road.oneway ? left : (at.x - a.point.x) * left.x + (at.z - a.point.z) * left.z > 0 ? left : rightV;
  // The opposite busway on the platform's side (a one-way pair: the platform goes between them).
  let b: RoadPoint | null = null;
  let bAcross = Infinity;
  if (a.road.oneway)
    for (const r of roads) {
      if (r.access !== 'brt' || r === a.road) continue;
      // Across the pair along the platform's length (a lens: the narrowest spot counts).
      let narrow = Infinity;
      let here: RoadPoint | null = null;
      for (let t = -PLATFORM_HALF; t <= PLATFORM_HALF; t += 2) {
        const pa = nearestBusway([a.road], offset(a.point, a.dir, t), 4);
        if (!pa) continue;
        const o = nearestBusway([r], offset(pa.point, side, hwA + 2), 12);
        if (!o) continue;
        const dot = o.dir.x * pa.dir.x + o.dir.z * pa.dir.z;
        const across = (o.point.x - pa.point.x) * side.x + (o.point.z - pa.point.z) * side.z;
        if (Math.abs(dot) < 0.8 || across < 1.5 || (o.road.oneway && dot > 0)) continue;
        narrow = Math.min(narrow, across);
        if (t === 0 || !here) here = o;
      }
      if (here && narrow < bAcross) (b = here), (bAcross = narrow);
    }
  // A lone one-way busway has no opposite direction to serve: the station keeps to the avenue's median.
  if (a.road.oneway && !b) return null;
  const neg = { x: -side.x, z: -side.z };
  const swap = (from: Road, to: Road) => (out = out.map((r) => (r === from ? to : r)));
  let aRoad = a.road;
  let bRoad = b?.road;
  if (b) {
    const need = hwA + b.road.width / 2 + PLATFORM_ROOM;
    if (bAcross < need) {
      const d = (need - bAcross) / 2;
      aRoad = shiftBusway(a.road, roads, at, a.dir, { x: neg.x * d, z: neg.z * d });
      bRoad = shiftBusway(b.road, roads, at, a.dir, { x: side.x * d, z: side.z * d });
      swap(a.road, aRoad);
      swap(b.road, bRoad);
    }
  }
  // Each busway's outer side keeps a curb from the carriageway there; a platform side with no pair needs the room.
  const ends: { bw: Road; point: Vec2; away: Vec2; room: number }[] = [];
  if (b) ends.push({ bw: aRoad, point: a.point, away: neg, room: BUSWAY_GAP }, { bw: bRoad!, point: b.point, away: side, room: BUSWAY_GAP });
  else for (const v of [left, rightV]) ends.push({ bw: aRoad, point: a.point, away: v, room: PLATFORM_ROOM });
  for (const { bw, point, away, room } of ends) {
    const edge = offset(point, away, bw.width / 2 + 0.2);
    const cw = nearestOnRoads(generalRoads(out), edge);
    if (!cw) continue;
    const clearance = cw.dist - cw.road.width / 2 + 0.2;
    if (clearance >= room || cw.dist > 30) continue;
    const deficit = room - clearance;
    const laneW = cw.road.width / cw.road.lanes;
    const drop = cw.road.lanes >= 3;
    out = reshapeCarriageway(out, cw, point, away, drop ? laneW / 2 : Math.min(deficit, 4), drop);
  }
  return out;
}

/** Along-avenue span the reshaping may cover on each side of the station. */
const STRETCH = 60;
/** Length of the taper between the full shift and none. */
const TAPER = 12;

/**
 * Narrows (or shifts) one carriageway around `mid`: every road piece running along it within
 * the station stretch is clipped to that stretch, loses a lane (`drop`) and has its centerline
 * pushed `shift` meters toward `away`, tapering to nothing at the stretch ends. The stretch
 * stops at the nearest junction on each side, so connections to cross streets stay put.
 */
function reshapeCarriageway(roads: Road[], cw: RoadPoint, mid: Vec2, away: Vec2, shift: number, drop: boolean): Road[] {
  const axis = cw.dir;
  const along = (p: Vec2) => (p.x - mid.x) * axis.x + (p.z - mid.z) * axis.z;
  const across = (p: Vec2) => (p.x - cw.point.x) * away.x + (p.z - cw.point.z) * away.z;
  const onCarriageway = (r: Road) =>
    r.oneway === cw.road.oneway &&
    r.name === cw.road.name &&
    r.points.some((p, i) => {
      const q = r.points[i + 1];
      if (!q) return false;
      const d = unit({ x: q.x - p.x, z: q.z - p.z });
      return Math.abs(d.x * axis.x + d.z * axis.z) > 0.9 && Math.abs(across(p)) < 2 && Math.abs(along(p)) < STRETCH + 40;
    });
  const pieces = roads.filter(onCarriageway);
  // Junctions: where any other road's end touches the carriageway.
  let lo = -STRETCH;
  let hi = STRETCH;
  for (const r of roads) {
    if (pieces.includes(r)) continue;
    for (const p of [r.points[0], r.points[r.points.length - 1]]) {
      if (Math.abs(across(p)) > cw.road.width / 2 + 3) continue;
      const t = along(p);
      if (t > 0 && t < hi) hi = t;
      if (t < 0 && t > lo) lo = t;
    }
  }
  if (hi - lo < 2 * TAPER + 12) return roads;
  // Exactly zero near the ends, so joins with the untouched roads there stay exact.
  const ramp = (t: number) => {
    const k = Math.max(0, Math.min(1, (t - lo) / TAPER, (hi - t) / TAPER));
    return k < 0.05 ? 0 : k;
  };

  const out: Road[] = [];
  for (const r of roads) {
    if (!pieces.includes(r)) {
      out.push(r);
      continue;
    }
    // Split the piece at the stretch ends; resample the inside so the taper is smooth.
    const inside: Vec2[] = [];
    const before: Vec2[] = [];
    const after: Vec2[] = [];
    for (let i = 0; i < r.points.length - 1; i++) {
      const p = r.points[i];
      const q = r.points[i + 1];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const steps = Math.max(1, Math.ceil(len / 3));
      for (let k = 0; k < steps; k++) {
        const u = k / steps;
        const pt = { x: p.x + (q.x - p.x) * u, z: p.z + (q.z - p.z) * u };
        const t = along(pt);
        (t < lo ? (inside.length ? after : before) : t > hi ? (inside.length ? after : before) : inside).push(pt);
      }
    }
    const last = r.points[r.points.length - 1];
    const tl = along(last);
    (tl < lo || tl > hi ? after : inside).push(last);
    // Pieces meet the stretch ends at exact points so the parts stay joined.
    const cut = (a: Vec2, b: Vec2): Vec2 => {
      const ta = along(a);
      const tb = along(b);
      const edge = (ta < lo) !== (tb < lo) ? lo : hi;
      const u = (edge - ta) / (tb - ta);
      return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u };
    };
    if (before.length && inside.length) {
      const c = cut(before[before.length - 1], inside[0]);
      before.push(c);
      inside.unshift(c);
    }
    if (after.length && inside.length) {
      const c = cut(inside[inside.length - 1], after[0]);
      inside.push(c);
      after.unshift(c);
    }
    // A sliver left over at a junction (float noise at the stretch end) folds back in.
    const tiny = (pts: Vec2[]) => pts.length < 2 || pathLength(pts) < 0.5;
    if (tiny(before) && before.length) (inside[0] = r.points[0]), (before.length = 0);
    if (tiny(after) && after.length) (inside[inside.length - 1] = last), (after.length = 0);
    if (tiny(inside)) {
      out.push(r);
      continue;
    }
    if (before.length) out.push({ ...r, points: simplifyStraight(before) });
    if (after.length) out.push({ ...r, points: simplifyStraight(after) });
    if (inside.length > 1) {
      const lanes = drop ? r.lanes - 1 : r.lanes;
      out.push({
        ...r,
        lanes,
        width: drop ? round((r.width / r.lanes) * lanes) : r.width,
        points: inside.map((p) => round2(offset(p, away, shift * ramp(along(p))))),
      });
    }
  }
  return out;
}

function pathLength(pts: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return l;
}

/** Drops the resampling points on straight runs (keeps the ends and real bends). */
function simplifyStraight(pts: Vec2[]): Vec2[] {
  return pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const a = pts[i - 1];
    const b = pts[i + 1];
    return Math.abs((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / (Math.hypot(b.x - a.x, b.z - a.z) || 1) > 0.05;
  });
}

/**
 * Fits platforms around `at`: an island in a divided avenue's median (a platform per
 * carriageway where the median is too wide for one), or one along the curb.
 */
function placeStation(at: Vec2, ctx: Context): Built[] {
  const one = (b: Built | null) => (b ? [b] : []);
  // A segregated busway beside it: the platform sits on the busway's left (or between two busways).
  const onBusway = buswayStation(at, ctx);
  if (onBusway.length) return onBusway;
  const pair = dividedPair(at, ctx.roads);
  if (!pair || pair.gap < MIN_WIDTH + 2 * ASPHALT_GAP) {
    // Mixed traffic: a curb platform on the right of travel.
    const near = nearestOnRoads(generalRoads(ctx.roads), at);
    if (!near) return [];
    const n = right(Math.atan2(-near.dir.z, near.dir.x));
    return one(platform(offset(near.point, n, near.road.width / 2 + ASPHALT_GAP + CURB_WIDTH / 2), CURB_WIDTH, near.dir, n, [near], ctx));
  }
  const { a, b, n, gap } = pair;
  const axis = a.dir;
  const edgeA = offset(a.point, n, a.road.width / 2);
  // Against one carriageway's edge: `a`'s, or `b`'s.
  const hugging = (cw: RoadPoint, fromA: boolean) =>
    platform(offset(edgeA, n, fromA ? ASPHALT_GAP + CURB_WIDTH / 2 : gap - ASPHALT_GAP - CURB_WIDTH / 2), CURB_WIDTH, axis, n, [cw], ctx);
  if (gap - 2 * ASPHALT_GAP > MAX_WIDTH) return [hugging(a, true), hugging(b, false)].filter((x): x is Built => !!x);
  // Island in the middle of the median, boarded from both sides. Lane counts (so asphalt
  // edges) can change along the avenue: measure the median where the platform ends up.
  // Medians narrow along the avenue: the widest island that's long enough for a bus to pull
  // up to (else the longest one that fits).
  const island = (p: Vec2) => {
    const m = medianAt(p, n, ctx.roads);
    if (!m) return null;
    let best: Built | null = null;
    for (let w = m.width - 2 * ASPHALT_GAP; w >= MIN_WIDTH; w -= 0.5) {
      const built = platform(m.center, w, axis, n, [a, b], ctx);
      if (built && built.platform.length >= GOOD_LENGTH) return built;
      if (built && (!best || built.platform.length > best.platform.length)) best = built;
    }
    return best;
  };
  // Step off `a`'s asphalt into the median, wherever its edge really is.
  let start: Vec2 | null = null;
  for (let t = 0; t < DIVIDED && !start; t += 0.1) {
    const q = offset(a.point, n, t);
    if (ctx.roads.every((r) => distToPolyline(q, r.points) >= r.width / 2)) start = q;
  }
  const first = start && island(start);
  return one((first && island(first.platform.pos)) ?? first);
}

/** A busway this close to a station's stop positions is the one it serves. */
const BUSWAY_NEAR = 25;

/**
 * A platform for a station beside a busway: between two opposite busways when they have room for
 * one (boarded from the left from both), else along the left side of a one-way busway (the right
 * side of a two-way one: its lane is on the right). Null when nothing clear fits, and the
 * station falls back to the avenue's own lanes.
 */
function buswayStation(at: Vec2, ctx: Context): Built[] {
  const a0 = nearestBusway(ctx.roads, at, BUSWAY_NEAR);
  if (!a0) return [];
  const oneway = !!a0.road.oneway;
  const hwA = a0.road.width / 2;
  const leftOf = (a: RoadPoint) => ({ x: a.dir.z, z: -a.dir.x });
  // Between a one-way busway and the opposite one beside it: try spots along it, nearest the stop positions first
  // (OSM draws a station bay as a lens, so the gap changes along it), and keep the first with room for a bus.
  if (oneway) {
    let best: Built | null = null;
    for (const t of [0, 3, -3, 6, -6, 9, -9, 12, -12, 16, -16, 20, -20, 25, -25]) {
      const a = nearestBusway([a0.road], offset(a0.point, a0.dir, t), 4);
      if (!a) continue;
      const side = leftOf(a);
      for (const r of ctx.roads) {
        if (r.access !== 'brt' || r === a.road) continue;
        const b = nearestBusway([r], offset(a.point, side, hwA + 3), 14);
        if (!b) continue;
        const dot = b.dir.x * a.dir.x + b.dir.z * a.dir.z;
        const across = (b.point.x - a.point.x) * side.x + (b.point.z - a.point.z) * side.z;
        const gap = across - hwA - b.road.width / 2;
        if (Math.abs(dot) < 0.8 || across < 1.5 || (b.road.oneway && dot > 0) || gap < MIN_WIDTH + 2 * ASPHALT_GAP) continue;
        // The widest platform that's long enough for a bus (a lens narrows toward its ends), else the longest.
        for (let w = Math.min(MAX_WIDTH, gap - 2 * ASPHALT_GAP); w >= MIN_WIDTH; w -= 0.4) {
          const built = platform(offset(a.point, side, hwA + gap / 2), w, a.dir, side, [a, b], ctx);
          if (built && built.platform.length >= GOOD_LENGTH) return [built];
          if (built && (!best || built.platform.length > best.platform.length)) best = built;
        }
      }
    }
    return best ? [best] : [];
  }
  // Beside a two-way busway: a platform on each side.
  const a = a0;
  const sides = [leftOf(a), { x: -leftOf(a).x, z: -leftOf(a).z }];
  const built = sides.map((side) => platform(offset(a.point, side, hwA + BUSWAY_GAP + CURB_WIDTH / 2), CURB_WIDTH, a.dir, side, [a], ctx)).filter((x): x is Built => !!x);
  // Only one side had room (a carriageway too close, no stretch to widen): the other direction's bus
  // boards from the same platform across the near lane, from its left door (the zone is 7 m wide).
  if (built.length === 1 && built[0].sides.length === 1) {
    const s0 = built[0].sides[0];
    built[0].sides.push({ pos: s0.pos, heading: round(s0.heading + Math.PI > Math.PI ? s0.heading - Math.PI : s0.heading + Math.PI), left: true });
  }
  return built;
}

/** The side of busway point `a` that `at` is on (a one-way busway's platform is on its left instead). */
function sideToward(a: RoadPoint, at: Vec2): Vec2 {
  const left = { x: a.dir.z, z: -a.dir.x };
  return (at.x - a.point.x) * left.x + (at.z - a.point.z) * left.z > 0 ? left : { x: -left.x, z: -left.z };
}

/** The median across `p` (along `n`): its middle and width, from the asphalt on either side. */
function medianAt(p: Vec2, n: Vec2, roads: Road[]): { center: Vec2; width: number } | null {
  const paved = (q: Vec2) => roads.some((r) => distToPolyline(q, r.points) < r.width / 2);
  if (paved(p)) return null;
  const reach = (dir: 1 | -1) => {
    for (let t = 0.1; t < DIVIDED; t += 0.1) if (paved(offset(p, n, dir * t))) return t;
    return null;
  };
  const toB = reach(1);
  const toA = reach(-1);
  if (toA === null || toB === null) return null;
  return { center: offset(p, n, (toB - toA) / 2), width: toA + toB };
}

/**
 * Grows a platform along the avenue from `center` while it stays clear of asphalt, junctions
 * and buildings, and puts a stop on its edge for each carriageway beside it.
 */
function platform(center: Vec2, width: number, axis: Vec2, n: Vec2, carriageways: RoadPoint[], ctx: Context): Built | null {
  const clear = (t: number) =>
    [-1, 1].every((s) => {
      const p = offset(offset(center, axis, t), n, (s * width) / 2);
      return offRoads(ctx.roads, p, 0.2) && !ctx.onJunction(p) && !ctx.buildings.some((b) => pointInPolygon(p, b.footprint));
    });
  if (!clear(0)) {
    return null;
  }
  let lo = 0;
  let hi = 0;
  const maxLength = carriageways.some((c) => c.road.access) ? BUSWAY_MAX_LENGTH : MAX_LENGTH;
  while (lo > -maxLength / 2 && clear(lo - 1)) lo--;
  while (hi < maxLength / 2 && clear(hi + 1)) hi++;
  if (hi - lo < MIN_LENGTH) return null;
  const mid = offset(center, axis, (lo + hi) / 2);
  // A canonical direction, so two platforms of a station line up the same way.
  const along = axis.x * forward(0).x + axis.z * forward(0).z < 0 ? { x: -axis.x, z: -axis.z } : axis;

  const sides = carriageways.map((cw) => {
    // Platform edge facing this carriageway (a step in from the edge, where people wait).
    const toRoad = unit({ x: cw.point.x - mid.x, z: cw.point.z - mid.z });
    const across = toRoad.x * n.x + toRoad.z * n.z > 0 ? n : { x: -n.x, z: -n.z };
    const pos = offset(mid, across, width / 2 - 0.4);
    let dir = cw.dir;
    // Two-way road: take the direction that has the platform on its right (a curb stop).
    const leftOf = (d: Vec2) => d.x * (mid.z - cw.point.z) - d.z * (mid.x - cw.point.x) < 0;
    if (!cw.road.oneway && leftOf(dir)) dir = { x: -dir.x, z: -dir.z };
    return { pos: round2(pos), heading: Math.atan2(-dir.z, dir.x), left: leftOf(dir) };
  });
  return { platform: { pos: round2(mid), heading: round(Math.atan2(-along.z, along.x)), length: hi - lo, width: round(width) }, sides };
}

/** Metro de Quito entrances (or the station itself when none are mapped), moved to clear ground. */
function importMetro(osm: OsmJson, ctx: Context): MetroEntrance[] {
  const stations = osm.elements.filter((e) => e.tags?.station === 'subway' || (e.tags?.public_transport === 'station' && /metro/i.test(e.tags?.network ?? '')));
  const entrances = osm.elements.filter((e) => e.tags?.railway === 'subway_entrance');
  const pos = (e: (typeof osm.elements)[number]) => ctx.toXZ(e.lat ?? (e as any).center.lat, e.lon ?? (e as any).center.lon);
  const out: MetroEntrance[] = [];
  const seen = new Set<string>();
  for (const s of stations) {
    const name = s.tags!.name ?? 'Metro';
    const at = pos(s);
    if (seen.has(name) || !ctx.inside(at)) continue;
    seen.add(name);
    const own = entrances.filter((e) => e.tags?.name === name || Math.hypot(pos(e).x - at.x, pos(e).z - at.z) < 250);
    for (const spot of own.length ? own.map(pos) : [at]) {
      const e = placeEntrance(spot, ctx);
      if (e && !out.some((o) => Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) < 20)) out.push({ name, ...e });
    }
  }
  return out;
}

/** The nearest clear spot to `p` for an entrance canopy, facing the closest street. */
function placeEntrance(p: Vec2, ctx: Context): { pos: Vec2; heading: number } | null {
  for (let r = 0; r <= 40; r += 1.5) {
    const steps = r ? Math.ceil((2 * Math.PI * r) / 1.5) : 1;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      const c = { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
      const road = nearestOnRoads(generalRoads(ctx.roads), c);
      if (!road || !ctx.inside(c)) continue;
      const toRoad = unit({ x: road.point.x - c.x, z: road.point.z - c.z });
      const heading = Math.atan2(-toRoad.z, toRoad.x);
      const f = forward(heading);
      const s = right(heading);
      const ok = [-1, 0, 1].every((u) =>
        [-1, 1].every((v) => {
          const q = offset(offset(c, f, (u * ENTRANCE.length) / 2), s, (v * ENTRANCE.width) / 2);
          return offRoads(ctx.roads, q, 2.5) && !ctx.onJunction(q) && !ctx.buildings.some((b) => pointInPolygon(q, b.footprint));
        }),
      );
      if (ok) return { pos: round2(c), heading: round(heading) };
    }
  }
  return null;
}

/** "Av. América y Pérez Guerrero" for a station without a name. */
function crossName(allRoads: Road[], p: Vec2): string {
  const roads = generalRoads(allRoads);
  const main = nearestOnRoads(roads, p);
  const cross = main && nearestOnRoads(roads.filter((r) => r.name !== main.road.name && !/sin nombre/i.test(r.name)), p);
  const short = (s: string) => s.replace(/^Av\. /, '');
  return main && cross && cross.dist < 150 ? `${short(main.road.name)} y ${short(cross.road.name)}` : `Estación ${main ? short(main.road.name) : ''}`.trim();
}

function offRoads(roads: Road[], p: Vec2, margin: number): boolean {
  return roads.every((r) => distToPolyline(p, r.points) > r.width / 2 + margin);
}

const offset = (p: Vec2, d: Vec2, k: number): Vec2 => ({ x: p.x + d.x * k, z: p.z + d.z * k });
const unit = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.z) || 1;
  return { x: v.x / l, z: v.z / l };
};
const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const round = (v: number) => Math.round(v * 1e4) / 1e4;
const round2 = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });

function mostCommon(v: string[]): string {
  const n = new Map<string, number>();
  for (const s of v) n.set(s, (n.get(s) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0][0];
}
