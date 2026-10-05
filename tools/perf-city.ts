/**
 * Startup profile of a city build in Node (no WebGL): parse, road graph, buildCity, routes,
 * then what the scene holds (meshes, triangles, shadow casters) and how many meshes a camera
 * at the spawn, looking down the street, would draw (frustum test as three.js does it).
 * Usage: npx tsx tools/perf-city.ts [zone] [runs]
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier } from '../src/physics/world';
import { buildCity } from '../src/world/cityBuilder';
import { buildRoadGraph } from '../src/world/roadGraph';
import { groundHeightAt, type CityData } from '../src/world/cityData';
import { routesFor } from '../src/gameplay/routes';

const zone = process.argv[2] ?? 'mariscal';
const runs = Number(process.argv[3] ?? 3);

await initRapier();
const raw = readFileSync(`data/cities/${zone}.json`, 'utf8');
const ms = (t: number) => Math.round(performance.now() - t);

for (let run = 0; run < runs; run++) {
  let t = performance.now();
  const city: CityData = JSON.parse(raw);
  const parse = ms(t);
  t = performance.now();
  const graph = buildRoadGraph(city);
  const graphMs = ms(t);
  t = performance.now();
  const world = createWorld();
  const scene = new THREE.Scene();
  buildCity(city, world, scene, graph);
  const build = ms(t);
  t = performance.now();
  routesFor(city);
  const routes = ms(t);
  console.log(`run ${run}: parse ${parse} ms, graph ${graphMs} ms, buildCity ${build} ms, routesFor ${routes} ms, colliders ${world.colliders.len()}`);
  if (run < runs - 1) continue;

  // A street-level camera at the spawn (the game's: 68° fov, 0.3-3000 m, 16:9).
  const { pos, heading } = city.spawn;
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.3, 3000);
  const y = groundHeightAt(city, pos);
  camera.position.set(pos.x - Math.cos(heading) * 14, y + 5, pos.z + Math.sin(heading) * 14);
  camera.lookAt(pos.x + Math.cos(heading) * 40, y + 1, pos.z - Math.sin(heading) * 40);
  camera.updateMatrixWorld();
  scene.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

  // What the scene holds, grouped by material kind / mesh role.
  const groups = new Map<string, { meshes: number; tris: number; inView: number }>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    const n = g.drawRange.count !== Infinity ? g.drawRange.count : g.index ? g.index.count : g.getAttribute('position').count;
    const mat = m.material as THREE.Material & { polygonOffsetFactor?: number };
    const key = `${o.type}:${mat.type}${mat.polygonOffset ? `@${mat.polygonOffsetFactor}` : ''}${m.castShadow ? ':cast' : ''}${mat.visible ? '' : ':hidden'}`;
    const e = groups.get(key) ?? { meshes: 0, tris: 0, inView: 0 };
    e.meshes++;
    e.tris += (n / 3) * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
    if (mat.visible && (!m.frustumCulled || m.intersectsFrustum(frustum))) e.inView++;
    groups.set(key, e);
  });
  let calls = 0;
  for (const [k, v] of [...groups].sort((a, b) => b[1].tris - a[1].tris)) {
    calls += v.inView;
    console.log(`${k.padEnd(48)} meshes ${String(v.meshes).padStart(5)}  in view ${String(v.inView).padStart(5)}  tris ${Math.round(v.tris)}`);
  }
  console.log(`street view at the spawn: ${calls} meshes in the frustum`);
}
