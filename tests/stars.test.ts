import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import type { CityData } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { routeLegs, routeStops, routesFor, startPose } from '../src/gameplay/routes';
import { STAR_TIERS, modelShift, starThresholds, starsFor } from '../src/gameplay/stars';

const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const grid = generateCity({ seed: 42 });

describe('starsFor', () => {
  it('counts the thresholds reached', () => {
    const t: [number, number, number] = [100, 200, 400];
    expect([0, 99, 100, 250, 399, 400, 9999].map((c) => starsFor(c, t))).toEqual([0, 0, 1, 2, 2, 3, 3]);
  });
});

// What the autopilot (tools/sim-shift.ts, real physics bus, no traffic) earned on La Mariscal,
// averaged over 3 passenger draws: careful (40 km/h), decent (60 km/h, nitro), expert (flat
// out, handbrake drifts). The targets must sort them: the careful driver a star, the decent one
// two at most, and three out of the autopilot's reach (a human expert also skims traffic).
const PLAYED: Record<string, [number, number, number]> = {
  circuito: [257, 363, 535],
  'linea-catar-061': [785, 1280, 1698],
  'linea-c4': [60, 377, 500],
  'linea-bellavista-002': [0, 113, 592],
};

describe('star targets against played shifts (La Mariscal)', () => {
  const graph = buildRoadGraph(mariscal);
  const routes = routesFor(mariscal, graph);
  it.each(Object.entries(PLAYED))('%s', (id, [casual, decent, expert]) => {
    const r = routes.find((x) => x.id === id)!;
    const t = starThresholds(routeStops(mariscal, r), routeLegs(mariscal, r, graph), startPose(mariscal, graph, r).pos);
    expect(starsFor(casual, t), 'careful').toBeLessThanOrEqual(1);
    expect(starsFor(decent, t), 'decent').toBeLessThanOrEqual(2);
    expect(starsFor(expert, t), 'expert autopilot').toBeLessThanOrEqual(2);
    // A careful shift that delivers is close to a star: under twice the money.
    if (casual > 100) expect(t[0], 'careful').toBeLessThan(casual * 2);
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
      expect(t[0], r.name).toBeGreaterThanOrEqual(50);
      // Each star asks clearly more than the one before; three asks for an expert run.
      expect(t[1] - t[0], r.name).toBeGreaterThanOrEqual(50);
      expect(t[2] - t[1], r.name).toBeGreaterThanOrEqual(50);
      expect(t[2], r.name).toBeGreaterThanOrEqual(300);
      expect(t[2], r.name).toBeLessThan(5000);
      // Deterministic: the same route always asks the same.
      expect(starThresholds(routeStops(city, r), routeLegs(city, r, graph), startPose(city, graph, r).pos)).toEqual(t);
    }
  });

  it('faster model drivers earn more', () => {
    const r = routes[0];
    const args = [routeStops(city, r), routeLegs(city, r, graph), startPose(city, graph, r).pos] as const;
    const avg = (pace: number) => [1, 2, 3, 4].reduce((s, seed) => s + modelShift(...args, pace, seed).cents, 0);
    expect(avg(STAR_TIERS[2].pace)).toBeGreaterThan(avg(STAR_TIERS[0].pace));
  });

  it('every leg has a finite legal length', () => {
    for (const r of routes) {
      const legs = routeLegs(city, r, graph);
      expect(legs).toHaveLength(r.stops.length);
      for (const l of legs) expect(isFinite(l) && l > 0, r.name).toBe(true);
    }
  });
});
