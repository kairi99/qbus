import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CityData, Vec2 } from '../src/world/cityData';
import { inPlayArea } from '../src/world/cityData';
import { distToPolyline, pointInPolygon } from '../src/world/geom';
import { buildRoadGraph } from '../src/world/roadGraph';
import { routesFor, routeStops } from '../src/gameplay/routes';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const onAsphalt = (p: Vec2) => city.roads.some((r) => distToPolyline(p, r.points) < r.width / 2);

describe('the edge of La Mariscal (roadworks)', () => {
  it('has a play area inside the map', () => {
    const a = city.playArea!;
    expect(a).toBeDefined();
    expect(a.min.x).toBeGreaterThan(city.bounds.min.x + 40);
    expect(a.max.z).toBeLessThan(city.bounds.max.z - 40);
  });

  it('keeps traffic, stops and stations inside it', () => {
    const g = buildRoadGraph(city);
    for (const e of g.edges.filter((e) => e.drivable)) expect(e.center.pts.every((p) => inPlayArea(city, p)), e.road).toBe(true);
    for (const s of city.stops) expect(inPlayArea(city, s.pos, 10), s.name).toBe(true);
    for (const s of city.stations ?? []) expect(inPlayArea(city, s.pos, 10), s.name).toBe(true);
    for (const r of routesFor(city, g)) for (const rs of routeStops(city, r)) expect(inPlayArea(city, rs.zone), `${r.name}: ${rs.stop.name}`).toBe(true);
  });
});

describe('campus walls', () => {
  const walls = city.walls ?? [];

  it('wall off the Escuela Politécnica Nacional', () => {
    // EPN's grounds (OSM way 31135336) are around (600..800, 560..720).
    const near = walls.filter((w) => w.points.some((p) => p.x > 560 && p.x < 840 && p.z > 540 && p.z < 740));
    expect(near.length).toBeGreaterThan(0);
  });

  it('never stand on the asphalt or in a building', () => {
    for (const w of walls)
      for (const p of w.points) {
        expect(onAsphalt(p), `${p.x},${p.z}`).toBe(false);
        expect(city.buildings.some((b) => pointInPolygon(p, b.footprint))).toBe(false);
      }
  });

  it('never cut across a street between their points', () => {
    for (const w of walls)
      for (let i = 1; i < w.points.length; i++) {
        const a = w.points[i - 1];
        const b = w.points[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        for (let s = 0; s <= len; s += 0.5) {
          const p = { x: a.x + ((b.x - a.x) * s) / len, z: a.z + ((b.z - a.z) * s) / len };
          expect(onAsphalt(p), `wall piece (${a.x.toFixed(1)},${a.z.toFixed(1)})-(${b.x.toFixed(1)},${b.z.toFixed(1)})`).toBe(false);
        }
      }
  });
});

describe('far terrain and landmarks', () => {
  it('has El Panecillo with the Virgen, higher than La Mariscal, and Pichincha behind', () => {
    const h = city.horizon!;
    expect(h).toBeDefined();
    const virgen = city.landmarks!.find((l) => l.kind === 'virgen')!;
    // ~3,016 m on a city ~2,800 m up.
    expect(virgen.y).toBeGreaterThan(150);
    expect(virgen.y).toBeLessThan(320);
    // Southwest of the zone, about 4 km away.
    expect(virgen.pos.x).toBeLessThan(-2000);
    expect(virgen.pos.z).toBeGreaterThan(2000);
    // Rucu Pichincha (4,698 m) is the highest ground in range.
    expect(Math.max(...h.heights)).toBeGreaterThan(1700);
    expect(city.landmarks!.some((l) => l.name === 'Cotopaxi')).toBe(true);
  });
});
