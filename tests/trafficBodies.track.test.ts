import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { PHYSICS_STEP, createWorld, initRapier } from '../src/physics/world';
import { buildCity } from '../src/world/cityBuilder';
import type { CityData } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { locateOnTrack, trackPose } from '../src/world/track';
import { TrafficSim } from '../src/gameplay/traffic';
import { TrafficBodies, laneSurface } from '../src/gameplay/trafficBodies';


/**
 * Track traffic rides the deck: no car's underside (front, middle, back) dips into the asphalt on grades,
 * crests or sags. Measured against the deck's own height (flat across), before the fix up to 1.6-2 m.
 */
describe.each(['papallacta', 'silante', 'rioverde'])('track traffic on %s', (zone) => {
  beforeAll(() => initRapier());
  it('cars never sink into the road', () => {
    const city: CityData = JSON.parse(readFileSync(`data/cities/${zone}.json`, 'utf8'));
    const race = city.race!;
    const world = createWorld();
    const graph = buildRoadGraph(city);
    buildCity(city, world, new THREE.Scene(), graph);
    const sim = new TrafficSim(graph, city, { seed: 11, count: 6, uturns: false });
    const bodies = new TrafficBodies(world, sim, laneSurface(city, graph, sim, world));
    const ahead = graph.edges.map((e) => Math.hypot(e.center.pts[0].x - race.points[0].x, e.center.pts[0].z - race.points[0].z) < 1);
    const total = race.cum[race.cum.length - 1];
    let worst = 0;
    let worstAt = '';
    let samples = 0;
    // The player drives the whole track at 20 m/s; traffic is recycled around it as in a race.
    let s = 0;
    for (let t = 0; s < total - 50; t += PHYSICS_STEP) {
      s = 20 * t;
      const p = trackPose(race, s);
      if (Math.round(t / PHYSICS_STEP) % 60 === 0) sim.recycle({ pos: p.pos, heading: p.heading }, t === 0);
      sim.step(PHYSICS_STEP, bodies.obstacles());
      bodies.steer(PHYSICS_STEP);
      world.step();
      bodies.afterStep(PHYSICS_STEP, [], { x: p.pos.x, z: p.pos.z });
      if (Math.round(t / PHYSICS_STEP) % 6) continue;
      sim.cars.forEach((c, i) => {
        if (c.state !== 'driving') return;
        const b = bodies.bodies[i];
        const tr = b.translation();
        const q = b.rotation();
        const hint = ahead[c.edge] ? c.s : graph.edges[c.edge].len - c.s;
        const h = c.kind.height / 2;
        const l = c.kind.length / 2;
        // Underside of the box at the front, middle and back (body axes -> world).
        for (const k of [-1, 0, 1]) {
          const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
          const fy = 2 * (q.x * q.y + q.w * q.z);
          const fz = 2 * (q.x * q.z - q.w * q.y);
          const ux = 2 * (q.x * q.y - q.w * q.z);
          const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
          const uz = 2 * (q.y * q.z + q.w * q.x);
          const x = tr.x + fx * l * k - ux * h;
          const y = tr.y + fy * l * k - uy * h;
          const z = tr.z + fz * l * k - uz * h;
          const loc = locateOnTrack(race, { x, z, y }, hint, 60);
          if (Math.abs(loc.off) > race.width / 2 - 0.3) continue;
          const pen = loc.y - y;
          samples++;
          if (pen > worst) (worst = pen), (worstAt = `car ${i} k=${k} t=${t.toFixed(1)} s=${s.toFixed(0)}`);
        }
      });
    }
    expect(samples).toBeGreaterThan(100);
    expect(worst, worstAt).toBeLessThan(0.1);
  }, 120000);
});
