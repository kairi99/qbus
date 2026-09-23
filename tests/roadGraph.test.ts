import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import { buildRoadGraph, lanePoint } from '../src/world/roadGraph';
import { distToPolyline } from '../src/world/geom';
import { right, type CityData } from '../src/world/cityData';

const grid = generateCity({ seed: 42 });
const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));


describe('buildRoadGraph (generated grid)', () => {
  const g = buildRoadGraph(grid);

  it('has a junction at every crossing, corners only turn', () => {
    const ns = grid.roads.filter((r) => r.points[0].x === r.points[1].x).length;
    const ew = grid.roads.length - ns;
    expect(g.nodes.filter((n) => n.junction).length).toBe(ns * ew - 4);
    expect(g.nodes.filter((n) => n.corner).length).toBe(4);
  });

  it('pairs every two-way edge with its reverse', () => {
    for (const e of g.edges) {
      const r = g.edges[e.reverse];
      expect(r.from).toBe(e.to);
      expect(r.to).toBe(e.from);
      expect(r.reverse).toBe(e.id);
    }
  });

  it('starts each outgoing edge just past its node', () => {
    for (const n of g.nodes)
      for (const id of n.out) {
        const e = g.edges[id];
        const d = Math.hypot(e.a.x - n.pos.x, e.a.z - n.pos.z);
        expect(d).toBeGreaterThan(3);
        expect(d).toBeLessThan(14);
      }
  });

  it('gives avenues two lanes per direction and streets one', () => {
    const lanes = (name: string) => g.edges.find((e) => e.road === name)!.lanes;
    expect(lanes('Av. Amazonas')).toBe(2);
    expect(lanes('Foch')).toBe(1);
  });

  it('is drivable everywhere', () => {
    expect(g.edges.every((e) => e.drivable)).toBe(true);
  });
});

describe.each([
  ['grid', grid],
  ['La Mariscal', mariscal],
])('buildRoadGraph lanes (%s)', (_, city) => {
  const g = buildRoadGraph(city);

  it('keeps every lane on the right-hand side of its road, on the asphalt', () => {
    for (const e of g.edges) {
      for (let k = 0; k < e.lanes; k++) {
        for (const f of [0.1, 0.5, 0.9]) {
          const s = e.len * f;
          const p = lanePoint(e, s, k);
          // Node merging can shift piece ends by up to a meter; lanes must still be well inside the asphalt.
          const onAsphalt = city.roads.some((r) => distToPolyline(p, r.points) <= r.width / 2 - 0.5);
          expect(onAsphalt, `${e.road} lane ${k} at ${f}`).toBe(true);
          if (!e.oneway) {
            const c = lanePoint(e, s, 0, 0);
            const d = { x: p.x - c.x, z: p.z - c.z };
            const r = right(Math.atan2(-e.dir.z, e.dir.x));
            if (e.center.pts.length === 2) expect(d.x * r.x + d.z * r.z).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('never strands a car: every drivable edge leads on, or off the map', () => {
    for (const e of g.edges.filter((e) => e.drivable)) {
      const node = g.nodes[e.to];
      const exits = node.out.filter((id) => g.edges[id].drivable);
      expect(exits.length > 0 || node.out.length === 0, `${e.road} e${e.id}`).toBe(true);
    }
  });
});

describe('buildRoadGraph (La Mariscal)', () => {
  const g = buildRoadGraph(mariscal);

  it('respects one-way streets', () => {
    const oneway = g.edges.filter((e) => e.oneway);
    expect(oneway.length).toBeGreaterThan(300);
    for (const e of oneway) expect(e.reverse).toBe(-1);
  });

  it('keeps most of the network drivable and edges long enough to drive', () => {
    const drivable = g.edges.filter((e) => e.drivable);
    expect(drivable.length / g.edges.length).toBeGreaterThan(0.8);
    const short = drivable.filter((e) => e.len < 2).length;
    expect(short / drivable.length).toBeLessThan(0.02);
  });

  it('builds in reasonable time', () => {
    const t0 = performance.now();
    buildRoadGraph(mariscal);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
