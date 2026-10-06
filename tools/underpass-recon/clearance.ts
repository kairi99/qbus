/**
 * Static probes on the built La Mariscal physics world, around every lifted road:
 *  1. Headroom: from each lane (every lane, not just the curb lane) of every drivable edge near a
 *     lift, cast a ray straight up from the road surface; report the lowest ceiling (< 4.2 m).
 *  2. Forward obstacles at bus heights tests/lanesClear.test.ts doesn't look at (2.3, 2.9, 3.3 m)
 *     and in every lane (lanesClear only checks the curb lane at 0.6 and 1.5 m).
 *  3. Surface mismatch: the road surface the graph says (edgeY / ground) vs. the first solid
 *     surface a ray down from 3 m above finds (a floor below = a hole/step; above = a lip/buried).
 *  4. Joints: lifted roads meeting end to end, comparing profile heights at the shared point.
 * Usage: npx tsx tools/underpass-recon/clearance.ts
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, RAPIER } from '../../src/physics/world';
import { buildCity } from '../../src/world/cityBuilder';
import { type CityData, groundHeightAt, terrainAt } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph, dirAt, edgeLift, edgeY, lanePoint } from '../../src/world/roadGraph';
import { profileAt, roadProfiles } from '../../src/world/elevation';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const graph = buildRoadGraph(city);

async function main() {
  await initRapier();
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), graph);
  world.step();
  const shape = (c: RAPIER.Collider) => RAPIER.ShapeType[c.shapeType()];
  // Edges on or within 40 m of a lifted road.
  const liftedPts = graph.edges.filter((e) => e.lift && e.lift.some((l) => Math.abs(l) > 0.3)).flatMap((e) => e.center.pts);
  const near = (p: { x: number; z: number }) => liftedPts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 40);
  const edges = graph.edges.filter((e) => e.drivable && e.center.pts.some(near));
  console.log(`${edges.length} drivable edges near lifted roads`);

  const low: Map<string, { e: number; road: string; p: string; ceil: number; lane: number; shape: string; lift: number }> = new Map();
  const blocked: Map<string, string> = new Map();
  const surface: string[] = [];
  for (const e of edges) {
    for (let s = 1; s < e.len - 1; s += 1) {
      const d = dirAt(e.center, s);
      const lift = edgeLift(e, s);
      for (let k = 0; k < e.lanes; k++) {
        const p = lanePoint(e, s, k);
        const y = edgeY(e, s) ?? groundHeightAt(city, p);
        // 1. ceiling
        const up = world.castRay(new RAPIER.Ray({ x: p.x, y: y + 0.4, z: p.z }, { x: 0, y: 1, z: 0 }), 4, false);
        if (up) {
          const ceil = 0.4 + up.timeOfImpact;
          const key = `${e.id}:${k}:${Math.round(s / 6)}`;
          if (ceil < 4.2 && (!low.has(key) || low.get(key)!.ceil > ceil))
            low.set(key, { e: e.id, road: e.road, p: `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`, ceil: +ceil.toFixed(2), lane: k, shape: shape(up.collider), lift: +lift.toFixed(2) });
        }
        // 2. forward obstacles at bus body heights, in every lane
        for (const h of [0.3, 2.3, 2.9, 3.3]) {
          const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: p.x, y: y + h, z: p.z }, { x: d.x, y: 0, z: d.z }), 1.5, true);
          if (hit && hit.normal.y <= 0.6) {
            const key = `${e.id}:${k}:${h}:${Math.round(s / 8)}`;
            if (!blocked.has(key)) blocked.set(key, `edge ${e.id} ${e.road} lane ${k} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) y ${y.toFixed(2)} lift ${lift.toFixed(2)}: ${shape(hit.collider)} ${(hit.timeOfImpact).toFixed(2)} m ahead at ${h} m up, n=(${hit.normal.x.toFixed(2)},${hit.normal.y.toFixed(2)},${hit.normal.z.toFixed(2)})`);
          }
        }
        // 3. surface mismatch (only where lifted)
        if (Math.abs(lift) > 0.05 && k === 0) {
          const down = world.castRay(new RAPIER.Ray({ x: p.x, y: y + 2.2, z: p.z }, { x: 0, y: -1, z: 0 }), 6, true);
          const got = down ? y + 2.2 - down.timeOfImpact : -Infinity;
          if (Math.abs(got - y) > 0.12) surface.push(`edge ${e.id} ${e.road} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) s ${s.toFixed(0)} lift ${lift.toFixed(2)}: graph y ${y.toFixed(2)}, solid at ${got.toFixed(2)} (${(got - y).toFixed(2)}) ${down ? shape(down.collider) : 'NOTHING'} terrain ${terrainAt(city, p).toFixed(2)}`);
        }
      }
    }
  }
  console.log('\n== Lowest ceilings over lanes (< 4.2 m), worst per 6 m stretch ==');
  const lows = [...low.values()].sort((a, b) => a.ceil - b.ceil);
  for (const l of lows) console.log(`ceiling ${l.ceil} m  edge ${l.e} ${l.road} lane ${l.lane} ${l.p} lift ${l.lift} (${l.shape})`);
  console.log('\n== Solid things across lanes at bus heights ==');
  for (const b of blocked.values()) console.log(b);
  console.log('\n== Road surface vs graph height (>12 cm) ==');
  for (const s of surface) console.log(s);

  // 4. joints between lifted roads
  console.log('\n== Joints between roads at lifted ends ==');
  const profiles = roadProfiles(city);
  const ends: { ri: number; end: 0 | 1; p: { x: number; z: number }; y: number; lift: number }[] = [];
  city.roads.forEach((r, ri) => {
    const prof = profiles[ri];
    for (const end of [0, 1] as const) {
      const p = r.points[end ? r.points.length - 1 : 0];
      const at = prof ? profileAt(prof, end ? prof.cum[prof.cum.length - 1] : 0) : { y: terrainAt(city, p), lift: 0 };
      ends.push({ ri, end, p, y: at.y, lift: at.lift });
    }
  });
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i];
      const b = ends[j];
      if (a.ri === b.ri || Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z) > 1.5) continue;
      if (!profiles[a.ri] && !profiles[b.ri]) continue;
      const dy = a.y - b.y;
      console.log(`${Math.abs(dy) > 0.1 ? 'STEP ' : 'ok   '} #${a.ri} ${city.roads[a.ri].name}(${a.end ? 'end' : 'start'}, lift ${a.lift.toFixed(2)}, y ${a.y.toFixed(2)}) ~ #${b.ri} ${city.roads[b.ri].name}(${b.end ? 'end' : 'start'}, lift ${b.lift.toFixed(2)}, y ${b.y.toFixed(2)}) at (${a.p.x.toFixed(1)}, ${a.p.z.toFixed(1)}) dy ${dy.toFixed(2)}`);
    }
}
main();
