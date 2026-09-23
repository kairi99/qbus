import { beforeAll, describe, expect, it } from 'vitest';
import { smoothHeights, terrainHeight, type Terrain } from '../src/world/terrain';
import { createWorld, initRapier, RAPIER } from '../src/physics/world';
import { addTerrainCollider } from '../src/physics/world';

const slope: Terrain = {
  minX: -10,
  minZ: 20,
  cell: 5,
  cols: 5,
  rows: 4,
  // Rises 1 m per column (5 m) along +x, 3 m per row along +z.
  heights: Array.from({ length: 20 }, (_, i) => (i % 5) + 3 * Math.floor(i / 5)),
  scale: 1,
};

describe('terrain', () => {
  beforeAll(() => initRapier());

  it('samples vertices exactly and interpolates between them', () => {
    expect(terrainHeight(slope, -10, 20)).toBeCloseTo(0);
    expect(terrainHeight(slope, 10, 35)).toBeCloseTo(4 + 9);
    expect(terrainHeight(slope, -7.5, 20)).toBeCloseTo(0.5);
    expect(terrainHeight(slope, -10, 22.5)).toBeCloseTo(1.5);
  });

  it('clamps outside the grid and applies the exaggeration scale', () => {
    expect(terrainHeight(slope, -100, 0)).toBeCloseTo(0);
    expect(terrainHeight({ ...slope, scale: 2 }, 10, 35)).toBeCloseTo(26, 1);
  });

  it('smoothing keeps a plane a plane and flattens a spike', () => {
    const flat = smoothHeights(new Array(100).fill(7), 10, 10, 2);
    for (const h of flat) expect(h).toBeCloseTo(7);
    const spike = new Array(100).fill(0);
    spike[55] = 100;
    expect(Math.max(...smoothHeights(spike, 10, 10, 2))).toBeLessThan(10);
  });

  it('matches the physics ground exactly on bumpy terrain, not just on a slope', () => {
    const world = createWorld();
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 6;
    const bumpy: Terrain = { minX: 3, minZ: -9, cell: 8, cols: 6, rows: 5, heights: Array.from({ length: 30 }, rand), scale: 1.3 };
    addTerrainCollider(world, bumpy);
    world.step();
    for (let i = 0; i < 60; i++) {
      const x = 3 + ((i * 7.31) % 40);
      const z = -9 + ((i * 3.77) % 32);
      const hit = world.castRay(new RAPIER.Ray({ x, y: 100, z }, { x: 0, y: -1, z: 0 }), 200, true)!;
      expect(100 - hit.timeOfImpact).toBeCloseTo(terrainHeight(bumpy, x, z), 3);
    }
  });

  it('the physics heightfield matches the sampled heights', () => {
    const world = createWorld();
    const t = { ...slope, scale: 1.5 };
    addTerrainCollider(world, t);
    world.step();
    for (const [x, z] of [
      [-10, 20],
      [-3.3, 27.1],
      [7.9, 34.2],
      [2, 22],
    ]) {
      const hit = world.castRay(new RAPIER.Ray({ x, y: 100, z }, { x: 0, y: -1, z: 0 }), 200, true);
      expect(hit, `${x},${z}`).not.toBeNull();
      expect(100 - hit!.timeOfImpact).toBeCloseTo(terrainHeight(t, x, z), 1);
    }
  });
});
