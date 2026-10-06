/**
 * What static colliders are at a point: shape type, and for convex hulls their vertex bounding
 * box (so a wall/embankment/railing can be told apart). Usage: npx tsx tools/underpass-recon/whatis.ts x y z [radius=0.3] ...
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
  const args = process.argv.slice(2).map(Number);
  for (let i = 0; i + 2 < args.length; i += 4) {
    const [x, y, z, r = 0.3] = args.slice(i, i + 4);
    console.log(`at (${x}, ${y}, ${z}) r ${r}:`);
    world.intersectionsWithShape({ x, y, z }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(r || 0.3), (c) => {
      const t = RAPIER.ShapeType[c.shapeType()];
      let box = '';
      if (t === 'ConvexPolyhedron') {
        const v = c.vertices();
        const xs: number[] = [], ys: number[] = [], zs: number[] = [];
        for (let k = 0; k < v.length; k += 3) xs.push(v[k]), ys.push(v[k + 1]), zs.push(v[k + 2]);
        box = `x ${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)} y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)} z ${Math.min(...zs).toFixed(1)}..${Math.max(...zs).toFixed(1)} (${v.length / 3} verts)`;
      }
      console.log(`  ${t} handle ${c.handle} ${box}`);
      return true;
    });
  }
}
main();
