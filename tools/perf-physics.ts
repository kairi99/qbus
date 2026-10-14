/**
 * Per-step cost of the headless sim in Node (no WebGL, so no GPU contention): Rapier's step, the bus's
 * vehicle controller, traffic AI and the traffic bodies, with the bus driving and the full car budget.
 * Usage: npx tsx tools/perf-physics.ts [bus=popular] [cars=40] [seconds=20]
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { buildCity } from '../src/world/cityBuilder';
import { buildRoadGraph } from '../src/world/roadGraph';
import { groundHeightAt, type CityData } from '../src/world/cityData';
import { TrafficSim } from '../src/gameplay/traffic';
import { TrafficLights } from '../src/gameplay/trafficLights';
import { TrafficBodies, laneSurface } from '../src/gameplay/trafficBodies';
import { BusPhysics } from '../src/vehicle/bus';
import { busById } from '../src/vehicle/buses';

const busId = process.argv[2] ?? 'popular';
const cars = Number(process.argv[3] ?? 40);
const seconds = Number(process.argv[4] ?? 20);

await initRapier();
const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const graph = buildRoadGraph(city);
const world = createWorld();
buildCity(city, world, new THREE.Scene(), graph);
const { pos, heading } = city.spawn;
const bus = new BusPhysics(world, busById(busId), { x: pos.x, y: groundHeightAt(city, pos), z: pos.z, heading });
const sim = new TrafficSim(graph, city, { seed: 11, count: Math.max(cars, 1), lights: new TrafficLights(graph, city.signals ?? []) });
sim.setBudget(cars, pos);
sim.recycle({ pos, heading }, true);
const bodies = new TrafficBodies(world, sim, laneSurface(city, graph, sim, world));

const acc: Record<string, number> = {};
const time = <T>(k: string, f: () => T): T => {
  const t = performance.now();
  const r = f();
  acc[k] = (acc[k] ?? 0) + performance.now() - t;
  return r;
};
let steps = 0;
for (let t = 0; t < seconds; t += PHYSICS_STEP, steps++) {
  const warm = t < 3;
  const run = warm ? <T>(_k: string, f: () => T) => f() : time;
  run('bus.update', () => bus.update({ throttle: 1, steer: Math.sin(t) * 0.3, handbrake: false }, PHYSICS_STEP));
  const tr = bus.body.translation();
  run('traffic.step', () => sim.step(PHYSICS_STEP, [{ id: 'bus', pos: { x: tr.x, z: tr.z }, heading: bus.heading, length: 12, width: 2.5, lift: 0 }, ...bodies.obstacles()]));
  run('bodies.steer', () => bodies.steer(PHYSICS_STEP));
  run('world.step', () => world.step());
  run('bodies.afterStep', () => bodies.afterStep(PHYSICS_STEP, bus.body.collider(0), { x: tr.x, z: tr.z }));
  if (t > 3 && Math.floor(t * 10) % 20 === 0 && Math.abs(t * 10 - Math.round(t * 10)) < 0.1) sim.recycle({ pos: { x: tr.x, z: tr.z }, heading: bus.heading });
}
const n = steps - 180;
console.log(`${busId}, ${cars} cars, ${n} steps; colliders ${world.colliders.len()}, bodies ${world.bodies.len()}`);
let total = 0;
for (const [k, v] of Object.entries(acc)) {
  total += v;
  console.log(k.padEnd(18), (v / n).toFixed(3), 'ms/step');
}
console.log('total'.padEnd(18), (total / n).toFixed(3), 'ms/step');
