import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import { routesFor, routeStops } from '../src/gameplay/routes';
import type { CityData } from '../src/world/cityData';
import { distToPolyline } from '../src/world/geom';

const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const grid = generateCity({ seed: 42 });

describe.each([
  ['La Mariscal', mariscal, 3],
  ['grid', grid, 2],
])('routesFor (%s)', (_, city, minRoutes) => {
  const routes = routesFor(city);

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

