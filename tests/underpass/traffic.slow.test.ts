/**
 * Traffic through every underpass and bridge: the real TrafficSim + TrafficBodies (Rapier) run
 * around each structure with the bus parked far away. Cars must pass through each passage, never
 * sit stuck in it, ride at the road's height, and not overlap. See README.md.
 */
import { beforeAll, describe, expect } from 'vitest';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { TrafficSim } from '../../src/gameplay/traffic';
import { TrafficLights } from '../../src/gameplay/trafficLights';
import { TrafficBodies, laneSurface } from '../../src/gameplay/trafficBodies';
import { PHYSICS_STEP } from '../../src/physics/world';
import { BusPhysics } from '../../src/vehicle/bus';
import { busById } from '../../src/vehicle/buses';
import type { Structure } from './catalog';
import { check, known } from './known';
import { fmt, surfaceBelow } from './probe';
import { type Built, buildAll, cityAndCatalog } from './setup';
import { TRAFFIC } from './thresholds';

// Observed on the harness's first run (2026-10-06, La Mariscal at DEFAULT_HILLS): the test's own
// first findings. Delete an entry once its bug is fixed (the it.fails turns red to tell you).
// Same bug as G2 in drive.slow.test.ts: Av. Patria eastbound's down-ramp deck (#358) is overlapped
// 0.2–0.35 m higher by the westbound up-ramp (#401) just before their joint with the Puente del
// Guambra, so a car on #358 there is under #401's slab. Seen once the traffic's dice changed
// (Av. América's northbound carriageway became drivable, 2026-10-08).
known({
  "traffic rides at the road's height in bridge Av. Patria @(-658,290)":
    'seed 2 car on e517 (Av. Patria #358) at (-631.8, 322.1) sunk 0.35 m: under the overlapping westbound up-ramp deck (#401) at the joint with the Puente del Guambra',
});

const LIST = 8;
const base = cityAndCatalog();
let built: Built;
let bus: BusPhysics;
beforeAll(async () => {
  built = await buildAll(base);
  // Parked far away: nothing but the road itself can knock a car off its lane.
  bus = new BusPhysics(built.world, busById('popular'), { x: 2000, y: 200, z: 2000, heading: 0 });
}, 120_000);

interface Run {
  /** Cars that drove off the end of each passage's deepest/highest edge. */
  through: Map<string, number>;
  stuck: string[];
  heights: string[];
  overlaps: string[];
  released: string[];
}

const runs = new Map<string, Run>();

function run(s: Structure): Run {
  const hit = runs.get(s.id);
  if (hit) return hit;
  const { world, city, graph } = built;
  const onStructure = new Set(s.edges);
  const r: Run = { through: new Map(s.passages.map((p) => [p.id, 0])), stuck: [], heights: [], overlaps: [], released: [] };
  for (const seed of TRAFFIC.SEEDS) {
    const sim = new TrafficSim(graph, city, { seed, count: TRAFFIC.CARS, lights: new TrafficLights(graph, city.signals ?? []) });
    sim.setBudget(TRAFFIC.CARS, s.center);
    sim.recycle({ pos: s.center, heading: 0 }, true);
    const bodies = new TrafficBodies(world, sim, laneSurface(city, graph, sim, world));
    const prevEdge = sim.cars.map((c) => c.edge);
    const prevState = sim.cars.map((c) => c.state);
    const slow = sim.cars.map(() => 0);
    const exited = new Set<number>();
    let sample = 0;
    try {
      for (let t = 0; t < TRAFFIC.SECONDS; t += PHYSICS_STEP) {
        sim.step(PHYSICS_STEP, bodies.obstacles());
        bodies.steer(PHYSICS_STEP);
        world.step();
        bodies.afterStep(PHYSICS_STEP, bus.body.collider(0), { x: 2000, z: 2000 });
        // Keep the traffic around the structure (as if the bus were parked there).
        sim.recycle({ pos: s.center, heading: 0 });
        sim.cars.forEach((c, i) => {
          if (c.state === 'free' && prevState[i] === 'driving') r.released.push(`seed ${seed} car ${i} at ${fmt(c.pos)} t ${t.toFixed(1)} s`);
          if (c.state === 'driving' && prevState[i] === 'driving' && c.edge !== prevEdge[i])
            for (const p of s.passages) if (prevEdge[i] === p.extreme.edge) r.through.set(p.id, r.through.get(p.id)! + 1);
          // A passage that leads off the map ends at the exit line, where cars wait out of the
          // player's sight (below): getting there is getting through.
          if (c.state === 'driving' && c.next < 0 && c.s > graph.edges[c.edge].len - 0.5 && !exited.has(i))
            for (const p of s.passages)
              if (c.edge === p.extreme.edge) {
                exited.add(i);
                r.through.set(p.id, r.through.get(p.id)! + 1);
              }
          // A car leaving the map waits at the line until the player can't see it, by design: with
          // the "player" parked at the structure that can take a while, so exits don't count.
          const inside = c.state === 'driving' && !c.turn && c.next >= 0 && onStructure.has(c.edge);
          // Waiting for a light is not being stuck.
          slow[i] = inside && !c.held && c.speed < 0.3 ? slow[i] + PHYSICS_STEP : 0;
          if (slow[i] > TRAFFIC.STUCK_S && slow[i] - PHYSICS_STEP <= TRAFFIC.STUCK_S) r.stuck.push(`seed ${seed} car ${i} on e${c.edge} at ${fmt(c.pos)} t ${t.toFixed(1)} s`);
          prevEdge[i] = c.edge;
          prevState[i] = c.state;
        });
        if ((sample += PHYSICS_STEP) >= 0.5) {
          sample = 0;
          checkHeights(world, sim, bodies, onStructure, seed, t, r);
          checkOverlaps(sim, bodies, onStructure, seed, t, r);
        }
      }
    } finally {
      for (const b of bodies.bodies) world.removeRigidBody(b);
    }
  }
  runs.set(s.id, r);
  return r;
}

