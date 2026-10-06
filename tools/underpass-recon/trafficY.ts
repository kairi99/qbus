/**
 * Do traffic bodies ride at their lane height? Lists driving cars whose physics body is more than
 * 1 m off the lane surface, a few times over a run (the body is what trafficView draws).
 * Usage: npx tsx tools/underpass-recon/trafficY.ts
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../../src/physics/world';
import { buildCity } from '../../src/world/cityBuilder';
import type { CityData } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph } from '../../src/world/roadGraph';
import { TrafficSim } from '../../src/gameplay/traffic';
import { TrafficBodies, laneSurface } from '../../src/gameplay/trafficBodies';
import { BusPhysics } from '../../src/vehicle/bus';
import type { BusPreset } from '../../src/vehicle/busPreset';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const popular = JSON.parse(readFileSync('data/buses/popular.json', 'utf8')) as BusPreset;

async function main() {
  await initRapier();
  const graph = buildRoadGraph(city);
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), graph);
  const focus = { x: -40, z: 735 };
  const bus = new BusPhysics(world, popular, { x: 2000, y: 200, z: 2000, heading: 0 });
  const sim = new TrafficSim(graph, city, { seed: 1, count: 40 });
  sim.setBudget(40, focus);
  sim.recycle({ pos: focus, heading: 0 }, true);
  const ground = laneSurface(city, graph, sim);
  const bodies = new TrafficBodies(world, sim, ground);
  for (let t = 0; t < 60; t += PHYSICS_STEP) {
    sim.step(PHYSICS_STEP, bodies.obstacles());
    bodies.steer(PHYSICS_STEP);
    world.step();
    bodies.afterStep(PHYSICS_STEP, bus.body.collider(0), { x: 2000, z: 2000 });
    const tick = Math.round(t / PHYSICS_STEP);
    if (![1, 60, 600, 1800, 3500].includes(tick)) continue;
    const off: string[] = [];
    sim.cars.forEach((c, i) => {
      if (c.state !== 'driving') return;
      const b = bodies.bodies[i].translation();
      const want = ground(c.pos, i) + c.kind.height / 2 + 0.02;
      if (Math.abs(b.y - want) > 1) off.push(`car ${i} gen ${c.generation} at (${c.pos.x.toFixed(0)}, ${c.pos.z.toFixed(0)}) body y ${b.y.toFixed(1)} want ${want.toFixed(1)} enabled ${bodies.bodies[i].isEnabled()} dist ${Math.hypot(c.pos.x - focus.x, c.pos.z - focus.z).toFixed(0)} on ${graph.edges[c.edge].road}`);
    });
    console.log(`t ${t.toFixed(1)}: ${sim.cars.filter((c) => c.state === 'driving').length} driving, ${off.length} off their lane height by > 1 m`);
    for (const o of off.slice(0, 6)) console.log('  ' + o);
  }
}
main();
