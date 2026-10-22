import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CityData } from '../src/world/cityData';
import { BIOMES, biomeOf } from '../src/world/biomes';
import { SHAPING } from '../src/world/osm/track';
import { terrainHeight } from '../src/world/terrain';
import { locateOnTrack } from '../src/world/track';
import { CANOPY_BOTTOM, canopyGeometry, CANOPY_CLEAR, PLANT_CLEAR, plantSpots } from '../src/world/trackBuilder';
import { distToPolyline } from '../src/world/geom';

describe('biomes', () => {
  it('páramo is the default and keeps the original look and terrain shaping', () => {
    expect(biomeOf(undefined)).toBe(BIOMES.paramo);
    const p = BIOMES.paramo;
    expect(p.terrain).toEqual({ low: '#4d7337', high: '#a39f58', earth: '#8a7660', rock: '#77736d', gravel: '#9a907f' });
    expect([p.plants.tries, p.plants.reach, p.plants.treeProb, p.plants.altFade, p.plants.shrubProb]).toEqual([3, 240, 0.8, 0.75, 0.75]);
    expect(p.canopy).toBeNull();
    expect(p.mist.zones).toEqual([0.32, 0.7]);
    expect(SHAPING.paramo).toEqual({ fill: 1.5, deepen: 1.3, reach: 90 });
    expect(SHAPING.cloudforest.deepen).toBeGreaterThan(SHAPING.paramo.deepen);
  });

  const city: CityData = JSON.parse(readFileSync('data/cities/silante.json', 'utf8'));
  const race = city.race!;
  const hw = race.width / 2;
  const ground = (p: { x: number; z: number }) => terrainHeight(city.terrain!, p.x, p.z);
  const plants = plantSpots(race, city.terrain!, ground);

  it('cloud forest: denser than the páramo, with ferns, bamboo and a canopy', () => {
    expect(race.biome).toBe('cloudforest');
    const kinds = new Set(plants.map((p) => p.kind));
    for (const k of ['tree', 'canopy', 'fern', 'bamboo', 'shrub'] as const) expect(kinds.has(k)).toBe(true);
    const pap: CityData = JSON.parse(readFileSync('data/cities/papallacta.json', 'utf8'));
    const dense = (c: CityData, n: number) => n / c.race!.cum[c.race!.cum.length - 1];
    const papPlants = plantSpots(pap.race!, pap.terrain!, (p) => terrainHeight(pap.terrain!, p.x, p.z)).length;
    expect(dense(city, plants.length)).toBeGreaterThan(dense(pap, papPlants) * 1.2);
  });

  it('canopy crowns hang at least CANOPY_CLEAR over the road, trunks stay off the clearance', () => {
    const canopy = plants.filter((p) => p.kind === 'canopy');
    expect(canopy.length).toBeGreaterThan(100);
    for (const c of canopy) {
      const where = locateOnTrack(race, c.p);
      expect(Math.abs(where.off)).toBeGreaterThanOrEqual(hw + PLANT_CLEAR - 0.01);
      expect(distToPolyline(c.p, race.points)).toBeGreaterThanOrEqual(hw + PLANT_CLEAR - 0.01);
      expect(c.y + CANOPY_BOTTOM * c.size * c.stretch).toBeGreaterThanOrEqual(where.y + CANOPY_CLEAR - 0.01);
      expect(c.solid).toBe(true);
    }
  });

  it('the canopy model has nothing but its trunk under CANOPY_BOTTOM', () => {
    const pos = canopyGeometry(5).getAttribute('position');
    let crownBelow = 0;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) < CANOPY_BOTTOM && Math.hypot(pos.getX(i), pos.getZ(i)) > 0.5) crownBelow++;
    expect(crownBelow).toBe(0);
  });
  it('the canopy crown is joined to its trunk (it leans out further than it is wide)', () => {
    // Straight up from the trunk's top (CANOPY_BOTTOM + 1) the crown starts at once, not open air.
    const mesh = new THREE.Mesh(canopyGeometry(5), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const ray = new THREE.Raycaster(new THREE.Vector3(0, CANOPY_BOTTOM + 1.05, 0), new THREE.Vector3(0, 1, 0), 0, 4);
    expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
  });
});
