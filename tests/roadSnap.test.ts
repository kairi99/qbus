import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/world/procCity';
import { snapToRoad } from '../src/world/roadSnap';
import { forward, right, type CityData, type Vec2 } from '../src/world/cityData';
import { distToPolyline, pointInPolygon } from '../src/world/geom';

const city = generateCity({ seed: 42 });
const amazonas = city.roads.find((r) => r.name === 'Av. Amazonas')!;
const street = city.roads.find((r) => r.kind === 'street' && r.points[0].x === r.points[1].x)!; // N-S street
const NORTH = -Math.PI / 2; // +z
const SOUTH = Math.PI / 2;

const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const onAsphalt = (c: CityData, p: Vec2) => c.roads.some((r) => distToPolyline(p, r.points) < r.width / 2 - 0.5);

describe('snapToRoad', () => {
  it('moves a bus stuck inside a block back onto the nearest street', () => {
    const block = city.blocks.find((b) => b.kind === 'sidewalk')!;
    const inside = { x: (block.footprint[0].x + block.footprint[1].x) / 2, z: (block.footprint[0].z + block.footprint[2].z) / 2 };
    const s = snapToRoad(city, inside, 0.3);
    expect(onAsphalt(city, s.pos)).toBe(true);
    expect(city.buildings.some((b) => pointInPolygon(s.pos, b.footprint))).toBe(false);
  });

  it('aligns with the road, keeping whichever direction is closer to the current heading', () => {
    const x = street.points[0].x;
    expect(angleDiff(snapToRoad(city, { x: x + 1, z: 10 }, NORTH + 0.6).heading, NORTH)).toBeLessThan(1e-6);
    expect(angleDiff(snapToRoad(city, { x: x + 1, z: 10 }, SOUTH - 0.6).heading, SOUTH)).toBeLessThan(1e-6);
  });

  it('puts the bus in the right-hand lane for its direction of travel', () => {
    const x = street.points[0].x;
    for (const h of [NORTH, SOUTH]) {
      const s = snapToRoad(city, { x, z: 10 }, h);
      const r = right(s.heading);
      const lateral = (s.pos.x - x) * r.x;
      expect(lateral).toBeCloseTo(street.width / 4, 5);
    }
  });

  it('uses the right-hand half of an avenue', () => {
    const x = amazonas.points[0].x;
    const s = snapToRoad(city, { x: x - 7, z: 30 }, NORTH);
    expect((s.pos.x - x) * right(s.heading).x).toBeGreaterThan(2);
  });

  it('never lands on a ramp or speed hump', () => {
    for (const f of city.features) {
      const s = snapToRoad(city, f.pos, f.heading);
      const fw = forward(f.heading);
      const along = Math.abs((s.pos.x - f.pos.x) * fw.x + (s.pos.z - f.pos.z) * fw.z);
      const across = Math.abs((s.pos.x - f.pos.x) * fw.z - (s.pos.z - f.pos.z) * fw.x);
      const clear = along > f.length / 2 + 6 || across > f.width / 2 + 2;
      expect(clear, `${f.kind} at ${f.pos.x},${f.pos.z}`).toBe(true);
    }
  });

  it('stays inside the city at its outer edge', () => {
    const s = snapToRoad(city, { x: city.bounds.max.x + 80, z: city.bounds.max.z + 80 }, 0);
    expect(s.pos.x).toBeLessThan(city.bounds.max.x);
    expect(s.pos.z).toBeLessThan(city.bounds.max.z);
    expect(onAsphalt(city, s.pos)).toBe(true);
  });
});
