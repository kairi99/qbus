import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { BusPreset } from '../src/vehicle/busPreset';
import { buildCity } from '../src/world/cityBuilder';
import { inPlayArea, type CityData, type Vec2 } from '../src/world/cityData';
import { DEFAULT_HILLS } from '../src/world/loadCity';
import { profileAt, projectOnRoad, roadProfiles } from '../src/world/elevation';
import popular from '../data/buses/popular.json';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;

beforeAll(() => initRapier());

describe('the map edge', () => {
  it('closes underpasses that run out of the play area too', () => {
    const world = createWorld();
    buildCity(city, world, new THREE.Scene());
    const profiles = roadProfiles(city);
    // Each underpass road that crosses the edge while down in its cut.
    const crossings: { name: string; from: Vec2; heading: number; y: number }[] = [];
    city.roads.forEach((r, i) => {
      const prof = profiles[i];
      if (!prof) return;
      for (let k = 1; k < r.points.length; k++) {
        const [a, b] = [r.points[k - 1], r.points[k]];
        if (inPlayArea(city, a) === inPlayArea(city, b)) continue;
        const [inside, outside] = inPlayArea(city, a) ? [a, b] : [b, a];
        const lift = profileAt(prof, projectOnRoad(r, outside).s).lift;
        if (lift > -2) continue;
        // Start 25 m inside, facing out along the road.
        const len = Math.hypot(outside.x - inside.x, outside.z - inside.z);
        const d = { x: (outside.x - inside.x) / len, z: (outside.z - inside.z) / len };
        const start = { x: outside.x - d.x * 25, z: outside.z - d.z * 25 };
        const s = projectOnRoad(r, start).s;
        crossings.push({ name: `${r.name} #${i}`, from: start, heading: Math.atan2(-d.z, d.x), y: profileAt(prof, s).y });
      }
    });
    expect(crossings.length).toBeGreaterThan(0);
    const escaped: string[] = [];
    for (const c of crossings) {
      const bus = new BusPhysics(world, popular as BusPreset, { x: c.from.x, y: c.y, z: c.from.z, heading: c.heading });
      for (let t = 0; t < 10; t += PHYSICS_STEP) {
        bus.update({ throttle: 1, steer: 0, handbrake: false }, PHYSICS_STEP);
        world.step();
      }
      const p = bus.body.translation();
      if (!inPlayArea(city, p, -3)) escaped.push(`${c.name} reached (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
      world.removeRigidBody(bus.body);
    }
    expect(escaped).toEqual([]);
  }, 120_000);
});
