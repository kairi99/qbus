import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { busById } from '../src/vehicle/buses';
import { buildCity } from '../src/world/cityBuilder';
import type { CityData } from '../src/world/cityData';
import { terrainHeight } from '../src/world/terrain';
import { buildRoadGraph } from '../src/world/roadGraph';
import { snapToRoad } from '../src/world/roadSnap';
import { locateOnTrack, trackPoint, trackPose, trackStartPose } from '../src/world/track';
import { RaceDriver, SKILLS, vehicleLimits } from '../src/gameplay/raceDriver';
import { gridSlots } from '../src/gameplay/raceField';
import { TrafficSim } from '../src/gameplay/traffic';
import { FALL_AIR, FALL_SHOW, FallWatch } from '../src/gameplay/fallWatch';
import { PLANT_CLEAR, plantSpots } from '../src/world/trackBuilder';
import { distToPolyline } from '../src/world/geom';

/** The race tracks every invariant below must hold on (`from` = the race's first place name). */
const ZONES = [
  { id: 'papallacta', name: 'Paso de la Muerte', from: 'Papallacta' },
  { id: 'silante', name: 'Bajada del Silante', from: 'Arrayán' },
];

describe.each(ZONES)('$name', (zone) => {
  const city: CityData = JSON.parse(readFileSync(`data/cities/${zone.id}.json`, 'utf8'));
  const race = city.race!;
  const hw = race.width / 2;

  it('has no bend a long bus cannot steer round in its lane (hairpins eased to minRadius at import)', () => {
    const P = race.points;
    let tightest = Infinity;
    for (let i = 5; i < P.length - 5; i++) {
      if (race.cum[i] < race.start || race.cum[i] > race.finish) continue;
      const [a, b, c] = [P[i - 5], P[i], P[i + 5]];
      const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      const r = (Math.hypot(b.x - a.x, b.z - a.z) * Math.hypot(c.x - b.x, c.z - b.z) * Math.hypot(a.x - c.x, a.z - c.z)) / (2 * cross);
      tightest = Math.min(tightest, r);
    }
    expect(tightest).toBeGreaterThan(22);
  });

  describe('the grid and the traffic', () => {
    it('fits four of the longest vehicles one behind the other, behind the start line, none overlapping', () => {
      const lengths = [19.6, 18.4, 19.6, 19.6];
      const slots = gridSlots(race, lengths);
      const at = slots.map((p) => locateOnTrack(race, p.pos));
      at.forEach((a, k) => {
        expect(a.s + lengths[k] / 2).toBeLessThanOrEqual(race.start + 0.1);
        expect(a.s - lengths[k] / 2).toBeGreaterThan(0);
        for (let j = 0; j < k; j++)
          if (Math.sign(at[j].off) === Math.sign(a.off)) expect(at[j].s - lengths[j] / 2 - (a.s + lengths[k] / 2)).toBeGreaterThan(2);
      });
    });

    it('traffic drives both ways, never onto the grid, and off the road’s ends without turning round', () => {
      const graph = buildRoadGraph(city);
      const ahead = graph.edges.map((e) => Math.hypot(e.center.pts[0].x - race.points[0].x, e.center.pts[0].z - race.points[0].z) < 1);
      const trackS = (edge: number, s: number) => (ahead[edge] ? s : graph.edges[edge].len - s);
      const keep = (edge: number, s: number) => trackS(edge, s) > race.start + 250;
      const sim = new TrafficSim(graph, city, { seed: 3, count: 10, keep, uturns: false });
      const grid = trackStartPose(race);
      // The player at the grid, then looking far down the road: cars come toward the grid and must stop or go.
      let closest = Infinity;
      const ways = new Set<number>();
      for (let t = 0; t < 120; t += 0.05) {
        // Around the grid and, half the time, further down the road (as if the player were there).
        const at = t % 20 < 10 ? grid : trackPose(race, 900);
        sim.recycle({ pos: at.pos, heading: at.heading });
        sim.step(0.05, []);
        for (const c of sim.cars) {
          if (c.state !== 'driving') continue;
          ways.add(ahead[c.edge] ? 1 : -1);
          closest = Math.min(closest, trackS(c.edge, c.s));
          // A turn at a dead end would be a U-turn.
          expect(c.turn).toBeNull();
        }
      }
      expect(ways.size).toBe(2);
      expect(closest).toBeGreaterThan(race.start + 200);
    });
  });

  describe('the track (data)', () => {
    it('is one road from its first town, 4–8 km raced, its centerline sampled every ~3 m', () => {
      expect(city.roads).toHaveLength(1);
      expect(race.from).toBe(zone.from);
      expect(race.finish - race.start).toBeGreaterThan(4000);
      expect(race.finish - race.start).toBeLessThan(8000);
      for (let i = 1; i < race.points.length; i++) {
        const d = race.cum[i] - race.cum[i - 1];
        expect(d).toBeGreaterThan(1.5);
        expect(d).toBeLessThan(4.5);
      }
    });

    it('never climbs or drops steeper than 12% over a bus length', () => {
      let worst = 0;
      for (let s = 0; s + 12 < race.cum[race.cum.length - 1]; s += 3) worst = Math.max(worst, Math.abs(trackPoint(race, s + 12).y - trackPoint(race, s).y) / 12);
      expect(worst).toBeLessThan(0.12);
    });

    it('the ground never shows through the asphalt (it lies under the deck everywhere across the road)', () => {
      let worst = -Infinity;
      for (let s = 0; s < race.cum[race.cum.length - 1]; s += 3) {
        const q = trackPoint(race, s);
        for (let off = -hw; off <= hw; off += 0.5) worst = Math.max(worst, terrainHeight(city.terrain!, q.x - q.dz * off, q.z + q.dx * off) - q.y);
      }
      expect(worst).toBeLessThan(0.02);
    });

    it('has ravine drops along it, mostly railed, some left open, none near the start or finish', () => {
      const railed = race.rails.reduce((n, r) => n + r.s1 - r.s0, 0);
      const open = race.drops.reduce((n, r) => n + r.s1 - r.s0, 0);
      expect(railed).toBeGreaterThan(800);
      expect(open).toBeGreaterThan(150);
      expect(open / (open + railed)).toBeLessThan(0.4);
      for (const d of race.drops) {
        expect(d.s0).toBeGreaterThan(race.start + 200);
        expect(d.s1).toBeLessThan(race.finish - 100);
      }
      // Rails and open drops on one side never overlap.
      for (const side of [1, -1]) {
        const spans = [...race.rails, ...race.drops].filter((r) => r.side === side).sort((a, b) => a.s0 - b.s0);
        for (let i = 1; i < spans.length; i++) expect(spans[i].s0).toBeGreaterThanOrEqual(spans[i - 1].s1 - 0.01);
      }
    });

    it('no tree, shrub or rock stands on or beside the road, any leg of it (hairpins too)', () => {
      const plants = plantSpots(race, city.terrain!, (p) => terrainHeight(city.terrain!, p.x, p.z));
      expect(plants.length).toBeGreaterThan(1000);
      const near = plants.filter((pl) => distToPolyline(pl.p, race.points) < hw + PLANT_CLEAR - 0.01);
      expect(near).toEqual([]);
    });

    it('locates points along it: on the centerline, off to either side, near a hint', () => {
      const q = trackPoint(race, 1500);
      const right = { x: q.x - q.dz * 2, z: q.z + q.dx * 2 };
      const at = locateOnTrack(race, right);
      expect(at.s).toBeCloseTo(1500, 0);
      expect(at.off).toBeCloseTo(2, 1);
      expect(locateOnTrack(race, right, 1490, 40).s).toBeCloseTo(1500, 0);
      const pose = trackPose(race, 1500, -2);
      expect(locateOnTrack(race, pose.pos).off).toBeCloseTo(-2, 1);
    });

    // Papallacta's hairpin: s 1840 and 3520 are two legs of it.
    it.runIf(zone.id === 'papallacta')('with a height, a search near an old spot tells another leg of the road from the road under a point', () => {
      // A bus put on the road far from its last spot (a teleport, a respawn): near the old spot the
      // nearest road in plan is another leg, 38 m off but 80 m up. Its height gives it away, and
      // the whole track is searched instead (as main.ts does), finding the road under the bus.
      const q = trackPoint(race, 3520);
      const p = { x: q.x, z: q.z, y: q.y + 1.5 };
      const near = locateOnTrack(race, p, 1840, 120);
      expect(Math.hypot(near.off, near.y - p.y)).toBeGreaterThan(25);
      expect(locateOnTrack(race, p).s).toBeCloseTo(3520, -1);
    });
  });

  describe('the fall watch', () => {
    const on = { roadY: 10, busY: 10.8, off: 0, halfWidth: hw, wheelsOnGround: 4 };
    it('stays quiet on the road and on the shoulder', () => {
      const w = new FallWatch();
      for (let t = 0; t < 5; t += 0.1) expect(w.update(0.1, on)).toBeNull();
      for (let t = 0; t < 5; t += 0.1) expect(w.update(0.1, { ...on, off: hw + 2, wheelsOnGround: 2 })).toBeNull();
      // A jump over a crest, over the road: no fall.
      for (let t = 0; t < 3; t += 0.1) expect(w.update(0.1, { ...on, busY: 13, wheelsOnGround: 0 })).toBeNull();
    });

    it('fires once going over the edge (falling, or deep under the road), then once to respawn', () => {
      const w = new FallWatch();
      const events: string[] = [];
      for (let t = 0; t < FALL_AIR + FALL_SHOW + 1; t += 0.05) {
        const e = w.update(0.05, { ...on, off: hw + 4, busY: 8, wheelsOnGround: 0 });
        if (e) events.push(e);
      }
      expect(events).toEqual(['fell', 'respawn']);
      const deep = new FallWatch();
      expect(deep.update(0.05, { ...on, off: hw + 6, busY: 2, wheelsOnGround: 2 })).toBe('fell');
    });
  });

  describe('the track (physics)', () => {
    const graph = buildRoadGraph(city);
    let world: ReturnType<typeof createWorld>;
    beforeAll(async () => {
      await initRapier();
      world = createWorld();
      buildCity(city, world, new THREE.Scene(), graph);
    });

    it.each(['popular', 'articulado', 'gusanito', 'ae86'])('the AI drives a %s from start to finish on the asphalt', (id) => {
      const start = trackStartPose(race, 12);
      const bus = new BusPhysics(world, busById(id), { x: start.pos.x, y: start.y, z: start.pos.z, heading: start.heading, pitch: start.pitch });
      const driver = new RaceDriver(race, SKILLS.hard, vehicleLimits(busById(id)));
      const p = { x: 0, y: 0, z: 0 };
      let offFor = 0;
      let deepest = 0;
      let t = 0;
      for (; t < 600 && driver.s < race.finish; t += PHYSICS_STEP) {
        bus.update(driver.drive(bus, PHYSICS_STEP), PHYSICS_STEP);
        world.step();
        const here = locateOnTrack(race, bus.position(p), driver.s, 60);
        if (Math.abs(here.off) > hw + 0.5) offFor += PHYSICS_STEP;
        deepest = Math.max(deepest, here.y - bus.roadHeight());
      }
      for (const b of bus.bodies) world.removeRigidBody(b);
      expect(driver.s).toBeGreaterThanOrEqual(race.finish);
      expect(offFor).toBeLessThan(1);
      expect(deepest).toBeLessThan(0.5);
    });

    it('two AI buses race from the grid to the finish together without getting stuck on each other', () => {
      const ids = ['interparroquial', 'popular'];
      const slots = gridSlots(race, ids.map((id) => busById(id).body.length));
      const buses = slots.map((sl, k) => new BusPhysics(world, busById(ids[k]), { x: sl.pos.x, y: sl.y, z: sl.pos.z, heading: sl.heading, pitch: sl.pitch }));
      const drivers = slots.map((_, k) => new RaceDriver(race, SKILLS.hard, vehicleLimits(busById(ids[k])), (k % 2 ? 1 : -1) * 0.6));
      let t = 0;
      let rescues = 0;
      for (; t < 700 && drivers.some((d) => d.s < race.finish); t += PHYSICS_STEP) {
        buses.forEach((b, k) => b.update(drivers[k].drive(b, PHYSICS_STEP), PHYSICS_STEP));
        world.step();
        // As the race does: a bus wedged for good goes back on the road where it was.
        drivers.forEach((d, k) => {
          if (!d.needsRescue) return;
          const pose = trackPose(race, d.s, d.lane);
          buses[k].reset({ x: pose.pos.x, y: pose.y, z: pose.pos.z, heading: pose.heading, pitch: pose.pitch });
          d.rescued();
          rescues++;
        });
      }
      // Rarely needed.
      expect(rescues).toBeLessThanOrEqual(2);
      for (const b of buses) for (const body of b.bodies) world.removeRigidBody(body);
      for (const d of drivers) expect(d.s).toBeGreaterThanOrEqual(race.finish);
    });

    it('a bus driven straight off an open drop falls down the ravine', () => {
      const d = race.drops.find((x) => x.s1 - x.s0 > 20)!;
      const s = (d.s0 + d.s1) / 2;
      // From the far lane, at 40 km/h, 35° toward the drop (a bend missed).
      const pose = trackPose(race, s - 12, -d.side * 3);
      const heading = pose.heading - d.side * 0.6;
      const bus = new BusPhysics(world, busById('popular'), { x: pose.pos.x, y: pose.y, z: pose.pos.z, heading });
      bus.body.setLinvel({ x: Math.cos(heading) * 11, y: 0, z: -Math.sin(heading) * 11 }, true);
      const w = new FallWatch();
      const p = { x: 0, y: 0, z: 0 };
      let fell = false;
      for (let t = 0; t < 8 && !fell; t += PHYSICS_STEP) {
        bus.update({ throttle: 1, steer: 0, handbrake: false }, PHYSICS_STEP);
        world.step();
        const here = locateOnTrack(race, bus.position(p), s, 80);
        fell = w.update(PHYSICS_STEP, { roadY: here.y, busY: p.y, off: here.off, halfWidth: hw, wheelsOnGround: bus.wheelsOnGround }) === 'fell';
      }
      for (const b of bus.bodies) world.removeRigidBody(b);
      expect(fell).toBe(true);
    });

    it('a bus driven into a guardrail stays on the road', () => {
      const r = race.rails.find((x) => x.s1 - x.s0 > 40)!;
      const s = (r.s0 + r.s1) / 2;
      const pose = trackPose(race, s, r.side * 1.5);
      const bus = new BusPhysics(world, busById('popular'), { x: pose.pos.x, y: pose.y, z: pose.pos.z, heading: pose.heading - r.side * 0.5 });
      const p = { x: 0, y: 0, z: 0 };
      for (let t = 0; t < 4; t += PHYSICS_STEP) {
        bus.update({ throttle: 1, steer: 0, handbrake: false }, PHYSICS_STEP);
        world.step();
      }
      const here = locateOnTrack(race, bus.position(p), s, 80);
      for (const b of bus.bodies) world.removeRigidBody(b);
      expect(Math.abs(here.off)).toBeLessThan(hw + 1);
      expect(Math.abs(here.y - p.y)).toBeLessThan(3);
    });

    it('the R reset puts a bus on the road, level with it', () => {
      const q = trackPoint(race, 2000);
      const s = snapToRoad(city, { x: q.x - q.dz * 9, z: q.z + q.dx * 9 }, 0, q.y - 5);
      expect(Math.abs(locateOnTrack(race, s.pos).off)).toBeLessThan(hw);
      expect(Math.abs(s.y - q.y)).toBeLessThan(0.5);
    });
  });
});
