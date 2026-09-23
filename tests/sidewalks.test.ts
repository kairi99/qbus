import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRoadGraph } from '../src/world/roadGraph';
import { sidewalkSections, SIDEWALK_WIDTH } from '../src/world/sidewalks';
import { RoadIndex } from '../src/world/roadIndex';
import { pointInPolygon } from '../src/world/geom';
import type { CityData } from '../src/world/cityData';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const graph = buildRoadGraph(city);
const hulls = graph.nodes.filter((n) => n.hull).map((n) => n.hull!);
const roads = new RoadIndex(city.roads);
const sections = sidewalkSections(city, graph);

describe('sidewalkSections (La Mariscal)', () => {
  it('never covers asphalt or a paved junction', () => {
    let bad = 0;
    for (const strip of sections)
      for (const s of strip)
        for (const f of [0.35, 0.65, 0.95]) {
          const o = s.from + (s.to - s.from) * f;
          const p = { x: s.p.x - s.dir.z * o, z: s.p.z + s.dir.x * o };
          if (roads.onAsphalt(p, -0.05) || hulls.some((h) => pointInPolygon(p, h))) bad++;
        }
    expect(bad).toBe(0);
  });

  it('the strip between consecutive sections stays clear too', () => {
    let bad = 0;
    let total = 0;
    for (const strip of sections)
      for (let i = 0; i < strip.length - 1; i++) {
        const [a, b] = [strip[i], strip[i + 1]];
        for (const t of [0.25, 0.5, 0.75])
          for (const f of [0.35, 0.65, 0.95]) {
            // Interpolate the quad the renderer draws between the two sections.
            const lerp = (x: number, y: number) => x + (y - x) * t;
            const pa = { x: a.p.x - a.dir.z * (a.from + (a.to - a.from) * f), z: a.p.z + a.dir.x * (a.from + (a.to - a.from) * f) };
            const pb = { x: b.p.x - b.dir.z * (b.from + (b.to - b.from) * f), z: b.p.z + b.dir.x * (b.from + (b.to - b.from) * f) };
            const q = { x: lerp(pa.x, pb.x), z: lerp(pa.z, pb.z) };
            total++;
            if (roads.onAsphalt(q, -0.05) || hulls.some((h) => pointInPolygon(q, h))) bad++;
          }
      }
    // Between samples the strip can clip the very corner of a crossing curb; keep that rare.
    expect(bad / total).toBeLessThan(0.002);
  });

  it('still gives most roads a full-width sidewalk', () => {
    const all = sections.flat();
    const full = all.filter((s) => Math.abs(s.to - s.from) > SIDEWALK_WIDTH - 0.3).length;
    expect(all.length).toBeGreaterThan(10000);
    expect(full / all.length).toBeGreaterThan(0.6);
  });
});
