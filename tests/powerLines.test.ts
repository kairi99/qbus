import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { attachPoints, cableY, GROUND_CLEAR, layLine, nearTower, ROAD_CLEAR, towerFrames } from '../src/world/powerLines';
import { terrainAt } from '../src/world/cityData';
import { locateOnTrack } from '../src/world/track';
import { importPowerLines } from '../src/world/osm/track';
import type { OsmJson } from '../src/world/osm/import';
import type { CityData } from '../src/world/cityData';

const toXZ = (lat: number, lon: number) => ({ x: lon * 1000, z: -lat * 1000 });

describe('power lines', () => {
  it('cuts the line at the terrain edge and keeps only mapped towers', () => {
    const osm = {
      elements: [
        { type: 'node', id: 1, lat: 0, lon: 1, tags: { power: 'tower' } },
        { type: 'node', id: 2, lat: 0, lon: 2, tags: { power: 'tower' } },
        { type: 'node', id: 3, lat: 0, lon: 3, tags: { power: 'tower' } },
        { type: 'node', id: 4, lat: 0, lon: 9, tags: { power: 'tower' } },
        {
          type: 'way',
          id: 9,
          tags: { power: 'line', cables: '6', circuits: '2' },
          geometry: [null, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }, { lat: 0, lon: 2.5 }, { lat: 0, lon: 3 }, { lat: 0, lon: 9 }],
        },
        { type: 'way', id: 10, tags: { power: 'minor_line' }, geometry: [{ lat: 0, lon: 1 }, { lat: 0, lon: 2 }] },
      ],
    } as unknown as OsmJson;
    const lines = importPowerLines(osm, toXZ, (p) => p.x < 5000);
    // The untagged 2.5 node breaks the run; the node at 9 lies outside; the pole line is no tower line.
    expect(lines.length).toBe(1);
    expect(lines[0].towers).toEqual([{ x: 1000, z: -0 }, { x: 2000, z: -0 }]);
    expect(lines[0].circuits).toBe(2);
  });

  it('points the arms across the line, bisecting its bend', () => {
    const towers = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 200, z: 100 }];
    const f = towerFrames(towers);
    expect(f[0].along).toEqual({ x: 1, z: 0 });
    expect(Math.abs(f[1].along.x * f[1].across.x + f[1].along.z * f[1].across.z)).toBeLessThan(1e-9);
    // Middle tower: along the bisector of east and north-east.
    const ang = Math.atan2(f[1].along.z, f[1].along.x);
    expect(ang).toBeCloseTo(Math.PI / 8, 5);
    const pts = attachPoints(towers[1], f[1], 10);
    expect(pts.length).toBe(7);
    for (const p of pts.slice(0, 6)) expect((p.x - 100) * f[1].along.x + p.z * f[1].along.z).toBeCloseTo(0, 6);
  });

  it('hangs cables below both ends, symmetric about midspan', () => {
    const sag = 0.035 * 300;
    for (const u of [0.1, 0.3, 0.5]) {
      expect(cableY(50, 40, u, sag)).toBeLessThan(50 + (40 - 50) * u);
      expect(cableY(50, 40, u, sag) - (50 + (40 - 50) * u)).toBeCloseTo(cableY(50, 40, 1 - u, sag) - (50 + (40 - 50) * (1 - u)), 9);
    }
    expect(cableY(50, 40, 0, sag)).toBe(50);
    expect(cableY(50, 40, 1, sag)).toBe(40);
    expect(cableY(10, 10, 0.5, sag)).toBeCloseTo(10 - sag, 9);
  });

  it('Silante has the real towers, none near a plant spot, and the chapel', () => {
    const city: CityData = JSON.parse(readFileSync('data/cities/silante.json', 'utf8'));
    const sc = city.race!.scenery!;
    expect(sc.powerLines!.length).toBeGreaterThan(0);
    expect(sc.powerLines![0].towers.length).toBeGreaterThanOrEqual(5);
    expect(sc.buildings.filter((b) => b.kind === 'chapel').length).toBe(1);
    expect(nearTower(sc.powerLines, sc.powerLines![0].towers[0], 1)).toBe(true);
    const pap: CityData = JSON.parse(readFileSync('data/cities/papallacta.json', 'utf8'));
    expect(pap.race!.scenery!.powerLines).toBeUndefined();
  });

  it('Silante cables hang well clear of the road and the ground (towers low in the valley stand on extensions)', () => {
    const city: CityData = JSON.parse(readFileSync('data/cities/silante.json', 'utf8'));
    const race = city.race!;
    const ground = (p: { x: number; z: number }) => terrainAt(city, p);
    let overRoad = 0;
    for (const line of race.scenery!.powerLines!) {
      const { cables, lifts } = layLine(race, line, ground);
      // Extended, not absurd: the body is ~42 m.
      expect(Math.max(...lifts)).toBeLessThanOrEqual(45);
      for (const pts of cables)
        for (const p of pts) {
          expect(p.y - ground(p)).toBeGreaterThan(GROUND_CLEAR - 0.5);
          const at = locateOnTrack(race, p);
          if (Math.abs(at.off) < race.width / 2 + 3) {
            overRoad++;
            expect(p.y - at.y).toBeGreaterThan(ROAD_CLEAR - 0.5);
          }
        }
    }
    // The spans beside the road do come over it (the case that hung cables on the asphalt).
    expect(overRoad).toBeGreaterThan(0);
  });
});
