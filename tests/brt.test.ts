import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CityData } from '../src/world/cityData';
import { groundHeightAt } from '../src/world/cityData';
import { buildRoadGraph, edgeDir, laneOffset, lanePoint } from '../src/world/roadGraph';
import { BRT_GENERAL_COST, Navigator } from '../src/gameplay/navigation';
import { routeLegs, routePaths, routeStops, routesFor, startPose } from '../src/gameplay/routes';
import { BRT_KIND, TrafficSim, brtBusCount } from '../src/gameplay/traffic';
import { TrafficLights } from '../src/gameplay/trafficLights';
import { busForRoute } from '../src/menu/menu';
import { BRT_BUS, BUSES } from '../src/vehicle/buses';

const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const graph = buildRoadGraph(mariscal);
const routes = routesFor(mariscal, graph);
const brtRoutes = routes.filter((r) => r.system);
const ground = (q: { x: number; z: number }) => groundHeightAt(mariscal, q);

/** Edges a route's legs drive, with the navigator the game uses for it. */
function edgesOf(route: (typeof routes)[number]): number[] {
  const nav = new Navigator(graph, route.system ? 'brt' : 'general', BRT_GENERAL_COST);
  const stops = routeStops(mariscal, route);
  const spots = stops.map((s) => nav.locate(s.zone, s.stop.heading, ground(s.zone), ground)!);
  return stops.flatMap((_, i) => nav.route(spots[i], spots[(i + 1) % stops.length])!.edges);
}

describe('BRT routes (La Mariscal)', () => {
  it('offers the Trolebús and Ecovía lines', () => {
    expect(brtRoutes.map((r) => r.id).sort()).toEqual(['linea-c4', 'linea-e1', 'linea-e3']);
  });

  it('drives most of every BRT route on busway lanes', () => {
    for (const r of brtRoutes) {
      const edges = edgesOf(r).map((id) => graph.edges[id]);
      const total = edges.reduce((s, e) => s + e.len, 0);
      const busway = edges.filter((e) => e.access === 'brt').reduce((s, e) => s + e.len, 0);
      expect(busway / total, r.name).toBeGreaterThan(0.6);
    }
  });

  it('draws the legs and starts the bus on the busway lane into the first stop', () => {
    for (const r of brtRoutes) {
      expect(routePaths(mariscal, r, graph)).toHaveLength(r.stops.length);
      const nav = new Navigator(graph, 'brt', BRT_GENERAL_COST);
      const start = startPose(mariscal, graph, r);
      const spot = nav.locate(start.pos, start.heading, start.y, ground)!;
      const first = routeStops(mariscal, r)[0];
      const to = nav.locate(first.zone, first.stop.heading, ground(first.zone), ground)!;
      expect(nav.pathMeters(spot, to), r.name).toBeLessThan(150);
      // The leg lengths are real meters (not scaled by the busway preference).
      const legs = routeLegs(mariscal, r, graph);
      expect(legs.reduce((a, b) => a + b, 0), r.name).toBeGreaterThan(r.lengthM * 0.8);
    }
  });

  it('keeps ordinary routes and their arrow off the busways', () => {
    const ordinary = routes.filter((r) => !r.system);
    expect(ordinary.length).toBeGreaterThan(3);
    for (const r of ordinary) for (const id of edgesOf(r)) expect(graph.edges[id].access, `${r.name} e${id}`).toBe('general');
  });

  it('folds Trolebús C1 into C4, which shares its stations', () => {
    const c4 = mariscal.lines!.find((l) => l.ref === 'C4')!;
    expect(c4.alsoServedBy).toContain('Trolebús C1');
  });
});

describe('menu bus rule', () => {
  const start = { bus: 'popular', restore: null, manual: false };
  it('selects the articulated bus for a BRT route, and the old bus back for an ordinary one', () => {
    expect(BUSES.some((b) => b.preset.id === BRT_BUS)).toBe(true);
    const brt = busForRoute(start, true);
    expect(brt.bus).toBe('articulado');
    expect(busForRoute(brt, false).bus).toBe('popular');
  });
  it('leaves a bus the player picked for a BRT route alone', () => {
    const picked = { bus: 'buseta', restore: null, manual: true };
    expect(busForRoute(picked, true)).toBe(picked);
  });
  it('keeps the articulated bus the player already had on an ordinary route', () => {
    const had = { bus: 'articulado', restore: null, manual: false };
    expect(busForRoute(busForRoute(had, true), false).bus).toBe('articulado');
  });
});

describe('ambient BRT buses', () => {
  const lights = new TrafficLights(graph, mariscal.signals ?? []);
  const count = brtBusCount(graph);

  it('scales with the busway length and is zero without one', () => {
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(4);
  });

  it('shuttles along busway lanes only, stops at a station, and ordinary cars stay off busways', () => {
    const sim = new TrafficSim(graph, mariscal, { seed: 5, count: 40, brt: count, lights });
    const buses = sim.cars.filter((c) => c.kind === BRT_KIND);
    expect(buses).toHaveLength(count);
    // Bring them next to a station, as the session's recycle does around the player.
    // A station on a lane buses use (a busway stub that runs nowhere is closed to them: see `traps`).
    const edge = graph.edges.find((e) => e.access === 'brt' && e.len > 100 && (sim as any).stations[e.id].length && (sim as any).brtEdges.includes(e))!;
    const at = (sim as any).stations[edge.id][0] as number;
    sim.recycle({ pos: lanePoint(edge, at, 0), heading: 0 }, true);
    expect(buses.some((b) => b.state === 'driving')).toBe(true);
    // One bus 60 m before a station on its lane.
    const bus = buses[0];
    const dir = edgeDir(edge, at - 60);
    Object.assign(bus, { state: 'driving', edge: edge.id, s: at - 60, lane: 0, offset: laneOffset(edge, 0), pos: lanePoint(edge, at - 60, 0), heading: Math.atan2(-dir.z, dir.x), speed: 8, dwell: 0, served: -1, turn: null, reserved: null });
    (sim as any).chooseNext(bus);
    let atStation = 0;
    let off = 0;
    for (let t = 0; t < 60; t += 1 / 20) {
      sim.step(1 / 20, []);
      for (const b of buses) if (b.state === 'driving' && !b.turn && graph.edges[b.edge].access !== 'brt') off++;
      if (bus.edge === edge.id && Math.abs(bus.s - at) < 1.5 && bus.speed < 0.2) atStation++;
    }
    expect(off).toBe(0);
    expect(atStation, 'stood at the station').toBeGreaterThan(20);
    // ...and moved on afterwards.
    expect(bus.edge !== edge.id || bus.s > at + 3).toBe(true);
    for (const c of sim.cars) if (c.kind !== BRT_KIND && c.state === 'driving' && !c.turn) expect(graph.edges[c.edge].access).toBe('general');
  });
});
