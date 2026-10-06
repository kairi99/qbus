/**
 * Every static surface straight down from a point (all hits, top to bottom), with the collider
 * kind and, for trimeshes, the triangle hit. Usage: npx tsx tools/underpass-recon/ray.ts x z ...
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, RAPIER } from '../../src/physics/world';
import { buildCity } from '../../src/world/cityBuilder';
import { type CityData, terrainAt } from '../../src/world/cityData';
import { DEFAULT_HILLS } from '../../src/world/loadCity';
import { buildRoadGraph } from '../../src/world/roadGraph';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;

async function main() {
  await initRapier();
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), buildRoadGraph(city));
  world.step();
  const args = process.argv.slice(2).map(Number);
  for (let i = 0; i + 1 < args.length; i += 2) {
    const [x, z] = [args[i], args[i + 1]];
    console.log(`at (${x}, ${z}) terrain ${terrainAt(city, { x, z }).toFixed(2)}:`);
    let top = 80;
    for (let k = 0; k < 8; k++) {
      const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 }), 200, false);
      if (!hit) break;
      const y = top - hit.timeOfImpact;
      const c = hit.collider;
      let tri = '';
      if (c.shapeType() === RAPIER.ShapeType.TriMesh && hit.featureType === RAPIER.FeatureType.Face) {
        const v = c.vertices();
        const ix = c.indices()!;
        // (Back faces come back as id + triangle count.)
        const f = hit.featureId % (ix.length / 3);
        tri = [0, 1, 2]
          .map((j) => {
            const q = ix[f * 3 + j] * 3;
            return `(${v[q].toFixed(1)},${v[q + 1].toFixed(2)},${v[q + 2].toFixed(1)})`;
          })
          .join(' ');
      }
      console.log(`  y ${y.toFixed(2)} ${RAPIER.ShapeType[c.shapeType()]} h${c.handle} n(${hit.normal.x.toFixed(2)},${hit.normal.y.toFixed(2)},${hit.normal.z.toFixed(2)}) ${tri}`);
      top = y - 0.01;
    }
  }
}
main();
