/**
 * Cross-sections of the solid world across a graph edge: for each s, every 0.5 m from one side
 * of the road to the other (plus 3 m), the first solid surface a ray down from 8 m above the
 * road finds, and (from 0.2 m above the road surface at the centerline height) the first thing
 * above. Columns are offsets from the centerline (right positive), values are heights relative
 * to the graph's road height at the centerline.
 * Usage: npx tsx tools/underpass-recon/section.ts <edge> <s0> <s1> [step=3]
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, RAPIER } from '../../src/physics/world';
import { buildCity } from '../../src/world/cityBuilder';
import { type CityData, groundHeightAt, terrainAt } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph, dirAt, edgeLift, edgeY, pointAt } from '../../src/world/roadGraph';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;
const graph = buildRoadGraph(city);

async function main() {
  await initRapier();
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), graph);
  world.step();
  const [id, s0, s1, step = '3'] = process.argv.slice(2);
  const e = graph.edges[Number(id)];
  const half = e.roadWidth / 2;
  const short = (c: RAPIER.Collider) => ({ TriMesh: 'T', HeightField: 'H', ConvexPolyhedron: 'C', Cuboid: 'B', Cylinder: 'Y' })[RAPIER.ShapeType[c.shapeType()] as string] ?? '?';
  const offs: number[] = [];
  for (let o = -half - 3; o <= half + 3.001; o += 0.5) offs.push(+o.toFixed(2));
  console.log(`edge ${e.id} ${e.road} width ${e.roadWidth} (asphalt between ${-half} and ${half}); T=trimesh H=heightfield C=convex hull B=box`);
  console.log('s     lift   y    | ' + offs.map((o) => String(o).padStart(6)).join(''));
  for (let s = Number(s0); s <= Math.min(e.len, Number(s1)); s += Number(step)) {
    const c = pointAt(e.center, s);
    const d = dirAt(e.center, s);
    const y = edgeY(e, s) ?? groundHeightAt(city, c);
    const down: string[] = [];
    const up: string[] = [];
    const terr: string[] = [];
    for (const o of offs) {
      const p = { x: c.x - d.z * o, z: c.z + d.x * o };
      const hd = world.castRay(new RAPIER.Ray({ x: p.x, y: y + 8, z: p.z }, { x: 0, y: -1, z: 0 }), 30, true);
      down.push(hd ? `${(8 - hd.timeOfImpact).toFixed(2)}${short(hd.collider)}`.padStart(6) : '     -');
      const hu = world.castRay(new RAPIER.Ray({ x: p.x, y: y + 0.2, z: p.z }, { x: 0, y: 1, z: 0 }), 8, false);
      up.push(hu ? `${(0.2 + hu.timeOfImpact).toFixed(1)}${short(hu.collider)}`.padStart(6) : '     .');
      terr.push((terrainAt(city, p) - y).toFixed(2).padStart(6));
    }
    console.log(`${s.toFixed(0).padStart(4)} ${edgeLift(e, s).toFixed(2).padStart(6)} ${y.toFixed(2)} | down ${down.join('')}`);
    console.log(`                  | up   ${up.join('')}`);
    console.log(`                  | terr ${terr.join('')}`);
    console.log(`                  | at (${c.x.toFixed(1)}, ${c.z.toFixed(1)})`);
  }
}
main();
