import type { CityData, Stop, TransitSystem, Vec2 } from '../world/cityData';
import { forward, stopZone } from '../world/cityData';
import { distToPolyline } from '../world/geom';
import type { RouteStop } from './routeGame';
import { type RoadGraph, buildRoadGraph } from '../world/roadGraph';
import { type GraphSpot, Navigator } from './navigation';
import { snapToRoad } from '../world/roadSnap';

/** A route the player can pick: an ordered loop of stop ids. */
export interface RouteDef {
  id: string;
  name: string;
  /** Short description for the menu. */
  blurb: string;
  stops: string[];
  /** Avenue the route runs along, for corridor routes. */
  corridor?: string;
  /** OSM ref of the real bus line this follows, for real-line routes. */
  line?: string;
  /** Trolebús/Ecovía/Metrobus route: stops at its stations, boarding on the left. */
  system?: TransitSystem;
  lengthM: number;
}

const CIRCUIT_STOPS = 8;
const MIN_SPACING = 90;
const CORRIDOR_REACH = 25;
const MIN_CORRIDOR_STOPS = 5;
const MAX_CORRIDOR_STOPS = 10;
const MAX_ROUTES = 5;
/** Real lines shown in the menu (after the neighborhood circuit). */
const MAX_LINES = 6;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Routes for a city: a neighborhood circuit near the start, then one out-and-back route per
 * avenue that has enough stops along it (up one side, back down the other).
 */
export function routesFor(city: CityData, graph: RoadGraph = buildRoadGraph(city)): RouteDef[] {
  const legal = new LegalLegs(city, graph);
  const routes: RouteDef[] = [circuit(city, legal)];
  // Real bus lines, where the zone has them (their stretch through it, both directions), then
  // the rapid-transit lines at their stations.
  const all = (city.lines ?? []).map((l) => realLine(city, l, legal)).filter((r): r is RouteDef => !!r);
  const lines = [...all.filter((r) => !r.system).slice(0, MAX_LINES), ...all.filter((r) => r.system)];
  if (lines.length) return routes.concat(lines);
  const avenues = [...new Set(city.roads.filter((r) => r.kind === 'avenue').map((r) => r.name))];
  const corridors = avenues
    .map((name) => corridor(city, name, legal))
    .filter((r): r is RouteDef => !!r)
    .sort((a, b) => b.stops.length - a.stops.length);
  return routes.concat(corridors.slice(0, MAX_ROUTES - 1));
}

