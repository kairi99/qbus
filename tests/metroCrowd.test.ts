import { describe, expect, it } from 'vitest';
import { MetroCrowd } from '../src/gameplay/metroCrowd';
import { metroStairs } from '../src/world/metro';
import type { MetroEntrance } from '../src/world/cityData';

const entrance: MetroEntrance = { name: 'El Ejido', pos: { x: 0, z: 0 }, heading: 0 };
const DT = 1 / 30;

describe('MetroCrowd', () => {
  it('people come up out of the stairs and others go down into them', () => {
    const crowd = new MetroCrowd([entrance], { seed: 1 });
    let cameUp = 0;
    let wentDown = 0;
    const wasUnder = new Map<number, boolean>();
    for (let t = 0; t < 120; t += DT) {
      crowd.update(DT, { x: 0, z: 0 }, () => true);
      crowd.peds.forEach((p, i) => {
        const under = p.hop < -2;
        if (wasUnder.get(i) === true && !under) cameUp++;
        if (wasUnder.get(i) === false && under) wentDown++;
        wasUnder.set(i, under);
      });
    }
    expect(cameUp).toBeGreaterThan(5);
    expect(wentDown).toBeGreaterThan(5);
  });

  it('only goes underground inside the canopy, at the stairs', () => {
    const crowd = new MetroCrowd([entrance], { seed: 2 });
    const { bottom, mouth } = metroStairs(entrance);
    for (let t = 0; t < 60; t += DT) {
      crowd.update(DT, { x: 0, z: 0 }, () => true);
      for (const p of crowd.peds) {
        if (p.hop >= -0.05) continue;
        // On the segment between the mouth and the bottom of the stairs.
        const along = (p.pos.x - bottom.x) / (mouth.x - bottom.x);
        expect(Math.abs(p.pos.z)).toBeLessThan(0.1);
        expect(along).toBeGreaterThan(-0.01);
        expect(along).toBeLessThan(1.01);
      }
    }
  });

  it("never pops anyone in or out while they're in view", () => {
    const crowd = new MetroCrowd([entrance], { seed: 3 });
    const prev = crowd.peds.map((p) => ({ ...p.pos }));
    for (let t = 0; t < 60; t += DT) {
      crowd.update(DT, { x: 0, z: 0 }, () => false);
      crowd.peds.forEach((p, i) => {
        // Walking only: nobody jumps more than a step, unless out of sight underground.
        const jump = Math.hypot(p.pos.x - prev[i].x, p.pos.z - prev[i].z);
        if (p.hop > -2) expect(jump).toBeLessThan(0.2);
        prev[i] = { ...p.pos };
      });
    }
  });

  it('stays still when the bus is far away', () => {
    const crowd = new MetroCrowd([entrance], { seed: 4 });
    const before = JSON.stringify(crowd.peds);
    for (let t = 0; t < 5; t += DT) crowd.update(DT, { x: 1000, z: 0 }, () => true);
    expect(JSON.stringify(crowd.peds)).toBe(before);
  });
});
