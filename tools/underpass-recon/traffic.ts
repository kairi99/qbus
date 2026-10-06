/**
 * Traffic through every underpass/bridge complex (bus parked far away): cars released to free
 * physics without a bus (something knocked them off), cars recycled for being stuck, cars that
 * wait long, and how far each body is from the lane surface it should ride (floating/sinking),
 * plus whether a car on a lifted edge has its body inside a static collider (clipping walls).
 * Usage: npx tsx tools/underpass-recon/traffic.ts [seconds=90] [seeds=3]
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP, RAPIER, GROUP, groups } from '../../src/physics/world';
import { buildCity } from '../../src/world/cityBuilder';
import type { CityData } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph, edgeLift } from '../../src/world/roadGraph';
import { TrafficSim } from '../../src/gameplay/traffic';
import { TrafficBodies, laneSurface } from '../../src/gameplay/trafficBodies';
import { BusPhysics } from '../../src/vehicle/bus';
import type { BusPreset } from '../../src/vehicle/busPreset';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const popular = JSON.parse(readFileSync('data/buses/popular.json', 'utf8')) as BusPreset;
const SECONDS = Number(process.argv[2] ?? 90);
const SEEDS = Number(process.argv[3] ?? 3);
const SITES: [string, { x: number; z: number }][] = [
  ['Patria / 12 de Octubre', { x: -40, z: 735 }],
  ['Puente del Guambra + link under Patria', { x: -650, z: 300 }],
  ['West edge (El Ejido link, -835,779)', { x: -800, z: 790 }],
  ['10 de Agosto south tunnel', { x: -190, z: -830 }],
  ['Av. America link west edge', { x: -850, z: -280 }],
];

async function main() {
  await initRapier();
  const graph = buildRoadGraph(city);
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), graph);
  const surface = (sim: TrafficSim) => laneSurface(city, graph, sim);
  const f = (p: { x: number; z: number }) => `(${p.x.toFixed(0)}, ${p.z.toFixed(0)})`;
  for (const [name, focus] of SITES) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const bus = new BusPhysics(world, popular, { x: 2000, y: 200, z: 2000, heading: 0 });
      const sim = new TrafficSim(graph, city, { seed, count: 40 });
      sim.setBudget(40, focus);
      sim.recycle({ pos: focus, heading: 0 }, true);
      const ground = surface(sim);
      const bodies = new TrafficBodies(world, sim, ground);
      const prev = sim.cars.map((c) => c.state);
      const prevGen = sim.cars.map((c) => c.generation);
      const freed: string[] = [];
      const recycledStuck: string[] = [];
      let maxWait = { t: 0, where: '' };
      let maxOff = { d: 0, where: '' };
      const clip = new Map<string, number>();
      const usedLifted = new Set<number>();
      for (let t = 0; t < SECONDS; t += PHYSICS_STEP) {
        sim.step(PHYSICS_STEP, bodies.obstacles());
        bodies.steer(PHYSICS_STEP);
        world.step();
        bodies.afterStep(PHYSICS_STEP, bus.body.collider(0), { x: 2000, z: 2000 });
        const sample = Math.round(t * 60) % 6 === 0;
        sim.cars.forEach((c, i) => {
          if (c.state === 'free' && prev[i] === 'driving') {
            const b = bodies.bodies[i].translation();
            freed.push(`t ${t.toFixed(1)} car ${i} on ${graph.edges[c.edge].road} edge ${c.edge}${c.turn ? ' (turning at node ' + c.turn.node + ')' : ''} sim ${f(c.pos)} body ${f(b)} lift ${edgeLift(graph.edges[c.edge], c.s).toFixed(1)}`);
          }
          // Recycled while driving with a long wait: the stuck rule.
          if (c.generation !== prevGen[i] && prev[i] === 'driving' && c.state === 'driving') {
            /* respawned/recycled: can't tell why from here; counted by wait below */
          }
          if (c.state === 'driving' && c.wait > maxWait.t) maxWait = { t: c.wait, where: `${graph.edges[c.edge].road} edge ${c.edge} ${f(c.pos)}${c.turn ? ' turning' : ''}` };
          if (c.state === 'driving' && c.wait > 24 && c.wait - PHYSICS_STEP <= 24) recycledStuck.push(`t ${t.toFixed(1)} car ${i} ${graph.edges[c.edge].road} edge ${c.edge} ${f(c.pos)}`);
          prev[i] = c.state;
          prevGen[i] = c.generation;
          if (!sample || c.state !== 'driving') return;
          const e = graph.edges[c.edge];
          if (e.lift && e.lift.some((l) => Math.abs(l) > 1)) usedLifted.add(e.id);
          const b = bodies.bodies[i].translation();
          const want = ground(c.pos, i) + c.kind.height / 2 + 0.02;
          const off = b.y - want;
          if (Math.abs(off) > Math.abs(maxOff.d)) maxOff = { d: off, where: `${e.road} edge ${e.id} ${f(c.pos)}${c.turn ? ' turning node ' + c.turn.node : ''}` };
          // Body inside a static collider (it ignores STATIC, so this is a visual clip through a wall/floor).
          const col = bodies.bodies[i].collider(0);
          const shape = col.shape;
          let hit = '';
          world.intersectionsWithShape(b, bodies.bodies[i].rotation(), shape, (o) => {
            const ob = o.parent();
            if (ob && !ob.isFixed()) return true;
            const tp = RAPIER.ShapeType[o.shapeType()];
            if (tp === 'HeightField') return true; // touching ground is normal
            hit = tp;
            return false;
          }, undefined, groups(GROUP.TRAFFIC, GROUP.STATIC));
          if (hit) {
            // Why: the solid surface under the car vs. the body's bottom (sunk), and walls beside it.
            const bottom = b.y - c.kind.height / 2;
            const down = world.castRay(new RAPIER.Ray({ x: b.x, y: b.y + 3, z: b.z }, { x: 0, y: -1, z: 0 }), 10, true, undefined, groups(GROUP.TRAFFIC, GROUP.STATIC));
            const floor = down ? b.y + 3 - down.timeOfImpact : -Infinity;
            const fwd = { x: Math.cos(c.heading), z: -Math.sin(c.heading) };
            let side = Infinity;
            for (const sgn of [-1, 1]) {
              const r = world.castRay(new RAPIER.Ray({ x: b.x, y: b.y, z: b.z }, { x: -fwd.z * sgn, y: 0, z: fwd.x * sgn }), 3, true, undefined, groups(GROUP.TRAFFIC, GROUP.STATIC));
              if (r) side = Math.min(side, r.timeOfImpact - c.kind.width / 2);
            }
            const why = floor - bottom > 0.15 ? `sunk ${(floor - bottom).toFixed(2)} m into the floor` : side < 0 ? `wall ${(-side).toFixed(2)} m into its side` : 'corner/other';
            const key = `${e.road} edge ${e.id} near ${f({ x: Math.round(c.pos.x / 5) * 5, z: Math.round(c.pos.z / 5) * 5 })} ${hit}${c.turn ? ' turning' : ''}: ${why.replace(/[0-9.]+ m/, (m) => (Math.round(parseFloat(m) * 4) / 4).toFixed(2) + ' m')}`;
            clip.set(key, (clip.get(key) ?? 0) + 1);
          }
        });
      }
      console.log(`\n== ${name}, seed ${seed}: ${freed.length} cars knocked loose with no bus around; lifted edges used: ${[...usedLifted].join(',')}`);
      for (const x of freed.slice(0, 8)) console.log('  freed ' + x);
      for (const x of recycledStuck.slice(0, 8)) console.log('  stuck>24s ' + x);
      console.log(`  longest wait ${maxWait.t.toFixed(1)} s at ${maxWait.where}`);
      console.log(`  worst body height vs lane surface ${maxOff.d.toFixed(2)} m at ${maxOff.where}`);
      const clips = [...clip.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [k, n] of clips) console.log(`  clips into static (${n} samples): ${k}`);
      // Clean up for the next run.
      bodies.bodies.forEach((b) => world.removeRigidBody(b));
      world.removeRigidBody(bus.body);
    }
  }
}
main();
