import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, RAPIER } from '../src/physics/world';
import { buildCity } from '../src/world/cityBuilder';
import { groundHeightAt, type CityData } from '../src/world/cityData';
import { buildRoadGraph, dirAt, edgeY, lanePoint } from '../src/world/roadGraph';

beforeAll(() => initRapier());

describe('La Mariscal lanes', () => {
  it('have nothing solid standing across them (walls, roofs, lips)', () => {
    const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
    city.terrain!.scale = 1.3;
    const graph = buildRoadGraph(city);
    const world = createWorld();
    buildCity(city, world, new THREE.Scene(), graph);
    world.step();
    const blocked: string[] = [];
    for (const e of graph.edges) {
      if (!e.drivable) continue;
      for (let s = 2; s < e.len - 2; s += 1.5) {
        const p = lanePoint(e, s, 0);
        const d = dirAt(e.center, s);
        for (const h of [0.6, 1.5]) {
          const y = (edgeY(e, s) ?? groundHeightAt(city, p)) + h;
          // Short look straight ahead along the lane: anything but ground rising under it blocks.
          const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: p.x, y, z: p.z }, { x: d.x, y: 0, z: d.z }), 1.5, true);
          if (hit && hit.normal.y <= 0.6) blocked.push(`${e.road} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}), ${h} m up`);
        }
      }
    }
    expect(blocked).toEqual([]);
  }, 120_000);
});
