import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CityData } from '../src/world/cityData';
import { routesFor, routeStops } from '../src/gameplay/routes';
import { lineDisplayName } from '../src/world/osm/lines';
import { buildRoadGraph } from '../src/world/roadGraph';
import { Navigator } from '../src/gameplay/navigation';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));

describe('real bus lines through La Mariscal', () => {
  it('are imported with both directions and real stops', () => {
    const lines = city.lines ?? [];
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(city.stops.map((s) => s.id));
    for (const l of lines) {
      expect(l.stops.length, l.name).toBeGreaterThanOrEqual(5);
      for (const id of l.stops) expect(ids.has(id), `${l.name}: ${id}`).toBe(true);
      expect(new Set(l.stops).size, l.name).toBe(l.stops.length);
    }
  });

  it('keep each direction in driving order (legs are short legal drives, not zigzags)', () => {
    const graph = buildRoadGraph(city);
    const nav = new Navigator(graph);
    const byId = new Map(city.stops.map((s) => [s.id, s]));
    const zone = (id: string) => routeStops(city, { id: '', name: '', blurb: '', stops: [id], lengthM: 0 })[0];
    let legs = 0;
    let good = 0;
    for (const l of city.lines ?? []) {
      for (const leg of [l.stops.slice(0, l.split), l.stops.slice(l.split)]) {
        for (let i = 0; i < leg.length - 1; i++) {
          const a = zone(leg[i]);
          const b = zone(leg[i + 1]);
          const from = nav.locate(a.zone, byId.get(leg[i])!.heading);
          const to = nav.locate(b.zone, byId.get(leg[i + 1])!.heading);
          const d = from && to ? nav.distanceTo(from, to) : Infinity;
          legs++;
          if (d < Math.hypot(b.zone.x - a.zone.x, b.zone.z - a.zone.z) * 2.5 + 400) good++;
        }
      }
    }
    expect(legs).toBeGreaterThan(30);
    expect(good / legs).toBeGreaterThan(0.9);
  });

  it('show up in the route menu, named after the real line', () => {
    const routes = routesFor(city);
    const real = routes.filter((r) => r.line);
    expect(real.length).toBeGreaterThanOrEqual(3);
    for (const r of real) {
      expect(r.name).toMatch(/\d/); // e.g. "Catar 061"
      expect(routeStops(city, r).length).toBeGreaterThanOrEqual(5);
    }
  });

  it('turns OSM refs into readable names', () => {
    expect(lineDisplayName({ ref: 'CATAR-061', route: 'bus' })).toBe('Catar 061');
    expect(lineDisplayName({ ref: 'SAN FRANCISCO DE CHILLOGALLO-R20', route: 'bus' })).toBe('San Francisco de Chillogallo R20');
    expect(lineDisplayName({ ref: 'C1', route: 'trolleybus' })).toBe('Trolebús C1');
  });
});
