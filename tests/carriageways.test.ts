import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CityData, Road, Vec2 } from '../src/world/cityData';
import { sameWayStretches } from '../src/world/osm/carriageways';
import { buildRoadGraph, type LaneEdge } from '../src/world/roadGraph';
import { Navigator } from '../src/gameplay/navigation';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const pa = city.playArea!;
const inPlay = (p: Vec2) => p.x >= pa.min.x && p.x <= pa.max.x && p.z >= pa.min.z && p.z <= pa.max.z;

const road = (name: string, ...pts: [number, number][]): Road => ({ name, kind: 'avenue', points: pts.map(([x, z]) => ({ x, z })), width: 7, lanes: 2, oneway: true });

describe('sameWayStretches', () => {
  it('passes a divided avenue whose carriageways run opposite ways', () => {
    expect(sameWayStretches([road('Av. X', [0, 0], [0, -300]), road('Av. X', [-15, -300], [-15, 0])])).toEqual([]);
  });

  it('flags a carriageway drawn backwards', () => {
    const bad = sameWayStretches([road('Av. X', [0, 0], [0, -300]), road('Av. X', [-15, 0], [-15, -300])]);
    expect(bad.length).toBe(1);
    expect(bad[0].length).toBeGreaterThan(250);
  });

  it('passes two branches of one carriageway (a split into a tunnel and a surface lane)', () => {
    const roads = [
      road('Av. X', [0, 0], [0, -100]),
      road('Av. X', [0, -100], [6, -250], [6, -400]),
      road('Av. X', [0, -100], [-6, -250], [-6, -400]),
      road('Av. X', [-30, -400], [-30, 0]),
    ];
    expect(sameWayStretches(roads)).toEqual([]);
  });
});

describe('divided avenues on La Mariscal', () => {
  it('have their two carriageways running opposite ways along their whole length', () => {
    const bad = sameWayStretches(city.roads).filter((w) => inPlay(w.from) || inPlay(w.to));
    expect(bad.map((w) => `${w.name} near (${w.from.x.toFixed(0)}, ${w.from.z.toFixed(0)}), ${w.length} m`)).toEqual([]);
  });

  // Bug report: from Fray Antonio de Marchena down to the Universidad Central both sides ran
  // north to south (OSM way 24652213, reversed by mistake in 2026: see `reverseWays`).
  it('Av. América runs north on its east side and south on its west side, Marchena to the Universidad Central', () => {
    const graph = buildRoadGraph(city);
    // Both carriageways, also where one is closed off (it leaves the play area).
    const america = graph.edges.filter((e) => e.road === 'Av. América');
    // Where a carriageway crosses the line z = const, and which way it goes.
    const crossings = (z: number) => {
      const out: { x: number; north: boolean; edge: LaneEdge }[] = [];
      for (const e of america) {
        const pts = e.center.pts;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          if ((a.z - z) * (b.z - z) > 0 || a.z === b.z) continue;
          out.push({ x: a.x + ((b.x - a.x) * (z - a.z)) / (b.z - a.z), north: b.z < a.z, edge: e });
        }
      }
      return out.sort((p, q) => p.x - q.x);
    };
    const nav = new Navigator(graph);
    // Marchena is at z ≈ -555; past z ≈ -370 the west carriageway bends out of the play area
    // (roadworks) while the east one goes on to the Universidad Central. Junctions in between
    // trim the edges back, so a line through one may cross a single carriageway.
    let both = 0;
    for (let z = -540; z <= -200; z += 10) {
      const c = crossings(z);
      if (c.length < 2) continue;
      both++;
      expect(c[0].north, `west carriageway at z=${z} runs south`).toBe(false);
      expect(c.at(-1)!.north, `east carriageway at z=${z} runs north`).toBe(true);
      expect(c.at(-1)!.edge.drivable, `east carriageway at z=${z} is open`).toBe(true);
      // Guidance finds the east side heading north, on a lane going that way.
      const east = c.at(-1)!;
      const at = nav.locate({ x: east.x, z }, Math.PI / 2);
      expect(at, `locate north at z=${z}`).not.toBeNull();
      expect(-graph.edges[at!.edge].dir.z, `located lane at z=${z} heads north`).toBeGreaterThan(0);
    }
    expect(both).toBeGreaterThanOrEqual(20);
  });
});
