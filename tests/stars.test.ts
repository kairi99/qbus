import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import type { CityData } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { routeLegs, routeStops, routesFor, startPose } from '../src/gameplay/routes';
import { STAR_SPEEDS, modelShift, starThresholds, starsFor } from '../src/gameplay/stars';

const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const grid = generateCity({ seed: 42 });

describe('starsFor', () => {
  it('counts the thresholds reached', () => {
    const t: [number, number, number] = [100, 200, 400];
    expect([0, 99, 100, 250, 399, 400, 9999].map((c) => starsFor(c, t))).toEqual([0, 0, 1, 2, 2, 3, 3]);
  });
});

describe.each([
  ['La Mariscal', mariscal],
  ['grid', grid],
])('star thresholds (%s)', (_, city) => {
  const graph = buildRoadGraph(city);
  const routes = routesFor(city, graph);

  it('rise from 1 to 3 stars, within sane money for a shift', () => {
    for (const r of routes) {
      const t = starThresholds(routeStops(city, r), routeLegs(city, r, graph), startPose(city, graph, r).pos);
      expect(t[0], r.name).toBeGreaterThanOrEqual(35); // at least a fare
      expect(t[1], r.name).toBeGreaterThan(t[0]);
      expect(t[2], r.name).toBeGreaterThan(t[1]);
      expect(t[2], r.name).toBeLessThan(2000);
      // Deterministic: the same route always asks the same.
      expect(starThresholds(routeStops(city, r), routeLegs(city, r, graph), startPose(city, graph, r).pos)).toEqual(t);
    }
  });

  it('faster model drivers earn more', () => {
    const r = routes[0];
    const args = [routeStops(city, r), routeLegs(city, r, graph), startPose(city, graph, r).pos] as const;
    const avg = (speed: number) => [1, 2, 3, 4].reduce((s, seed) => s + modelShift(...args, speed, seed), 0);
    expect(avg(STAR_SPEEDS[2])).toBeGreaterThan(avg(STAR_SPEEDS[0]));
  });

  it('every leg has a finite legal length', () => {
    for (const r of routes) {
      const legs = routeLegs(city, r, graph);
      expect(legs).toHaveLength(r.stops.length);
      for (const l of legs) expect(isFinite(l) && l > 0, r.name).toBe(true);
    }
  });
});
