import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import type { CityData, Vec2 } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { inPlayArea } from '../src/world/cityData';
import { ALL_RED, AMBER, GREEN, RedLightRunner, TrafficLights, type Approach } from '../src/gameplay/trafficLights';

const grid = generateCity({ seed: 42 });
const gridGraph = buildRoadGraph(grid);
const gridLights = new TrafficLights(gridGraph, grid.signals ?? []);
const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const realGraph = buildRoadGraph(mariscal);
const realLights = new TrafficLights(realGraph, mariscal.signals ?? []);

describe('TrafficLights', () => {
  it('lights the generated city where its avenues cross other roads', () => {
    expect(gridLights.junctions).toHaveLength(13);
    for (const j of gridLights.junctions) {
      expect(j.phases).toBe(2);
      const names = new Set(j.approaches.map((a) => gridGraph.edges[a.edge].road));
      expect([...names].some((n) => n.startsWith('Av.'))).toBe(true);
    }
  });

  it('lights La Mariscal at its real signalized junctions', () => {
    const inPlay = realLights.junctions.filter((j) => inPlayArea(mariscal, j.pos));
    expect(inPlay.length).toBeGreaterThan(50);
    const roads = (j: (typeof inPlay)[number]) => j.approaches.map((a) => realGraph.edges[a.edge].road).join(' / ');
    expect(inPlay.some((j) => /Patria/.test(roads(j)) && /6 de Diciembre/.test(roads(j)))).toBe(true);
    expect(inPlay.some((j) => /Amazonas/.test(roads(j)) && /Colón/.test(roads(j)))).toBe(true);
  });

  it('gives opposite approaches the same phase, crossing ones another', () => {
    for (const j of gridLights.junctions) {
      for (const a of j.approaches)
        for (const b of j.approaches) {
          const cos = a.dir.x * b.dir.x + a.dir.z * b.dir.z;
          if (Math.abs(cos) > 0.9) expect(a.phase, 'parallel').toBe(b.phase);
          if (Math.abs(cos) < 0.3) expect(a.phase, 'crossing').not.toBe(b.phase);
        }
    }
  });

  it('cycles green, amber, red, with an all-red gap and never two phases moving at once', () => {
    for (const lights of [gridLights, realLights]) {
      for (const j of lights.junctions) {
        const first = new Map<number, Approach>();
        for (const a of j.approaches) if (!first.has(a.phase)) first.set(a.phase, a);
        let allRed = 0;
        const green = new Map<number, number>();
        const amber = new Map<number, number>();
        for (let t = 0; t < j.cycle; t += 0.25) {
          const states = [...first.values()].map((a) => lights.state(a.edge, t));
          expect(states.filter((s) => s !== 'red').length).toBeLessThanOrEqual(1);
          if (states.every((s) => s === 'red')) allRed += 0.25;
          states.forEach((s, k) => {
            if (s === 'green') green.set(k, (green.get(k) ?? 0) + 0.25);
            if (s === 'amber') amber.set(k, (amber.get(k) ?? 0) + 0.25);
          });
          // Deterministic: the same time, the same lights.
          expect(lights.state(j.approaches[0].edge, t + j.cycle)).toBe(lights.state(j.approaches[0].edge, t));
        }
        expect(allRed).toBeCloseTo(j.phases * ALL_RED, 0);
        for (let k = 0; k < j.phases; k++) {
          expect(green.get(k)).toBeCloseTo(j.green, 0);
          expect(amber.get(k)).toBeCloseTo(AMBER, 0);
        }
      }
    }
    expect(gridLights.junctions[0].cycle).toBe(2 * (GREEN + AMBER + ALL_RED));
  });

  it('runs the city out of sync, but close junctions in step', () => {
    const offsets = new Set(gridLights.junctions.map((j) => j.offset.toFixed(2)));
    expect(offsets.size).toBeGreaterThan(8);
    // A divided avenue's two crossings: the avenue gets green at both at once.
    let pairs = 0;
    for (const a of realLights.junctions)
      for (const b of realLights.junctions) {
        if (a === b || Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) > 40) continue;
        pairs++;
        for (let t = 0; t < 60; t += 1) {
          const greenA = a.approaches.filter((x) => realLights.state(x.edge, t) === 'green').map((x) => x.dir);
          const greenB = b.approaches.filter((x) => realLights.state(x.edge, t) === 'green').map((x) => x.dir);
          if (!greenA.length || !greenB.length || a.cycle !== b.cycle) continue;
          expect(Math.abs(greenA[0].x * greenB[0].x + greenA[0].z * greenB[0].z), 'same axis').toBeGreaterThan(0.6);
        }
      }
    expect(pairs).toBeGreaterThan(0);
  });

  it('knows nothing about edges without a light', () => {
    const plain = gridGraph.edges.find((e) => gridLights.approach(e.id) === null)!;
    expect(gridLights.state(plain.id, 3)).toBeNull();
  });
});

