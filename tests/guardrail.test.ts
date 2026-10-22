import { beforeAll, describe, expect, it } from 'vitest';
import { RAPIER, PHYSICS_STEP, addGround, createWorld, initRapier } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { railSolid } from '../src/world/railSolid';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';
import ae86 from '../data/buses/ae86.json';

// A rail bending gently away along x (posts every 4 m, like the track's), hit at 90 km/h.
describe.each([popular, ae86] as BusPreset[])('guardrail ($name)', (preset) => {
  beforeAll(() => initRapier());

  for (const deg of [10, 25]) it(`a ${deg}° hit scrapes along it instead of stopping dead`, () => {
    const world = createWorld();
    addGround(world, 3000);
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const line = Array.from({ length: 101 }, (_, k) => ({ x: k * 4, z: 8 + 0.00004 * (k * 4) ** 2, y: 0.5 }));
    railSolid(line, 0.78, world, fixed);
    const h = (-deg * Math.PI) / 180;
    const bus = new BusPhysics(world, preset, { x: 20, y: 1.5, z: 0, heading: h });
    for (let t = 0; t < 1; t += PHYSICS_STEP) bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP), world.step();
    for (const b of bus.bodies) b.setLinvel({ x: Math.cos(h) * 25, y: 0, z: -Math.sin(h) * 25 }, true);
    let slowest = Infinity;
    for (let t = 0; t < 3; t += PHYSICS_STEP) {
      bus.update({ throttle: 1, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
      if (t > 0.3) slowest = Math.min(slowest, bus.speed * 3.6);
    }
    expect(slowest).toBeGreaterThan(60);
    // It stayed on the road side.
    expect(bus.body.translation().z).toBeLessThan(8 + 0.00004 * bus.body.translation().x ** 2);
  });
});