function checkHeights(world: RAPIER_T.World, sim: TrafficSim, bodies: TrafficBodies, on: Set<number>, seed: number, t: number, r: Run): void {
  sim.cars.forEach((c, i) => {
    if (c.state !== 'driving' || c.turn || !on.has(c.edge)) return;
    const p = bodies.bodies[i].translation();
    const bottom = p.y - c.kind.height / 2;
    const road = surfaceBelow(world, p, p.y, 4);
    const gap = road === null ? Infinity : bottom - road;
    if (Math.abs(gap) > TRAFFIC.HEIGHT_TOL)
      r.heights.push(`seed ${seed} car ${i} on e${c.edge} at ${fmt({ x: p.x, z: p.z, y: bottom })} t ${t.toFixed(1)} s: ${road === null ? 'no road under it' : `${gap > 0 ? 'floating' : 'sunk'} ${Math.abs(gap).toFixed(2)} m`}`);
  });
}

/** Oriented-box overlap on the ground plane (separating axes), shrunk a little so touching isn't overlapping. */
function overlap(a: { x: number; z: number; h: number; l: number; w: number }, b: typeof a): boolean {
  for (const h of [a.h, a.h + Math.PI / 2, b.h, b.h + Math.PI / 2]) {
    const ax = { x: Math.cos(h), z: -Math.sin(h) };
    const proj = (o: typeof a) => {
      const c = o.x * ax.x + o.z * ax.z;
      const f = { x: Math.cos(o.h), z: -Math.sin(o.h) };
      const ext = (Math.abs(f.x * ax.x + f.z * ax.z) * o.l) / 2 + (Math.abs(-f.z * ax.x + f.x * ax.z) * o.w) / 2 - 0.1;
      return [c - ext, c + ext];
    };
    const [a0, a1] = proj(a);
    const [b0, b1] = proj(b);
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

function checkOverlaps(sim: TrafficSim, bodies: TrafficBodies, on: Set<number>, seed: number, t: number, r: Run): void {
  const cars = sim.cars.filter((c) => c.state === 'driving');
  for (let a = 0; a < cars.length; a++)
    for (let b = a + 1; b < cars.length; b++) {
      const [ca, cb] = [cars[a], cars[b]];
      if (!on.has(ca.edge) && !on.has(cb.edge)) continue;
      if (ca.next < 0 && cb.next < 0) continue; // queued at a map exit (see stuck above)
      const [pa, pb] = [bodies.bodies[ca.id].translation(), bodies.bodies[cb.id].translation()];
      if (Math.abs(pa.y - pb.y) > 2 || Math.hypot(pa.x - pb.x, pa.z - pb.z) > 12) continue; // other level, or far
      const box = (c: typeof ca) => ({ x: c.pos.x, z: c.pos.z, h: c.heading, l: c.kind.length, w: c.kind.width });
      if (overlap(box(ca), box(cb))) r.overlaps.push(`seed ${seed} cars ${ca.id} (e${ca.edge}) and ${cb.id} (e${cb.edge}) at ${fmt(ca.pos)} t ${t.toFixed(1)} s`);
    }
}

const report = (found: string[]) => `${found.length} found:\n${found.slice(0, LIST).join('\n')}${found.length > LIST ? '\n...' : ''}`;

for (const s of base.structures.filter((x) => x.passages.length))
  describe(s.id, () => {
    for (const p of s.passages)
      check(`traffic drives through ${p.id}`, () => {
        const n = run(s).through.get(p.id)!;
        expect(n, `cars through e${p.extreme.edge} in ${TRAFFIC.SEEDS.length} × ${TRAFFIC.SECONDS} s`).toBeGreaterThan(0);
      });
    check(`no car stuck in ${s.id}`, () => expect(run(s).stuck, report(run(s).stuck)).toEqual([]));
    check(`traffic rides at the road's height in ${s.id}`, () => expect(run(s).heights, report(run(s).heights)).toEqual([]));
    check(`no cars overlap in ${s.id}`, () => expect(run(s).overlaps.length, report(run(s).overlaps)).toBeLessThanOrEqual(TRAFFIC.OVERLAPS_MAX));
    check(`the road knocks no car off its lane in ${s.id}`, () => expect(run(s).released.length, report(run(s).released)).toBeLessThanOrEqual(TRAFFIC.RELEASED_MAX));
  });
