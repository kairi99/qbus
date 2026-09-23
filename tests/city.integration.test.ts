import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addGround, createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { BusPreset } from '../src/vehicle/busPreset';
import type { DriveInput } from '../src/core/input';
import { generateCity } from '../src/world/procCity';
import { buildCity } from '../src/world/cityBuilder';
import { forward, nearestRoad, type Feature } from '../src/world/cityData';
import popular from '../data/buses/popular.json';

const city = generateCity({ seed: 42 });
const go: DriveInput = { throttle: 1, steer: 0, handbrake: false };

function setup() {
  const world = createWorld();
  addGround(world, 1200);
  const scene = new THREE.Scene();
  const built = buildCity(city, world, scene);
  const bus = new BusPhysics(world, popular as BusPreset, { ...city.spawn.pos, y: 0, heading: city.spawn.heading });
  const run = (input: DriveInput, seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds; t += PHYSICS_STEP) {
      bus.update(input, PHYSICS_STEP);
      world.step();
      each?.();
    }
  };
  /** Place the bus `dist` meters before a feature, facing along it. */
  const approach = (f: Feature, dist: number) => {
    const fw = forward(f.heading);
    bus.reset({ x: f.pos.x - fw.x * dist, y: 0, z: f.pos.z - fw.z * dist, heading: f.heading });
  };
  return { world, scene, bus, run, approach, props: built.props };
}

describe('city + bus integration', () => {
  beforeAll(() => initRapier());

  it('builds a scene with a few merged meshes', () => {
    const { scene, props } = setup();
    const meshes: THREE.Object3D[] = [];
    scene.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o));
    expect(meshes.length).toBeLessThan(60);
    expect(props.count).toBe(city.props.length);
  });

  it('spawns on the avenue and drives up it unobstructed', () => {
    const { bus, run } = setup();
    run({ ...go, throttle: 0 }, 1);
    expect(bus.wheelsOnGround).toBe(4);
    run(go, 5);
    expect(bus.speed * 3.6).toBeGreaterThan(50);
  });

  it('gets airborne off a ramp and lands upright', () => {
    const { bus, run, approach } = setup();
    const ramp = city.features.find((f) => f.kind === 'ramp')!;
    approach(ramp, 45);
    run({ ...go, throttle: 0 }, 0.5);
    let airborne = 0;
    run(go, 8, () => {
      if (bus.wheelsOnGround === 0) airborne += PHYSICS_STEP;
    });
    expect(airborne).toBeGreaterThan(0.3);
    run({ ...go, throttle: 0 }, 3);
    const q = bus.body.rotation();
    expect(1 - 2 * (q.x * q.x + q.z * q.z)).toBeGreaterThan(0.5);
  });

  it('bumps over a speed hump without stopping', () => {
    const { bus, run, approach } = setup();
    const hump = city.features.find((f) => f.kind === 'hump')!;
    approach(hump, 30);
    run({ ...go, throttle: 0 }, 0.5);
    run(go, 4);
    expect(bus.speed).toBeGreaterThan(5);
  });

  it('knocks props over when driven into', () => {
    const { bus, run, world } = setup();
    // Drive down the sidewalk (fits between curb and buildings) into a curbside fruit stand.
    const stand = city.props.find(
      (p) =>
        p.kind === 'fruitStand' &&
        p.heading === 0 &&
        nearestRoad(city, { x: p.pos.x, z: p.pos.z - 4 }) &&
        !city.stops.some((s) => Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z) < 25),
    )!;
    bus.reset({ x: stand.pos.x - 16, y: 0, z: stand.pos.z, heading: 0 }); // facing +x
    run({ ...go, throttle: 0 }, 0.5);
    let body: { translation(): { x: number; z: number } } | null = null;
    world.forEachRigidBody((b) => {
      const t = b.translation();
      if (b.isDynamic() && Math.hypot(t.x - stand.pos.x, t.z - stand.pos.z) < 0.1) body = b;
    });
    expect(body).not.toBeNull();
    run(go, 3);
    const t = body!.translation();
    expect(Math.hypot(t.x - stand.pos.x, t.z - stand.pos.z)).toBeGreaterThan(1);
  });

  it('reports knocked props once each', () => {
    const { bus, run, props } = setup();
    const stand = city.props.find((p) => p.kind === 'fruitStand' && p.heading === 0 && nearestRoad(city, { x: p.pos.x, z: p.pos.z - 4 }) && !city.stops.some((s) => Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z) < 25))!;
    run({ ...go, throttle: 0 }, 0.2);
    expect(props.consumeKnocked()).toBe(0);
    bus.reset({ x: stand.pos.x - 16, y: 0, z: stand.pos.z, heading: 0 });
    let total = 0;
    run(go, 3, () => (total += props.consumeKnocked()));
    expect(total).toBeGreaterThanOrEqual(1);
    run({ ...go, throttle: 0 }, 1, () => (total += props.consumeKnocked() * 1000));
    expect(total).toBeLessThan(1000);
  });
});