function realLine(city: CityData, l: import('../world/osm/lines').BusLine, legal: LegalLegs): RouteDef | null {
  const byId = new Map(city.stops.map((s) => [s.id, s]));
  const stops = legal.prune(l.stops.map((id) => byId.get(id)!).filter(Boolean));
  if (stops.length < MIN_CORRIDOR_STOPS) return null;
  const system = l.system;
  const also = l.alsoServedBy.length ? ` · también ${l.alsoServedBy.slice(0, 2).join(', ')}${l.alsoServedBy.length > 2 ? '…' : ''}` : '';
  return {
    id: `linea-${l.ref.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: l.name,
    blurb: system ? `${SYSTEM_BLURB[system]} (${l.endpoints})${also}` : `Su tramo por la zona (${l.endpoints})${also}`,
    stops: stops.map((s) => s.id),
    line: l.ref,
    system,
    lengthM: legalLength(stops, legal),
  };
}

const SYSTEM_BLURB: Record<TransitSystem, string> = {
  trolebus: 'Paradas en las estaciones del Trolebús',
  ecovia: 'Paradas en las estaciones de la Ecovía',
  metrobus: 'Paradas en las estaciones del Metrobus',
};

/** A leg is acceptable when it can be driven legally without a silly detour. */
const MAX_DETOUR = (straight: number) => straight * 2.5 + 400;

/** Legal driving distances between stops (following one-way streets), cached. */
class LegalLegs {
  private nav: Navigator;
  private spots = new Map<string, GraphSpot | null>();
  private cache = new Map<string, number>();

  constructor(
    private city: CityData,
    graph: RoadGraph,
  ) {
    this.nav = new Navigator(graph);
  }

  /** Stops the bus can actually reach, on a lane going its way. */
  usable(s: Stop): boolean {
    return !!this.spot(s);
  }

  length(a: Stop, b: Stop): number {
    const key = `${a.id}>${b.id}`;
    let d = this.cache.get(key);
    if (d === undefined) {
      const sa = this.spot(a);
      const sb = this.spot(b);
      d = sa && sb ? this.nav.distanceTo(sa, sb) : Infinity;
      this.cache.set(key, d);
    }
    return d;
  }

  ok(a: Stop, b: Stop): boolean {
    return this.length(a, b) <= MAX_DETOUR(dist(zone(a), zone(b)));
  }

  /** Drops stops until every leg of the loop (including last → first) is acceptable. */
  prune(stops: Stop[]): Stop[] {
    const list = stops.filter((s) => this.usable(s));
    const badLegs = (l: Stop[]) => l.filter((st, i) => !this.ok(st, l[(i + 1) % l.length])).length;
    for (let guard = 0; guard < 40 && list.length >= 3; guard++) {
      const bad = list.findIndex((st, i) => !this.ok(st, list[(i + 1) % list.length]));
      if (bad < 0) break;
      // Drop whichever end of the bad leg leaves fewer bad legs: a dead-end stop poisons both
      // the leg into it and the leg out of it, so removing the other end would just move on.
      const next = (bad + 1) % list.length;
      const without = (i: number) => list.filter((_, j) => j !== i);
      list.splice(badLegs(without(bad)) <= badLegs(without(next)) ? bad : next, 1);
    }
    return list;
  }

  private spot(s: Stop): GraphSpot | null {
    if (!this.spots.has(s.id)) this.spots.set(s.id, this.nav.locate(zone(s), s.heading));
    return this.spots.get(s.id)!;
  }
}

const zone = stopZone;

/** Stops of a route with the spot on the road where the bus has to stop. */
export function routeStops(city: CityData, route: RouteDef): RouteStop[] {
  const byId = new Map(city.stops.map((s) => [s.id, s]));
  return route.stops.map((id) => {
    const stop = byId.get(id)!;
    return { stop, zone: zone(stop) };
  });
}

/** The bus starts this far before the first stop, driving along traffic toward it. */
const LEAD_IN = 70;

/**
 * Where the bus starts a route: on the lane that leads into the first stop, `LEAD_IN` meters
 * back along legal traffic flow, facing it (clear of ramps and humps).
 */
export function startPose(city: CityData, graph: RoadGraph, route: RouteDef): { pos: Vec2; heading: number; y: number } {
  const nav = new Navigator(graph);
  const first = routeStops(city, route)[0];
  const spot = nav.locate(first.zone, first.stop.heading);
  if (!spot) {
    const f = forward(first.stop.heading);
    return snapToRoad(city, { x: first.zone.x - f.x * LEAD_IN, z: first.zone.z - f.z * LEAD_IN }, first.stop.heading);
  }
  const { pos, heading, y } = nav.pose(nav.behind(spot, LEAD_IN));
  return snapToRoad(city, pos, heading, y ?? undefined);
}

/** Where a free drive starts: in the curb lane of a street near the middle of the zone. */
export function freeStartPose(city: CityData, graph: RoadGraph): { pos: Vec2; heading: number; y: number } {
  const nav = new Navigator(graph);
  const mid = { x: (city.bounds.min.x + city.bounds.max.x) / 2, z: (city.bounds.min.z + city.bounds.max.z) / 2 };
  // The nearest long enough drivable street on the ground (not on a ramp) to the middle.
  let best: { edge: number; d: number } | null = null;
  for (const e of graph.edges) {
    if (!e.drivable || e.len < 40 || e.lift) continue;
    const d = Math.hypot(e.center.pts[0].x - mid.x, e.center.pts[0].z - mid.z);
    if (!best || d < best.d) best = { edge: e.id, d };
  }
  if (!best) return snapToRoad(city, city.spawn.pos, city.spawn.heading);
  const { pos, heading } = nav.pose({ edge: best.edge, s: graph.edges[best.edge].len / 2 });
  return snapToRoad(city, pos, heading);
}

/** The streets a route drives along, one polyline per leg, following traffic rules. */
export function routePaths(city: CityData, route: RouteDef, graph: RoadGraph = buildRoadGraph(city)): Vec2[][] {
  const nav = new Navigator(graph);
  const stops = routeStops(city, route);
  const spots = stops.map((s) => nav.locate(s.zone, s.stop.heading));
  return stops.map((s, i) => {
    const next = stops[(i + 1) % stops.length];
    const a = spots[i];
    const b = spots[(i + 1) % stops.length];
    const path = a && b ? nav.route(a, b) : null;
    return path ? [s.zone, ...path.points, next.zone] : [s.zone, next.zone];
  });
}

/** Legal driving distance into each stop from the one before it (`legs[0]`: from the last stop). */
export function routeLegs(city: CityData, route: RouteDef, graph: RoadGraph): number[] {
  const nav = new Navigator(graph);
  const stops = routeStops(city, route);
  const spots = stops.map((s) => nav.locate(s.zone, s.stop.heading));
  return stops.map((s, i) => {
    const j = (i + stops.length - 1) % stops.length;
    const a = spots[j];
    const b = spots[i];
    const d = a && b ? nav.distanceTo(a, b) : Infinity;
    // Unreachable (shouldn't happen on a pruned route): the straight line, with a grid detour.
    return isFinite(d) ? d : Math.hypot(s.zone.x - stops[j].zone.x, s.zone.z - stops[j].zone.z) * 1.3;
  });
}

/**
 * Greedy tour from the stop nearest the spawn: each next stop is the closest one by *legal*
 * driving distance (one-way streets respected) that's far enough away, and the loop has to
 * be able to close back to the first stop without a big detour.
 */
function circuit(city: CityData, legal: LegalLegs): RouteDef {
  const left = city.stops.filter((s) => !s.system && legal.usable(s));
  const first = left.reduce((a, b) => (dist(b.pos, city.spawn.pos) < dist(a.pos, city.spawn.pos) ? b : a));
  left.splice(left.indexOf(first), 1);
  const stops: Stop[] = [first];
  while (stops.length < CIRCUIT_STOPS && left.length) {
    const from = stops[stops.length - 1];
    const lastPick = stops.length === CIRCUIT_STOPS - 1;
    const cands = left
      .filter((s) => dist(s.pos, from.pos) >= MIN_SPACING && legal.ok(from, s) && (!lastPick || legal.ok(s, first)))
      .sort((a, b) => legal.length(from, a) - legal.length(from, b));
    if (!cands.length) break;
    stops.push(cands[0]);
    left.splice(left.indexOf(cands[0]), 1);
  }
  const loop = legal.prune(stops);
  return { id: 'circuito', name: 'Circuito del barrio', blurb: 'Una vuelta por las paradas más cercanas', stops: loop.map((s) => s.id), lengthM: legalLength(loop, legal) };
}

function corridor(city: CityData, name: string, legal: LegalLegs): RouteDef | null {
  const lines = city.roads.filter((r) => r.name === name).map((r) => r.points);
  const on = city.stops.filter((s) => !s.system && Math.min(...lines.map((l) => distToPolyline(s.pos, l))) < CORRIDOR_REACH);
  if (on.length < MIN_CORRIDOR_STOPS) return null;

  // Main axis of the stops (principal direction), then split by travel direction along it.
  const cx = on.reduce((s, p) => s + p.pos.x, 0) / on.length;
  const cz = on.reduce((s, p) => s + p.pos.z, 0) / on.length;
  let xx = 0;
  let xz = 0;
  let zz = 0;
  for (const s of on) {
    const dx = s.pos.x - cx;
    const dz = s.pos.z - cz;
    xx += dx * dx;
    xz += dx * dz;
    zz += dz * dz;
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const axis = { x: Math.cos(angle), z: Math.sin(angle) };
  const along = (s: Stop) => (s.pos.x - cx) * axis.x + (s.pos.z - cz) * axis.z;
  const outward = (s: Stop) => {
    const f = forward(s.heading);
    return f.x * axis.x + f.z * axis.z > 0;
  };
  const spaced = (list: Stop[]) => {
    const out: Stop[] = [];
    for (const s of list) if (!out.length || dist(out[out.length - 1].pos, s.pos) >= MIN_SPACING * 0.6) out.push(s);
    return out;
  };
  const out = spaced(on.filter(outward).sort((a, b) => along(a) - along(b)));
  const back = spaced(on.filter((s) => !outward(s)).sort((a, b) => along(b) - along(a)));
  // Keep the loop within a playable size, trimming the far end evenly.
  let stops = [...out, ...back];
  if (stops.length > MAX_CORRIDOR_STOPS) {
    const half = Math.floor(MAX_CORRIDOR_STOPS / 2);
    stops = [...out.slice(0, half), ...back.slice(Math.max(0, back.length - half))];
  }
  stops = legal.prune(stops);
  if (stops.length < MIN_CORRIDOR_STOPS) return null;
  const short = name.replace(/^Av\. /, '');
  return {
    id: `ruta-${short.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: `Ruta ${short}`,
    blurb: `Ida y vuelta por la ${name.startsWith('Av.') ? 'avenida ' + short : short}`,
    stops: stops.map((s) => s.id),
    corridor: name,
    lengthM: legalLength(stops, legal),
  };
}

/** Driving length of the whole loop, following traffic rules. */
function legalLength(stops: Stop[], legal: LegalLegs): number {
  let l = 0;
  for (let i = 0; i < stops.length; i++) l += legal.length(stops[i], stops[(i + 1) % stops.length]);
  return Math.round(l);
}
