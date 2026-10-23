import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { RAPIER, createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { busById } from '../src/vehicle/buses';
import { buildCity } from '../src/world/cityBuilder';
import type { CityData } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { terrainHeight } from '../src/world/terrain';
import { biomeOf } from '../src/world/biomes';
import { BORE_HALF, BORE_TOP, BORE_WALL, MOUND_HALF, inTunnel, locateOnTrack, trackPoint, trackPose } from '../src/world/track';
import { HOOD, MOUND_BLEND, boreRing, boreWander, hoodVines, moundCrest, plateText, moundHeight, moundRise, tunnelRows } from '../src/world/tunnels';
import { HOOD_CLEAR, MOUND_PLANT_CLEAR, plantSpots } from '../src/world/trackBuilder';
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
      // Plants may stand on the mound (see below), never over the bore or at a portal's hood.
      expect(inTunnel(race, at.s, HOOD + 4) && Math.abs(at.off) < MOUND_PLANT_CLEAR).toBe(false);
      // And none in the portal zone (hood + headwall + hanging vines).
      for (const t of tunnels) if ((at.s > t.s0 - HOOD - 4 && at.s < t.s0 + 4) || (at.s > t.s1 - 4 && at.s < t.s1 + HOOD + 4)) expect(Math.abs(at.off)).toBeGreaterThanOrEqual(HOOD_CLEAR);
    }
    for (let seed = 1; seed <= 6; seed++) for (const site of slideSites(race, seed, ground)) expect(inTunnel(race, site.s, 90)).toBe(false);
    for (const m of mudPatches(race)) expect(inTunnel(race, m.s, 20)).toBe(false);
  });

  it('the mound blends into the slope: no step at its edge, no steeper than the hillside there, plants grow on it clear of the bore', () => {
    const cliff = biomeOf(race).cliff ?? { earth: 0.9, rock: 1.3 };
    let steepest = 0;
    let n = 0;
    for (const t of tunnels)
      for (let s = t.s0 + 3; s < t.s1; s += 6) {
        const q = trackPoint(race, s);
        const nn = { x: -q.dz, z: q.dx };
        for (const side of [-1, 1]) {
          const g = (a: number) => ground({ x: q.x + nn.x * a * side, z: q.z + nn.z * a * side });
          const crest = moundCrest(race, s, ground);
          const h = (a: number) => moundHeight(t, s, a, q.y, g(a), crest);
          // The edge: the mound is the ground (no step), and its slope there is the hillside's own (never steeper than it, or than the canyon's cliff).
          expect(Math.abs(h(MOUND_HALF) - g(MOUND_HALF))).toBeLessThan(0.5);
          const slope = Math.abs(h(MOUND_HALF - 2) - h(MOUND_HALF)) / 2;
          const hill = Math.abs(g(MOUND_HALF - 2) - g(MOUND_HALF)) / 2;
          expect(slope).toBeLessThan(Math.max(cliff.rock, hill + 0.15));
          // Starting to melt MOUND_BLEND m in, the mound has no step from one column to the next either.
          for (let a = MOUND_HALF - MOUND_BLEND; a < MOUND_HALF; a += 2) expect(Math.abs(h(a + 2) - h(a))).toBeLessThan(Math.abs(g(a + 2) - g(a)) + 1.2);
          // Not by construction: 2 m inside the edge the mound is still within its thin skin of the ground.
          expect(Math.abs(h(MOUND_HALF - 2) - g(MOUND_HALF - 2))).toBeLessThan(0.5);
          steepest = Math.max(steepest, slope);
          n++;
        }
      }
    expect(n).toBeGreaterThan(100);
    expect(steepest).toBeGreaterThan(0);
    // Plants do stand on the mound (not only beside it), at the mound's height, and none within MOUND_PLANT_CLEAR of a bore's centerline.
    let on = 0;
    for (const pl of plantSpots(race, city.terrain!, ground)) {
      const at = locateOnTrack(race, pl.p);
      for (const t of tunnels)
        if (at.s > t.s0 && at.s < t.s1) {
          if (Math.abs(at.off) < MOUND_HALF) {
            on++;
            expect(Math.abs(pl.y - moundHeight(t, at.s, at.off, at.y, ground(pl.p), moundCrest(race, at.s, ground)))).toBeLessThan(0.01);
          }
          expect(Math.abs(at.off)).toBeGreaterThanOrEqual(MOUND_PLANT_CLEAR);
        }
    }
    expect(on).toBeGreaterThan(20);
  });

  it('only a name that itself starts with Tunel/Túnel gets a plate', () => {
    expect(plateText('Tunel Cadanillas')).toBe('TÚNEL CADANILLAS');
    expect(plateText('túnel Chirosinguna')).toBe('TÚNEL CHIROSINGUNA');
    expect(plateText('Ruta de las Cascadas')).toBeNull();
    expect(plateText('Carretera Transversal Central')).toBeNull();
    expect(plateText(undefined)).toBeNull();
    expect(tunnels.map((t) => plateText(t.name) !== null)).toEqual([false, false, true, true]);
  });

  it('hanging plants never reach into the opening', () => {
    const vines = hoodVines(race);
    // Both portals of every tunnel carry some, hung from the hood's lip or the headwall's top.
    expect(vines.length).toBeGreaterThan(tunnels.length * 2 * 6);
    for (const v of vines) {
      expect(v.len).toBeGreaterThan(0.2);
      const lowest = v.top - v.len;
      expect(lowest >= v.deck + BORE_TOP + 0.3 || Math.abs(v.across) > BORE_HALF + 1).toBe(true);
    }
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

  it('the built bore wanders but never enters the swept space; its curbs are solid from above and behind', () => {
    const ring = boreRing(race.width / 2);
    const cast = (o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, max: number) => world.castRay(new RAPIER.Ray(o, d), max, true)?.timeOfImpact ?? Infinity;
    // Distance from (0, 1.5) along (cos a, sin a) to the plain ring's walls and arch (the invariant: the solid is never nearer).
    const ringDist = (a: number): number => {
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let best = Infinity;
      for (let j = 1; j < ring.length - 2; j++) {
        const [p, q] = [ring[j], ring[j + 1]];
        const ex = q.u - p.u;
        const ey = q.v - p.v;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const tt = ((p.u - 0) * ey - (p.v - 1.5) * ex) / den;
        const ss = ((p.u - 0) * dy - (p.v - 1.5) * dx) / den;
        if (tt > 0 && ss >= 0 && ss <= 1) best = Math.min(best, tt);
      }
      return best;
    };
    const half = race.width / 2;
    const spread: number[] = [];
    for (const t of tunnels)
      // Offset 0.7 m so no ray runs exactly along a row's triangle edge (a ray through an edge can slip between two triangles).
      for (let s = t.s0 - HOOD + 0.7; s <= t.s1 + HOOD - 0.7; s += 2) {
        const q = trackPoint(race, s);
        const n = { x: -q.dz, z: q.dx };
        const at = (u: number, v: number, du: number, dv: number, max: number) => cast({ x: q.x + n.x * u, y: q.y + v, z: q.z + n.z * u }, { x: n.x * du, y: dv, z: n.z * du }, max);
        for (let deg = 0; deg <= 180; deg += 15) {
          const a = (deg * Math.PI) / 180;
          const want = ringDist(a);
          const got = at(0, 1.5, Math.cos(a), Math.sin(a), 20);
          expect(got).toBeLessThan(Infinity);
          // A chord effect, not a lip: the hood's lining has no wander to spare: on a bend its chord between rows cuts a few cm inside the plain ring.
          expect(got).toBeGreaterThanOrEqual(want - (s < t.s0 || s > t.s1 ? 0.06 : 0.02));
          if (deg === 0) spread.push(got);
        }
        for (const side of [-1, 1]) {
          // Down onto the curb's top (0.2 m up): hit there, not on the floor under it.
          const top = at(side * (half + 0.35 + 0.4), 1, 0, -1, 3);
          expect(Math.abs(top - 0.8)).toBeLessThan(0.03);
          // From the pocket between curb and wall, toward the bore: the curb's back face stops it.
          const back = at(side * (half + 0.35 + 0.5 + 0.15), 0.1, -side, 0, 3);
          expect(back).toBeLessThan(0.3);
          // And along the road side, the chamfer face meets a ray from the asphalt.
          const front = at(side * (half + 0.1), 0.1, side, 0, 3);
          expect(front).toBeLessThan(0.6);
        }
      }
    expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(0.15);
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
