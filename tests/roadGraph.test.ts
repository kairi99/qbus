import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/world/procCity';
import { buildRoadGraph, laneOffset, lanePoint } from '../src/world/roadGraph';
import { distToPolyline } from '../src/world/geom';
import { right } from '../src/world/cityData';

const city = generateCity({ seed: 42 });
const g = buildRoadGraph(city);

describe('buildRoadGraph', () => {
  it('has a node at every crossing of the grid', () => {
    const ns = city.roads.filter((r) => r.points[0].x === r.points[1].x).length;
    const ew = city.roads.length - ns;
    const junctions = g.nodes.filter((n) => n.out.length >= 3).length;
    expect(junctions).toBe(ns * ew - 4); // the four outer corners only turn
  });

  it('pairs every directed edge with its reverse', () => {
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
        expect(e.from).toBe(n.id);
        const d = Math.hypot(e.a.x - n.pos.x, e.a.z - n.pos.z);
        expect(d).toBeGreaterThan(3);
        expect(d).toBeLessThan(14);
      }
  });

  it('puts every lane on the right-hand half of its road', () => {
    for (const e of g.edges) {
      const road = city.roads.find((r) => r.name === e.road)!;
      for (let k = 0; k < e.lanes; k++) {
        expect(laneOffset(e, k)).toBeGreaterThan(0);
        for (const s of [0, e.len / 2, e.len]) {
          const p = lanePoint(e, s, k);
          expect(distToPolyline(p, road.points)).toBeLessThanOrEqual(road.width / 2 - e.laneWidth / 2 + 1e-6);
          const c = { x: e.a.x + e.dir.x * s, z: e.a.z + e.dir.z * s };
          const r = right(Math.atan2(-e.dir.z, e.dir.x));
          expect((p.x - c.x) * r.x + (p.z - c.z) * r.z).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives avenues two lanes per direction and streets one', () => {
    const lanes = (name: string) => g.edges.find((e) => e.road === name)!.lanes;
    expect(lanes('Av. Amazonas')).toBe(2);
    expect(lanes('Foch')).toBe(1);
  });

  it('is strongly connected', () => {
    const start = g.nodes.find((n) => n.out.length)!.id;
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      for (const id of g.nodes[n].out) {
        const to = g.edges[id].to;
        if (!seen.has(to)) seen.add(to), stack.push(to);
      }
    }
    expect(seen.size).toBe(g.nodes.filter((n) => n.out.length).length);
  });
});
