/**
 * A ray from a point in a direction (all static hits along it, with collider kind and, for
 * trimeshes, the triangle hit). Usage: npx tsx tools/underpass-recon/hray.ts x y z dx dy dz [reach=12]
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, RAPIER } from '../../src/physics/world';
import { buildCity } from '../../src/world/cityBuilder';
import type { CityData } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph } from '../../src/world/roadGraph';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;

async function main() {
  await initRapier();
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), buildRoadGraph(city));
  world.step();
  const [x, y, z, dx, dy, dz, reach = 12] = process.argv.slice(2).map(Number);
  const n = Math.hypot(dx, dy, dz);
  const d = { x: dx / n, y: dy / n, z: dz / n };
  let t0 = 0;
  for (let k = 0; k < 8; k++) {
    const o = { x: x + d.x * t0, y: y + d.y * t0, z: z + d.z * t0 };
    const hit = world.castRayAndGetNormal(new RAPIER.Ray(o, d), reach - t0, false);
    if (!hit) break;
    const t = t0 + hit.timeOfImpact;
    const c = hit.collider;
    let tri = '';
    if (c.shapeType() === RAPIER.ShapeType.TriMesh && hit.featureType === RAPIER.FeatureType.Face) {
      const v = c.vertices();
      const ix = c.indices()!;
      const f = hit.featureId % (ix.length / 3);
      tri = [0, 1, 2].map((j) => `(${v[ix[f * 3 + j] * 3].toFixed(1)},${v[ix[f * 3 + j] * 3 + 1].toFixed(2)},${v[ix[f * 3 + j] * 3 + 2].toFixed(1)})`).join(' ');
    }
    console.log(`  t ${t.toFixed(2)} at (${(x + d.x * t).toFixed(1)}, ${(y + d.y * t).toFixed(2)}, ${(z + d.z * t).toFixed(1)}) ${RAPIER.ShapeType[c.shapeType()]} n(${hit.normal.x.toFixed(2)},${hit.normal.y.toFixed(2)},${hit.normal.z.toFixed(2)}) ${tri}`);
    t0 = t + 0.01;
  }
}
main();
