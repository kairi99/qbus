import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import { buildRoadGraph } from '../src/world/roadGraph';
import { Navigator } from '../src/gameplay/navigation';
import { routesFor, routeStops } from '../src/gameplay/routes';
import type { CityData } from '../src/world/cityData';

const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const grid = generateCity({ seed: 42 });

describe.each([
  ['La Mariscal', mariscal],
  ['grid', grid],
])('Navigator (%s)', (_, city) => {
  const graph = buildRoadGraph(city);
  const nav = new Navigator(graph);
  const routes = routesFor(city, graph);

  it('finds each stop on a lane that runs in its direction of travel', () => {
    for (const s of city.stops.slice(0, 40)) {
      const at = nav.locate(s.pos, s.heading)!;
      expect(at, s.name).not.toBeNull();
      const e = graph.edges[at.edge];
      expect(e.drivable).toBe(true);
      expect(Math.cos(e.heading - s.heading) > 0 || Math.cos(e.endHeading - s.heading) > 0, s.name).toBe(true);
    }
  });

  it('plans legal paths: consecutive edges connect head to tail', () => {
    const [a, b] = routeStops(city, routes[0]);
    const p = nav.route(nav.locate(a.zone, a.stop.heading)!, nav.locate(b.zone, b.stop.heading)!)!;
    expect(p).not.toBeNull();
    for (let i = 1; i < p.edges.length; i++) expect(graph.edges[p.edges[i]].from).toBe(graph.edges[p.edges[i - 1]].to);
    expect(p.points.length).toBeGreaterThan(1);
  });

  it('builds routes whose every leg can be driven legally without silly detours', () => {
    for (const r of routes) {
      const stops = routeStops(city, r);
      for (let i = 0; i < stops.length; i++) {
        const a = stops[i];
        const b = stops[(i + 1) % stops.length];
        const p = nav.route(nav.locate(a.zone, a.stop.heading)!, nav.locate(b.zone, b.stop.heading)!);
        expect(p, `${r.name}: ${a.stop.name} → ${b.stop.name}`).not.toBeNull();
        const straight = Math.hypot(b.zone.x - a.zone.x, b.zone.z - a.zone.z);
        expect(p!.length, `${r.name}: ${a.stop.name} → ${b.stop.name}`).toBeLessThan(straight * 2.5 + 400);
      }
    }
  });

  it('points the way along the path, not straight at the stop', () => {
    const [a, b] = routeStops(city, routes[0]);
    const p = nav.route(nav.locate(a.zone, a.stop.heading)!, nav.locate(b.zone, b.stop.heading)!)!;
    const guide = nav.guidePoint(p, a.zone, 30);
    // The guide lies on the path, ~30 m along it.
    const onPath = p.points.some((q) => Math.hypot(q.x - guide.x, q.z - guide.z) < 3);
    expect(onPath).toBe(true);
  });
});