describe('RedLightRunner', () => {
  const j = gridLights.junctions[4];
  const a = j.approaches[0];
  const heading = Math.atan2(-a.dir.z, a.dir.x);
  const at = (d: number): Vec2 => ({ x: a.line.x + a.dir.x * d, z: a.line.z + a.dir.z * d });
  /** A time when `a` shows `want`. */
  const when = (want: string, from = 0) => {
    for (let t = from; t < from + 200; t += 0.1) if (gridLights.state(a.edge, t) === want) return t;
    throw new Error(want);
  };
  /** Drives the bus front from `d0` to `d1` meters past the line, starting at `t`. */
  const drive = (r: RedLightRunner, d0: number, d1: number, t: number, opts: { heading?: number; lift?: number } = {}) => {
    const hits: number[] = [];
    for (let d = d0, k = 0; d0 < d1 ? d <= d1 : d >= d1; d += d0 < d1 ? 0.3 : -0.3, k++) hits.push(...r.update(at(d), opts.heading ?? heading, opts.lift ?? 0, t + k * 0.02));
    return hits;
  };

  it('pays for crossing the stop line on red', () => {
    const t = when('red') + 0.2;
    expect(drive(new RedLightRunner(gridLights), -6, 3, t)).toEqual([gridLights.junctions.indexOf(j)]);
  });

  it('not on green or amber', () => {
    expect(drive(new RedLightRunner(gridLights), -6, 3, when('green'))).toEqual([]);
    expect(drive(new RedLightRunner(gridLights), -6, 3, when('amber'))).toEqual([]);
  });

  it('not when already past the line as it turned red, nor reversing over it', () => {
    const r = new RedLightRunner(gridLights);
    const t = when('red') + 0.2;
    expect(drive(r, 1, 6, t)).toEqual([]);
    expect(drive(new RedLightRunner(gridLights), 3, -6, t, { heading: heading })).toEqual([]);
  });

  it('not driving across it the other way, or on another level', () => {
    const t = when('red') + 0.2;
    expect(drive(new RedLightRunner(gridLights), -6, 3, t, { heading: heading + Math.PI / 2 })).toEqual([]);
    expect(drive(new RedLightRunner(gridLights), -6, 3, t, { lift: 6.5 })).toEqual([]);
  });

  it('once per junction and cycle: rocking over the line pays nothing more', () => {
    const r = new RedLightRunner(gridLights);
    const t = when('red') + 0.2;
    expect(drive(r, -6, 3, t)).toHaveLength(1);
    expect(drive(r, 3, -3, t + 1)).toHaveLength(0);
    expect(drive(r, -3, 3, t + 2)).toHaveLength(0);
    // Next cycle's red pays again.
    drive(r, 3, -6, t + 3);
    expect(drive(r, -6, 3, t + j.cycle)).toHaveLength(1);
  });

  it('ignores a jump (a reset onto the road)', () => {
    const r = new RedLightRunner(gridLights);
    const t = when('red') + 0.2;
    r.update(at(-30), heading, 0, t);
    expect(r.update(at(2), heading, 0, t + 0.02)).toEqual([]);
  });
});
