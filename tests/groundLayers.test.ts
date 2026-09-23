import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier } from '../src/physics/world';
import { buildCity } from '../src/world/cityBuilder';
import type { CityData } from '../src/world/cityData';
import { DEFAULT_HILLS } from '../src/world/loadCity';
import { terrainHeight } from '../src/world/terrain';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;

/** Share of triangle sample points (corners, edge midpoints, centroid) not clearly above the ground. */
function buried(mesh: THREE.Mesh, margin: number): { bad: number; total: number; worst: number } {
  const p = mesh.geometry.getAttribute('position');
  let bad = 0;
  let total = 0;
  let worst = 0;
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let i = 0; i < p.count; i += 3) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(p, i + k);
    const pts = [v[0], v[1], v[2], v[0].clone().lerp(v[1], 0.5), v[1].clone().lerp(v[2], 0.5), v[2].clone().lerp(v[0], 0.5), v[0].clone().add(v[1]).add(v[2]).divideScalar(3)];
    for (const q of pts) {
      total++;
      const gap = q.y - terrainHeight(city.terrain!, q.x, q.z);
      if (gap < margin) {
        bad++;
        worst = Math.min(worst, gap);
      }
    }
  }
  return { bad, total, worst };
}

describe('ground layers (La Mariscal)', () => {
  let layers: Map<number, THREE.Mesh[]>;
  beforeAll(async () => {
    await initRapier();
    const scene = new THREE.Scene();
    buildCity(city, createWorld(), scene);
    layers = new Map();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      const mat = m.material as THREE.Material | undefined;
      if (m.isMesh && mat?.polygonOffset && mat.polygonOffsetFactor <= 3) layers.set(mat.polygonOffsetFactor, [...(layers.get(mat.polygonOffsetFactor) ?? []), m]);
    });
  });

  it.each([
    ['asphalt', 0],
    ['sidewalks', 3],
  ])('%s never sinks into the ground', (_, factor) => {
    const tiles = layers.get(factor as number)!;
    expect(tiles.length).toBeGreaterThan(20); // tiled, so the frustum can cull
    const r = tiles.map((m) => buried(m, 0.015)).reduce((a, b) => ({ bad: a.bad + b.bad, total: a.total + b.total, worst: Math.min(a.worst, b.worst) }));
    console.log(`${_}: ${r.bad}/${r.total} buried samples, worst ${r.worst.toFixed(3)} m`);
    expect(r.bad / r.total).toBeLessThan(0.001);
    expect(r.worst).toBeGreaterThan(-0.05);
  });
});
