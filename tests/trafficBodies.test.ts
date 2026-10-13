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
import { busById } from '../src/vehicle/buses';

const city = generateCity({ seed: 42 });
const graph = buildRoadGraph(city);

function setup(count: number, seed = 1, preset: BusPreset = popular as BusPreset) {
  const world = createWorld();
  addGround(world, 1200);
  buildCity(city, world, new THREE.Scene());
  const bus = new BusPhysics(world, preset, { x: 1e3, y: 0, z: 1e3, heading: 0 });
  const sim = new TrafficSim(graph, city, { seed, count });
  const bodies = new TrafficBodies(world, sim);
  const step = (throttle = 0) => {
    const t = bus.body.translation();
    sim.step(PHYSICS_STEP, bodies.obstacles());
    bodies.steer(PHYSICS_STEP);
    bus.update({ throttle, steer: 0, handbrake: false }, PHYSICS_STEP);
    world.step();
    return bodies.afterStep(PHYSICS_STEP, bus.colliders, { x: t.x, z: t.z });
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

  it('a car touching only the rear section of the articulated bus is knocked loose too', () => {
    const { sim, bus, step } = setup(1, 5, busById('articulado'));
    const car = sim.cars[0];
    const e = graph.edges[car.edge];
    const f = forward(e.heading);
    // The rear section's center on the car (the whole vehicle is centered a few meters ahead of it).
    const rearShift = bus.preset.body.length / 2 - bus.preset.articulated!.rearLength / 2;
    bus.reset({ x: car.pos.x + f.x * rearShift, y: 0, z: car.pos.z + f.z * rearShift, heading: e.heading });
    let hit = false;
    for (let t = 0; t < 0.5 && !hit; t += PHYSICS_STEP) hit = step(0).length > 0;
    expect(hit).toBe(true);
    expect(car.state).toBe('free');
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
  it('an R reset onto a car sends it (and only nearby ones) elsewhere', () => {
    const { bus, sim, bodies, step } = setup(20, 3);
    step();
    const car = sim.cars.find((c) => c.state === 'driving')!;
    const p = bodies.bodies[car.id].translation();
    const others = sim.cars.filter((c) => c !== car && c.state === 'driving' && Math.hypot(c.pos.x - p.x, c.pos.z - p.z) > 40);
    const before = others.map((c) => ({ ...c.pos }));
    const spot = { x: p.x, y: 0, z: p.z, heading: car.heading + 0.4 };
    bus.reset({ ...spot, pitch: 0 });
    expect(bodies.clearSpot(spot, bus.preset.body.length, bus.preset.body.width)).toBeGreaterThanOrEqual(1);
    const q = bodies.bodies[car.id].translation();
    expect(Math.hypot(q.x - spot.x, q.z - spot.z)).toBeGreaterThan(20);
    expect(others.map((c) => c.pos)).toEqual(before);
    // The bus drives off from the spot without a car to wedge it.
    for (let i = 0; i < 30; i++) expect(step(0)).toEqual([]);
    // A car well above the spot (a street over an underpass) stays.
    expect(bodies.clearSpot({ ...spot, y: -6.5 }, bus.preset.body.length, bus.preset.body.width)).toBe(0);
  });
});
