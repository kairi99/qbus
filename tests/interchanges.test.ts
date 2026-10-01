import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { buildCity } from '../src/world/cityBuilder';
import type { CityData } from '../src/world/cityData';
import { DEFAULT_HILLS } from '../src/world/loadCity';
import { buildRoadGraph } from '../src/world/roadGraph';
import { TrafficSim } from '../src/gameplay/traffic';
import { TrafficBodies, laneSurface } from '../src/gameplay/trafficBodies';
import { BusPhysics } from '../src/vehicle/bus';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;

describe('traffic through the bridges and underpasses', () => {
  beforeAll(() => initRapier());

  it.each([
    ['Puente del Guambra', { x: -660, z: 292 }],
    ['Patria y 12 de Octubre', { x: -30, z: 725 }],
  ])('flows through %s without cars getting stuck', (_, focus) => {
    const graph = buildRoadGraph(city);
    const world = createWorld();
    buildCity(city, world, new THREE.Scene(), graph);
    // The bus is parked far away: nothing but the road itself can knock a car off its lane.
    const bus = new BusPhysics(world, popular as BusPreset, { x: 2000, y: 200, z: 2000, heading: 0 });
    const sim = new TrafficSim(graph, city, { seed: 3, count: 40 });
    sim.setBudget(40, focus);
    sim.recycle({ pos: focus, heading: 0 }, true);
    const bodies = new TrafficBodies(world, sim, laneSurface(city, graph, sim));
    let stuck = 0;
    const prev = sim.cars.map((c) => c.state);
    for (let t = 0; t < 40; t += PHYSICS_STEP) {
      sim.step(PHYSICS_STEP, bodies.obstacles());
      bodies.steer(PHYSICS_STEP);
      world.step();
      bodies.afterStep(PHYSICS_STEP, bus.body.collider(0), { x: 2000, z: 2000 });
      sim.cars.forEach((c, i) => {
        if (c.state === 'free' && prev[i] === 'driving') stuck++;
        prev[i] = c.state;
      });
    }
    expect(stuck).toBeLessThanOrEqual(1);
  });
});
