import { describe, expect, it } from 'vitest';
import { generateCity, SIDEWALK_WIDTH } from '../src/world/procCity';
import type { CityData, Vec2 } from '../src/world/cityData';
import { bbox, distToPolyline, pointInPolygon, polygonToPolylineDistance } from '../src/world/geom';

const EPS = 0.01;

/** Distance from p to the nearest road edge; negative when p is on the asphalt. */
function roadClearance(c: CityData, p: Vec2): number {
  return Math.min(...c.roads.map((r) => distToPolyline(p, r.points) - r.width / 2));
}

it('generateCity is deterministic per seed', () => {
  expect(generateCity({ seed: 42 })).toEqual(generateCity({ seed: 42 }));
  expect(generateCity({ seed: 7 }).buildings).not.toEqual(generateCity({ seed: 42 }).buildings);
});

describe.each([42, 1, 2, 3, 99])('generateCity (seed %i)', (seed) => {
  const city = generateCity({ seed });

  it('produces a sizeable city with an avenue', () => {
    expect(city.roads.length).toBeGreaterThanOrEqual(10);
    expect(city.roads.some((r) => r.kind === 'avenue')).toBe(true);
    expect(city.buildings.length).toBeGreaterThan(150);
    expect(city.stops.length).toBeGreaterThanOrEqual(10);
    expect(city.props.length).toBeGreaterThan(40);
    expect(city.features.some((f) => f.kind === 'ramp')).toBe(true);
    expect(city.features.some((f) => f.kind === 'hump')).toBe(true);
  });

  it('keeps buildings off roads and sidewalks', () => {
    for (const b of city.buildings) {
      for (const r of city.roads) {
        expect(polygonToPolylineDistance(b.footprint, r.points)).toBeGreaterThanOrEqual(r.width / 2 + SIDEWALK_WIDTH - EPS);
      }
    }
  });

  it('does not overlap buildings', () => {
    const boxes = city.buildings.map((b) => bbox(b.footprint));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap =
          a.min.x < b.max.x - EPS && b.min.x < a.max.x - EPS && a.min.z < b.max.z - EPS && b.min.z < a.max.z - EPS;
        expect(overlap, `buildings ${i} and ${j}`).toBe(false);
      }
    }
  });

  it('spawns the bus on a road, clear of buildings', () => {
    expect(roadClearance(city, city.spawn.pos)).toBeLessThan(-2);
    expect(city.buildings.some((b) => pointInPolygon(city.spawn.pos, b.footprint))).toBe(false);
  });

  it('places stops on the sidewalk to the right of travel', () => {
    for (const s of city.stops) {
      const c = roadClearance(city, s.pos);
      expect(c, s.name).toBeGreaterThan(0);
      expect(c, s.name).toBeLessThan(SIDEWALK_WIDTH);
      // A point just to the left of the stop (toward traffic) should be on asphalt.
      const toRoad = { x: s.pos.x - Math.sin(s.heading) * (c + 1), z: s.pos.z - Math.cos(s.heading) * (c + 1) };
      expect(roadClearance(city, toRoad), s.name).toBeLessThan(0);
    }
    expect(new Set(city.stops.map((s) => s.id)).size).toBe(city.stops.length);
  });

  it('names stops Quito-style ("X y Y")', () => {
    for (const s of city.stops) expect(s.name).toMatch(/^.+ y .+$/);
  });

  it('puts features on roads and props off roads', () => {
    for (const f of city.features) expect(roadClearance(city, f.pos)).toBeLessThan(0);
    for (const p of city.props) expect(roadClearance(city, p.pos)).toBeGreaterThan(0.2);
    for (const t of city.trees) expect(roadClearance(city, t)).toBeGreaterThan(0.2);
  });

  it('keeps everything inside bounds', () => {
    const { min, max } = city.bounds;
    for (const b of city.buildings)
      for (const p of b.footprint) {
        expect(p.x).toBeGreaterThanOrEqual(min.x);
        expect(p.x).toBeLessThanOrEqual(max.x);
        expect(p.z).toBeGreaterThanOrEqual(min.z);
        expect(p.z).toBeLessThanOrEqual(max.z);
      }
  });
});
