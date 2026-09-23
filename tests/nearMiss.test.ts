import { beforeAll, expect, it } from 'vitest';
import { addGround, createWorld, initRapier, PHYSICS_STEP, RAPIER } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { NearMissDetector } from '../src/gameplay/nearMiss';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';

const preset = popular as BusPreset;

/** Bus driving along +X with a 200 m wall on its left, `gap` meters from its side. */
function drivePastWall(gap: number | null) {
  const world = createWorld();
  addGround(world);
  if (gap !== null) {
    const wallZ = -(preset.body.width / 2 + gap + 0.5);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(100, 3, wallZ));
    world.createCollider(RAPIER.ColliderDesc.cuboid(100, 3, 0.5), body);
  }
  const bus = new BusPhysics(world, preset, { x: -40, y: 0, z: 0, heading: 0 });
  const nm = new NearMissDetector(world, bus);
  let n = 0;
  for (let t = 0; t < 7; t += PHYSICS_STEP) {
    bus.update({ throttle: t < 0.5 ? 0 : 1, steer: 0, handbrake: false }, PHYSICS_STEP);
    world.step();
    n += nm.update(PHYSICS_STEP);
  }
  return n;
}

beforeAll(() => initRapier());

it('counts a fast close pass along a wall, rate-limited per obstacle', () => {
  const n = drivePastWall(0.6);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(3); // one wall collider, 2 s cooldown
});

it('ignores walls that are not close', () => {
  expect(drivePastWall(3)).toBe(0);
});

it('ignores open road', () => {
  expect(drivePastWall(null)).toBe(0);
});
