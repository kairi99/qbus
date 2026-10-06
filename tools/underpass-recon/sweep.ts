/**
 * Box-slice sweep: at every 0.5 m of every lane of every drivable edge near a lifted road, and on
 * a 1 m grid inside every junction hull near one, test a bus-wide box (2.6 m wide, 1 m long along
 * the lane) for solid static colliders in two height slices above the road surface:
 *   low  = 0.35..1.3 m (walls, parapets, lips a bus can't ride over)
 *   roof = 2.0..3.6 m (ceilings, lintels: the interparroquial's roof is ~3.45 m up)
 * Thin features (0.12 m lintels) that single rays miss are caught by the box.
 * Usage: npx tsx tools/underpass-recon/sweep.ts
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, RAPIER } from '../../src/physics/world';
import { buildCity } from '../../src/world/cityBuilder';
import { type CityData, groundHeightAt, type Vec2 } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph, dirAt, edgeLift, edgeY, lanePoint } from '../../src/world/roadGraph';
import { pointInPolygon } from '../../src/world/geom';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const graph = buildRoadGraph(city);

async function main() {
  await initRapier();
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), graph);
  world.step();
  const shapeName = (c: RAPIER.Collider) => RAPIER.ShapeType[c.shapeType()];
  const liftedPts = graph.edges.filter((e) => e.lift && e.lift.some((l) => Math.abs(l) > 0.3)).flatMap((e) => e.center.pts);
  const near = (p: Vec2) => liftedPts.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 40);
  const hits = new Map<string, string>();
  const slices = [
    ['low', 0.35, 1.3],
    ['roof', 2.0, 3.6],
  ] as const;
  const probe = (tag: string, p: Vec2, d: Vec2, y: number, width = 2.6) => {
    const heading = Math.atan2(-d.z, d.x);
    const rot = { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
    for (const [name, lo, hi] of slices) {
      const shape = new RAPIER.Cuboid(0.5, (hi - lo) / 2, width / 2);
      const found: string[] = [];
      world.intersectionsWithShape({ x: p.x, y: y + (lo + hi) / 2, z: p.z }, rot, shape, (c) => {
        const body = c.parent();
        if (body && !body.isFixed()) return true;
        found.push(shapeName(c));
        return true;
      });
      if (!found.length) continue;
      // For the roof slice, how low the lowest thing actually is: cast a ray up at the box center.
      let ceil = '';
      if (name === 'roof') {
        let best = Infinity;
        for (const o of [-1.2, -0.6, 0, 0.6, 1.2]) {
          const q = { x: p.x - d.z * o, z: p.z + d.x * o };
          for (const a of [-0.5, 0, 0.5]) {
            const r = world.castRay(new RAPIER.Ray({ x: q.x + d.x * a, y: y + 0.4, z: q.z + d.z * a }, { x: 0, y: 1, z: 0 }), 4, false);
            if (r) best = Math.min(best, 0.4 + r.timeOfImpact);
          }
        }
        ceil = ` lowest ceiling ${best === Infinity ? '?' : best.toFixed(2)} m`;
      }
      const key = `${name}:${tag.split(' ')[0]}:${Math.round(p.x / 3)},${Math.round(p.z / 3)}`;
      if (!hits.has(key)) hits.set(key, `${name.padEnd(4)} ${tag} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) road y ${y.toFixed(2)}: ${[...new Set(found)].join('+')}${ceil}`);
    }
  };
  for (const e of graph.edges) {
    if (!e.drivable || !e.center.pts.some(near)) continue;
    for (let s = 1; s < e.len - 1; s += 0.5) {
      const d = dirAt(e.center, s);
      for (let k = 0; k < e.lanes; k++) {
        const p = lanePoint(e, s, k);
        const y = edgeY(e, s) ?? groundHeightAt(city, p);
        probe(`edge ${e.id} "${e.road}" lane ${k}/${e.lanes} lift ${edgeLift(e, s).toFixed(2)}`, p, d, y, 2.5);
      }
    }
  }
  for (const n of graph.nodes) {
    if (!n.hull || !near(n.pos)) continue;
    if (![...n.in, ...n.out].some((id) => graph.edges[id].drivable)) continue;
    const xs = n.hull.map((q) => q.x);
    const zs = n.hull.map((q) => q.z);
    for (let x = Math.min(...xs) + 0.5; x < Math.max(...xs); x += 1)
      for (let z = Math.min(...zs) + 0.5; z < Math.max(...zs); z += 1) {
        const p = { x, z };
        if (!pointInPolygon(p, n.hull)) continue;
        // Shrink: only well inside the hull (a bus-width box at its rim pokes past it).
        const inside = [0, 1, 2, 3].every((k) => pointInPolygon({ x: x + Math.cos((k * Math.PI) / 2) * 1.3, z: z + Math.sin((k * Math.PI) / 2) * 1.3 }, n.hull!));
        if (!inside) continue;
        const y = n.y ?? groundHeightAt(city, p);
        probe(`node ${n.id} lift ${n.lift.toFixed(2)}`, p, { x: 1, z: 0 }, y, 1);
      }
  }
  for (const h of [...hits.values()].sort()) console.log(h);
}
main();
