import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { busById } from '../src/vehicle/buses';
import { buildCity } from '../src/world/cityBuilder';
import type { CityData } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { terrainHeight } from '../src/world/terrain';
import { BORE_HALF, BORE_TOP, BORE_WALL, MOUND_HALF, inTunnel, locateOnTrack, trackPoint, trackPose } from '../src/world/track';
import { boreRing, moundHeight, moundRise, tunnelRows } from '../src/world/tunnels';
import { plantSpots } from '../src/world/trackBuilder';
import { mudPatches, slideSites } from '../src/gameplay/landslides';

const city: CityData = JSON.parse(readFileSync('data/cities/rioverde.json', 'utf8'));
const race = city.race!;
const tunnels = race.tunnels!;
const ground = (p: { x: number; z: number }) => terrainHeight(city.terrain!, p.x, p.z);

describe('Río Verde: the real tunnels and bridges (OSM tunnel / bridge ways)', () => {
  it('has the four tunnels of the Ruta de las Cascadas, with their real lengths, inside the race', () => {
    expect(tunnels).toHaveLength(4);
    const lens = tunnels.map((t) => t.s1 - t.s0);
    // 277 m, 493 m, Cadanillas 707 m, Chirosinguna 811 m (OSM's own lines, 3 m samples).
    [277, 493, 707, 811].forEach((want, i) => expect(Math.abs(lens[i] - want)).toBeLessThan(12));
    for (const t of tunnels) {
      expect(t.s0).toBeGreaterThan(race.start + 150);
      expect(t.s1).toBeLessThan(race.finish - 100);
    }
    for (let i = 1; i < tunnels.length; i++) expect(tunnels[i].s0).toBeGreaterThan(tunnels[i - 1].s1 + 100);
  });

  it('has its real bridges, none overlapping a tunnel, and the road is a plain deck everywhere else', () => {
    expect(race.bridges!.length).toBeGreaterThanOrEqual(3);
    for (const b of race.bridges!) for (const t of tunnels) expect(b.s1 < t.s0 - 1 || b.s0 > t.s1 + 1).toBe(true);
  });

  it('keeps the bore wide enough for the 2 lanes and a shoulder, and tall enough for the tallest bus', () => {
    const ring = boreRing(race.width / 2);
    expect(BORE_HALF).toBeGreaterThan(race.width / 2 + 0.8);
    expect(BORE_HALF).toBeLessThan(race.width / 2 + 2.5);
    // Over the outer lane's far edge (4.2 m out) the arch is still 4.5 m up.
    const at = (u: number) => Math.max(...ring.filter((p) => Math.abs(p.u - u) < 0.9 && p.v > BORE_WALL - 0.01).map((p) => p.v));
    expect(at(race.width / 2 - 1)).toBeGreaterThan(4.5);
    expect(Math.max(...ring.map((p) => p.v))).toBeCloseTo(BORE_TOP, 5);
    // Every ring point is on or outside the lane edges (nothing inside the swept space).
    for (const p of ring) if (p.v > 0.1) expect(Math.abs(p.u)).toBeGreaterThanOrEqual(0);
  });

  it('closes the bore: the terrain lies under the deck across it, and the rock mound is over it everywhere', () => {
    const ring = boreRing(race.width / 2);
    let worstGround = -Infinity;
    let thinnest = Infinity;
    for (const t of tunnels)
      for (const s of tunnelRows(t)) {
        const q = trackPoint(race, s);
        const n = { x: -q.dz, z: q.dx };
        for (const p of ring) {
          const at = { x: q.x + n.x * p.u, z: q.z + n.z * p.u };
          // The ground is no higher than the floor across the bore (it is the road's ordinary cut)...
          if (p.v < 0.1) worstGround = Math.max(worstGround, ground(at) - q.y);
          // ...and the mound over each ring point is higher than the ring point itself, with rock to spare.
          thinnest = Math.min(thinnest, moundHeight(t, s, p.u, q.y, ground(at)) - (q.y + p.v));
        }
        for (let u = -BORE_HALF; u <= BORE_HALF; u += 0.5) {
          const at = { x: q.x + n.x * u, z: q.z + n.z * u };
          worstGround = Math.max(worstGround, ground(at) - q.y);
        }
      }
    expect(worstGround).toBeLessThan(0.02);
    expect(thinnest).toBeGreaterThan(2);
  });

  it('the mound rises from each portal toward the mountain (the DEM) and meets the cut ground at its sides', () => {
    for (const t of tunnels) {
      expect(moundRise(t, t.s0)).toBeGreaterThanOrEqual(BORE_TOP + 2);
      expect(moundRise(t, t.s0 + 40)).toBeGreaterThanOrEqual(moundRise(t, t.s0));
      const q = trackPoint(race, t.s0 + 20);
      expect(moundHeight(t, t.s0 + 20, MOUND_HALF, q.y, 123.4)).toBeCloseTo(123.4, 5);
      expect(moundHeight(t, t.s0 + 20, 0, q.y, q.y - 5)).toBeGreaterThan(q.y + BORE_TOP);
    }
  });

  it('no rail, pickup, plant, slide site or mud patch inside a tunnel (or at its mouths)', () => {
    for (const r of race.rails) {
      const bridge = race.bridges!.some((b) => Math.abs(b.s0 - r.s0) < 0.2 && Math.abs(b.s1 - r.s1) < 0.2);
      if (!bridge) for (const t of tunnels) expect(r.s1 < t.s0 - 11 || r.s0 > t.s1 + 11).toBe(true);
    }
    for (const p of race.pickups) expect(inTunnel(race, p.s, 40)).toBe(false);
    const plants = plantSpots(race, city.terrain!, ground);
    expect(plants.length).toBeGreaterThan(500);
    for (const pl of plants) {
      const at = locateOnTrack(race, pl.p);
      expect(inTunnel(race, at.s, 24) && Math.abs(at.off) < MOUND_HALF + 6).toBe(false);
    }
    for (let seed = 1; seed <= 6; seed++) for (const site of slideSites(race, seed, ground)) expect(inTunnel(race, site.s, 90)).toBe(false);
    for (const m of mudPatches(race)) expect(inTunnel(race, m.s, 20)).toBe(false);
  });

  it('has the real waterfalls near the road: a course down the slope each, falling well over 20 m', () => {
    const falls = race.scenery!.waterfalls!;
    expect(falls.length).toBeGreaterThanOrEqual(3);
    for (const f of falls) {
      expect(f.points.length).toBeGreaterThanOrEqual(5);
      expect(f.y[0] - f.y[f.y.length - 1]).toBeGreaterThan(20);
      const d = Math.min(...f.points.map((p) => Math.hypot(p.x - trackPoint(race, locateOnTrack(race, p).s).x, p.z - trackPoint(race, locateOnTrack(race, p).s).z)));
      expect(d).toBeLessThan(700);
    }
    // San Jorge's stream runs under a real bridge on the road: the course crosses the track there.
    expect(falls.some((f) => f.points.some((p) => Math.abs(locateOnTrack(race, p).off) < 3))).toBe(true);
  });
});

