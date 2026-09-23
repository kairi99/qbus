import type { CityData, Stop, Vec2 } from '../world/cityData';
import { forward, right } from '../world/cityData';
import { distToPolyline } from '../world/geom';
import type { RouteStop } from './routeGame';
import { type RoadGraph, buildRoadGraph } from '../world/roadGraph';
import { type GraphSpot, Navigator } from './navigation';

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
  // Real bus lines, where the zone has them (their stretch through it, both directions).
  const lines = (city.lines ?? [])
    .map((l) => realLine(city, l, legal))
    .filter((r): r is RouteDef => !!r)
    .slice(0, MAX_LINES);
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
  const also = l.alsoServedBy.length ? ` · también ${l.alsoServedBy.slice(0, 2).join(', ')}${l.alsoServedBy.length > 2 ? '…' : ''}` : '';
  return {
    id: `linea-${l.ref.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: l.name,
    blurb: `Su tramo por la zona (${l.endpoints})${also}`,
    stops: stops.map((s) => s.id),
    line: l.ref,
    lengthM: legalLength(stops, legal),
  };
}

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

/** Where the bus stops for `s`: on the road beside the shelter. */
function zone(s: Stop): Vec2 {
  const r = right(s.heading);
  return { x: s.pos.x - r.x * 4.2, z: s.pos.z - r.z * 4.2 };
}

/** Stops of a route with the spot on the road where the bus has to stop. */
export function routeStops(city: CityData, route: RouteDef): RouteStop[] {
  const byId = new Map(city.stops.map((s) => [s.id, s]));
  return route.stops.map((id) => {
    const stop = byId.get(id)!;
    return { stop, zone: zone(stop) };
  });
}

/**
 * Greedy tour from the stop nearest the spawn: each next stop is the closest one by *legal*
 * driving distance (one-way streets respected) that's far enough away, and the loop has to
 * be able to close back to the first stop without a big detour.
 */
function circuit(city: CityData, legal: LegalLegs): RouteDef {
  const left = city.stops.filter((s) => legal.usable(s));
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
  const on = city.stops.filter((s) => Math.min(...lines.map((l) => distToPolyline(s.pos, l))) < CORRIDOR_REACH);
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
