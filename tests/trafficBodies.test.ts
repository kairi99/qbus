import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addGround, createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { generateCity } from '../src/world/procCity';
import { buildCity } from '../src/world/cityBuilder';
import { buildRoadGraph, lanePoint } from '../src/world/roadGraph';
import { TrafficSim } from '../src/gameplay/traffic';
import { TrafficBodies } from '../src/gameplay/trafficBodies';
import { BusPhysics } from '../src/vehicle/bus';
import type { BusPreset } from '../src/vehicle/busPreset';
import { forward } from '../src/world/cityData';
import popular from '../data/buses/popular.json';

const city = generateCity({ seed: 42 });
const graph = buildRoadGraph(city);

function setup(count: number, seed = 1) {
  const world = createWorld();
  addGround(world, 1200);
  buildCity(city, world, new THREE.Scene());
  const bus = new BusPhysics(world, popular as BusPreset, { x: 1e3, y: 0, z: 1e3, heading: 0 });
  const sim = new TrafficSim(graph, city, { seed, count });
  const bodies = new TrafficBodies(world, sim);
  const step = (throttle = 0) => {
    const t = bus.body.translation();
    sim.step(PHYSICS_STEP, bodies.obstacles());
    bodies.steer(PHYSICS_STEP);
    bus.update({ throttle, steer: 0, handbrake: false }, PHYSICS_STEP);
    world.step();
    return bodies.afterStep(PHYSICS_STEP, bus.body.collider(0), { x: t.x, z: t.z });
  };
  return { world, bus, sim, bodies, step };
}

describe('TrafficBodies', () => {
  beforeAll(() => initRapier());

  it('bodies track their lane poses while nothing gets in the way', () => {
    const { sim, bodies, step } = setup(20);
    for (let t = 0; t < 20; t += PHYSICS_STEP) step();
    const driving = sim.cars.filter((c) => c.state === 'driving');
    expect(driving.length).toBe(20);
    for (const c of driving) {
      const p = bodies.bodies[c.id].translation();
      expect(Math.hypot(p.x - c.pos.x, p.z - c.pos.z)).toBeLessThan(0.3);
      expect(p.y).toBeLessThan(c.kind.height);
    }
  });

  it('a bus ramming a car knocks it loose, then it respawns far away', () => {
    const { sim, bodies, bus, step } = setup(1, 5);
    const car = sim.cars[0];
    const e = graph.edges[car.edge];
    // Bus 25 m behind the car, same lane, flooring it.
    const behind = lanePoint(e, Math.max(0, car.s - 25), car.lane);
    const f = forward(e.heading);
    bus.reset({ x: behind.x - f.x * Math.max(0, 25 - car.s), y: 0, z: behind.z - f.z * Math.max(0, 25 - car.s), heading: e.heading });
    let hitAt = -1;
    for (let t = 0; t < 8 && hitAt < 0; t += PHYSICS_STEP) if (step(1).length) hitAt = t;
    expect(hitAt).toBeGreaterThan(0);
    expect(car.state).toBe('free');
    const start = { ...bodies.bodies[0].translation() };
    for (let t = 0; t < 0.5; t += PHYSICS_STEP) step(1);
    const moved = bodies.bodies[0].translation();
    expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(0.5);
    // Stop the bus and wait for the wreck to be recycled.
    for (let t = 0; t < 14; t += PHYSICS_STEP) step(-1);
    expect(car.state).toBe('driving');
    const b = bus.body.translation();
    expect(Math.hypot(car.pos.x - b.x, car.pos.z - b.z)).toBeGreaterThan(80);
  });

  it('snaps a body to its car when the sim relocates it', () => {
    const { sim, bodies, step } = setup(30);
    step();
    sim.recycle({ pos: { x: 250, z: 250 }, heading: 0 });
    step();
    for (const c of sim.cars) {
      if (c.state !== 'driving') continue;
      const p = bodies.bodies[c.id].translation();
      expect(Math.hypot(p.x - c.pos.x, p.z - c.pos.z)).toBeLessThan(0.5);
    }
  });

  it('removes parked cars from physics and restores them', () => {
    const { sim, bodies, step } = setup(12);
    sim.setBudget(4, { x: 0, z: 0 });
    step();
    expect(bodies.bodies.filter((b) => b.isEnabled())).toHaveLength(4);
    sim.setBudget(12, { x: 0, z: 0 });
    step();
    expect(bodies.bodies.filter((b) => b.isEnabled())).toHaveLength(12);
  });
});
