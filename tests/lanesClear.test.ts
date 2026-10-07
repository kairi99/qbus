import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, RAPIER } from '../src/physics/world';
import { buildCity } from '../src/world/cityBuilder';
import { groundHeightAt, type CityData } from '../src/world/cityData';
import { DEFAULT_HILLS } from '../src/world/loadCity';
import { buildRoadGraph, dirAt, edgeY, lanePoint } from '../src/world/roadGraph';

beforeAll(() => initRapier());

/**
 * Along every lane of every drivable edge, a short look straight ahead at a bus's wheel, waist
 * and roof heights (the tallest bus is ~3.45 m): anything but ground rising under it blocks
 * (walls, roofs and lintels too low, lips). At the real scale (DEFAULT_HILLS) and exaggerated.
 */
function blockedLanes(scale: number): string[] {
  const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
  city.terrain!.scale = scale;
  const graph = buildRoadGraph(city);
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), graph);
  world.step();
  const blocked: string[] = [];
  for (const e of graph.edges) {
    if (!e.drivable) continue;
    for (let k = 0; k < e.lanes; k++)
      for (let s = 2; s < e.len - 2; s += 1.5) {
        const p = lanePoint(e, s, k);
        const d = dirAt(e.center, s);
        for (const h of [0.6, 1.5, 3.3]) {
          const y = (edgeY(e, s) ?? groundHeightAt(city, p)) + h;
          const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: p.x, y, z: p.z }, { x: d.x, y: 0, z: d.z }), 1.5, true);
          if (hit && hit.normal.y <= 0.6) blocked.push(`${e.road} (e${e.id} lane ${k}) at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}), ${h} m up`);
        }
      }
  }
  return blocked;
}

describe('La Mariscal lanes', () => {
  it('have nothing solid standing across them (walls, roofs, lips)', () => {
    expect(blockedLanes(DEFAULT_HILLS)).toEqual([]);
  }, 180_000);

  it('...with the hills exaggerated too', () => {
    expect(blockedLanes(1.3)).toEqual([]);
  }, 180_000);
});
