import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import { routePaths, routesFor, routeStops, startPose } from '../src/gameplay/routes';
import { type CityData, forward } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { Navigator } from '../src/gameplay/navigation';
import { distToPolyline } from '../src/world/geom';

const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const grid = generateCity({ seed: 42 });

describe.each([
  ['La Mariscal', mariscal, 3],
  ['grid', grid, 2],
])('routesFor (%s)', (_, city, minRoutes) => {
  const graph = buildRoadGraph(city);
  const routes = routesFor(city, graph);

  it('offers a neighborhood circuit plus corridor or real-line routes', () => {
    expect(routes[0].id).toBe('circuito');
    expect(routes.length).toBeGreaterThanOrEqual(minRoutes);
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
  });

  it('gives every route enough distinct, real stops', () => {
    const ids = new Set(city.stops.map((s) => s.id));
    for (const r of routes) {
      expect(r.stops.length, r.name).toBeGreaterThanOrEqual(5);
      expect(new Set(r.stops).size, r.name).toBe(r.stops.length);
      for (const id of r.stops) expect(ids.has(id), `${r.name}: ${id}`).toBe(true);
      expect(r.lengthM).toBeGreaterThan(300);
    }
  });

  it('keeps corridor routes on their avenue, out one way and back the other', () => {
    for (const r of routes.filter((r) => r.corridor)) {
      const road = city.roads.filter((x) => x.name === r.corridor);
      const stops = routeStops(city, r).map((s) => s.stop);
      for (const s of stops) {
        const d = Math.min(...road.map((x) => distToPolyline(s.pos, x.points)));
        expect(d, `${r.name}: ${s.name}`).toBeLessThan(25);
      }
      // Headings flip exactly once around the loop (out, then back).
      const dirs = stops.map((s) => Math.cos(s.heading - stops[0].heading) > 0);
      const flips = dirs.filter((d, i) => i > 0 && d !== dirs[i - 1]).length;
      expect(flips, r.name).toBeLessThanOrEqual(1);
    }
  });

  it('shows tidy stop names', () => {
    for (const s of city.stops) {
      expect(s.name, s.name).not.toMatch(/sin nombre|\b[SN]-[NS]\b/i);
      expect(s.name[0], s.name).toBe(s.name[0].toUpperCase());
    }
  });

  it('starts the bus facing the first stop, a short legal drive before it', () => {
    const nav = new Navigator(graph);
    for (const r of routes) {
      const start = startPose(city, graph, r);
      const first = routeStops(city, r)[0];
      const f = forward(start.heading);
      const dx = first.zone.x - start.pos.x;
      const dz = first.zone.z - start.pos.z;
      const d = Math.hypot(dx, dz);
      expect(d, r.name).toBeGreaterThan(30);
      expect((f.x * dx + f.z * dz) / d, `${r.name}: stop ahead`).toBeGreaterThan(0.5);
      // No U-turn needed: driving on legally reaches the stop in about the lead-in distance.
      const from = nav.locate(start.pos, start.heading)!;
      const to = nav.locate(first.zone, first.stop.heading)!;
      expect(nav.distanceTo(from, to), r.name).toBeLessThan(130);
    }
  });

  it('draws each leg along the streets, not as a straight line', () => {
    const edgePts = graph.edges.flatMap((e) => e.center.pts);
    for (const r of routes) {
      const legs = routePaths(city, r, graph);
      expect(legs.length, r.name).toBe(r.stops.length);
      for (const leg of legs) {
        // Every vertex sits on a street (lane points are within a road width of a centerline).
        for (const p of leg.slice(1, -1)) {
          expect(graph.edges.some((e) => distToPolyline(p, e.center.pts) < e.roadWidth), r.name).toBe(true);
        }
        expect(leg.length, r.name).toBeGreaterThan(2);
      }
    }
    expect(edgePts.length).toBeGreaterThan(0);
  });

  it('routeStops puts a stopping zone on the road beside each stop', () => {
    for (const rs of routeStops(city, routes[1])) {
      expect(Math.hypot(rs.zone.x - rs.stop.pos.x, rs.zone.z - rs.stop.pos.z)).toBeGreaterThan(2);
    }
  });
});

describe('route pruning', () => {
  it('drops the dead-end stop itself, not the healthy stops after it', () => {
    const routes = routesFor(mariscal);
    // Catar 061 has one unreachable stop at its end; the line must survive with the rest.
    const catar = routes.find((r) => r.line === 'CATAR-061');
    expect(catar, 'Catar 061 kept').toBeDefined();
    expect(catar!.stops.length).toBeGreaterThanOrEqual(15);
  });
});