describe('Río Verde: driving through a tunnel (physics)', () => {
  let world: ReturnType<typeof createWorld>;
  beforeAll(async () => {
    await initRapier();
    world = createWorld();
    buildCity(city, world, new THREE.Scene(), buildRoadGraph(city));
  });

  it('a bus at full speed cannot leave the bore through its wall: it scrapes along it, inside', () => {
    const t = tunnels[2];
    const s = t.s0 + 120;
    const pose = trackPose(race, s, 1.5);
    const heading = pose.heading - 0.35;
    const bus = new BusPhysics(world, busById('popular'), { x: pose.pos.x, y: pose.y, z: pose.pos.z, heading, pitch: pose.pitch });
    bus.body.setLinvel({ x: Math.cos(heading) * 20, y: 0, z: -Math.sin(heading) * 20 }, true);
    const p = { x: 0, y: 0, z: 0 };
    let widest = 0;
    let top = -Infinity;
    for (let k = 0; k < 4 / PHYSICS_STEP; k++) {
      bus.update({ throttle: 1, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
      const at = locateOnTrack(race, bus.position(p), s, 100);
      widest = Math.max(widest, Math.abs(at.off));
      top = Math.max(top, p.y - at.y);
    }
    for (const b of bus.bodies) world.removeRigidBody(b);
    expect(widest).toBeLessThan(BORE_HALF + 0.1);
    expect(top).toBeLessThan(2.6);
  });

  it('a bus at the middle of a tunnel sits on the road, wheels down, level with it', () => {
    const t = tunnels[3];
    const pose = trackPose(race, (t.s0 + t.s1) / 2, 2.1);
    const bus = new BusPhysics(world, busById('interparroquial'), { x: pose.pos.x, y: pose.y, z: pose.pos.z, heading: pose.heading, pitch: pose.pitch });
    for (let k = 0; k < 1 / PHYSICS_STEP; k++) {
      bus.update({ throttle: 0, steer: 0, handbrake: true }, PHYSICS_STEP);
      world.step();
    }
    expect(bus.wheelsOnGround).toBe(4);
    expect(Math.abs(bus.roadHeight() - pose.y)).toBeLessThan(0.5);
    for (const b of bus.bodies) world.removeRigidBody(b);
  });
});
