import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { BusPreset } from '../src/vehicle/busPreset';
import { buildCity } from '../src/world/cityBuilder';
import { groundHeightAt, type CityData } from '../src/world/cityData';
import { DEFAULT_HILLS } from '../src/world/loadCity';
import { terrainHeight } from '../src/world/terrain';
import popular from '../data/buses/popular.json';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;

/** Steepest long stretch of road in the city (uphill direction). */
function steepest() {
  let best = { a: city.roads[0].points[0], b: city.roads[0].points[1], grade: 0, name: '' };
  for (const r of city.roads)
    for (let i = 0; i < r.points.length - 1; i++) {
      const [a, b] = [r.points[i], r.points[i + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 40) continue;
      const rise = terrainHeight(city.terrain!, b.x, b.z) - terrainHeight(city.terrain!, a.x, a.z);
      const grade = Math.abs(rise) / len;
      if (grade > best.grade) best = rise > 0 ? { a, b, grade, name: r.name } : { a: b, b: a, grade, name: r.name };
    }
  return best;
}

describe('La Mariscal physics', () => {
  beforeAll(() => initRapier());

  function setup() {
    const world = createWorld();
    buildCity(city, world, new THREE.Scene());
    return world;
  }

  it('the bus settles on the real terrain at the spawn point', () => {
    const world = setup();
    const p = city.spawn.pos;
    const bus = new BusPhysics(world, popular as BusPreset, { ...p, y: groundHeightAt(city, p), heading: city.spawn.heading });
    for (let t = 0; t < 2; t += PHYSICS_STEP) {
      bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    expect(bus.wheelsOnGround).toBe(4);
    const y = bus.body.translation().y - groundHeightAt(city, p);
    expect(y).toBeGreaterThan(1);
    expect(y).toBeLessThan(3);
  });

  it('climbs the steepest street from a standstill', () => {
    const world = setup();
    const hill = steepest();
    const heading = Math.atan2(-(hill.b.z - hill.a.z), hill.b.x - hill.a.x);
    // A little way up the street, clear of the junction at its foot.
    const start = { x: hill.a.x + (hill.b.x - hill.a.x) * 0.2, z: hill.a.z + (hill.b.z - hill.a.z) * 0.2 };
    const bus = new BusPhysics(world, popular as BusPreset, { ...start, y: groundHeightAt(city, start), heading });
    for (let t = 0; t < 1; t += PHYSICS_STEP) {
      bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    const y0 = bus.body.translation().y;
    for (let t = 0; t < 6; t += PHYSICS_STEP) {
      bus.update({ throttle: 1, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    console.log(`steepest: ${hill.name} ${(hill.grade * 100).toFixed(0)}%, climbed ${(bus.body.translation().y - y0).toFixed(1)} m, ${(bus.speed * 3.6).toFixed(0)} km/h`);
    // A loaded Quito bus slogs uphill, but it must never stall.
    expect(bus.speed * 3.6).toBeGreaterThan(18);
    expect(bus.body.translation().y - y0).toBeGreaterThan(3);
  });
});
