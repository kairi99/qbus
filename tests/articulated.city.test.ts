import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { vehicleClearance } from '../src/physics/clearance';
import { BusPhysics } from '../src/vehicle/bus';
import { busById } from '../src/vehicle/buses';
import { buildCity } from '../src/world/cityBuilder';
import type { CityData } from '../src/world/cityData';
import { DEFAULT_HILLS } from '../src/world/loadCity';
import { buildRoadGraph } from '../src/world/roadGraph';
import { snapToRoad } from '../src/world/roadSnap';
import { freeStartPose, routesFor, startPose } from '../src/gameplay/routes';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const preset = busById('articulado');

describe('articulated bus in La Mariscal', () => {
  const graph = buildRoadGraph(city);
  let world: ReturnType<typeof createWorld>;
  beforeAll(async () => {
    await initRapier();
    world = createWorld();
    buildCity(city, world, new THREE.Scene(), graph);
  });

  it('has room at every route start and the free-roam start (whole 18 m footprint clear of walls)', () => {
    const fits = vehicleClearance(world, preset.body);
    const poses = [...routesFor(city).map((r) => ({ id: r.id, pose: startPose(city, graph, r) })), { id: 'free', pose: freeStartPose(city, graph) }];
    const blocked = poses.filter((p) => !fits(p.pose)).map((p) => p.id);
    expect(blocked).toEqual([]);
  });

  it('the R reset finds a clear spot, sections in line and level with the road', () => {
    const fits = vehicleClearance(world, preset.body);
    const start = freeStartPose(city, graph);
    const bus = new BusPhysics(world, preset, { x: start.pos.x, y: start.y, z: start.pos.z, heading: start.heading, pitch: start.pitch });
    for (let t = 0; t < 2; t += PHYSICS_STEP) {
      bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    expect(bus.wheelsOnGround).toBe(6);
    const c = bus.position();
    const s = snapToRoad(city, { x: c.x, z: c.z }, bus.heading, bus.roadHeight(), { clear: fits, length: preset.body.length });
    bus.reset({ x: s.pos.x, y: s.y, z: s.pos.z, heading: s.heading, pitch: s.pitch });
    for (let t = 0; t < 2; t += PHYSICS_STEP) {
      bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    expect(bus.wheelsOnGround).toBe(6);
    expect(Math.abs(bus.bend)).toBeLessThan(0.05);
    expect(Math.abs(bus.roadHeight() - s.y)).toBeLessThan(0.5);
  });

  it('drives a street for 30 s and corners without flipping or folding past its limit', () => {
    const start = freeStartPose(city, graph);
    const bus = new BusPhysics(world, preset, { x: start.pos.x, y: start.y, z: start.pos.z, heading: start.heading, pitch: start.pitch });
    let maxBend = 0;
    let minUp = 1;
    for (let t = 0; t < 30; t += PHYSICS_STEP) {
      bus.update({ throttle: t < 6 ? 1 : 0.2, steer: t > 8 && Math.sin(t) > 0.5 ? 0.6 : 0, handbrake: false }, PHYSICS_STEP);
      world.step();
      maxBend = Math.max(maxBend, Math.abs(bus.bend));
      for (const b of bus.bodies) {
        const q = b.rotation();
        minUp = Math.min(minUp, 1 - 2 * (q.x * q.x + q.z * q.z));
      }
    }
    expect(maxBend).toBeLessThan(((preset.articulated!.yawLimitDeg + 6) * Math.PI) / 180);
    expect(minUp).toBeGreaterThan(0.8);
  });
});
