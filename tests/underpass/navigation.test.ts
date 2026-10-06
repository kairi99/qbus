/**
 * Catalog sanity and navigation through every underpass and bridge: `Navigator.locate` picks the
 * right level, routes stay level-consistent, and the R reset (`snapToRoad`) puts the bus on the
 * level it was on, clear of walls. Runs in `npm test`. See README.md.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Navigator } from '../../src/gameplay/navigation';
import { busById } from '../../src/vehicle/buses';
import { groundHeightAt, inPlayArea } from '../../src/world/cityData';
import { type LaneEdge, dirAt, edgeY } from '../../src/world/roadGraph';
import { snapToRoad } from '../../src/world/roadSnap';
import { LIFT_STRUCTURE, crossingEdges, samples } from './catalog';
import { check, known } from './known';
import { type Built, buildAll, cityAndCatalog } from './setup';
import { NAV } from './thresholds';
import { fmt, intrusions, yawPitchRoll } from './probe';

// Observed on the harness's first run: see README.md "Known failures".
known({
  'route joints are legal and level cut Av. 12 de Octubre @(-42,734): sin nombre [e585→e524]':
    'The Queseras tunnel link (e524) ends 1.15 m below the edge it leads into (e277) at node 257: its lift is still -1.0 at its end while the node is at street level',
  'snapToRoad keeps the level and clears walls cut Av. 10 de Agosto @(-172,-870): Av. 10 de Agosto [e276→e276]':
    'R reset at (-176.7, -834.5) in the 10 de Agosto cut puts the bus 0.25 m into the ground beside its lane (trimesh at (-174.9, -836.0), road height)',
  'snapToRoad keeps the level and clears walls cut sin nombre @(-820,774): sin nombre [e681→e195]':
    'R reset at (-820.6, 767.7) in the cut at (-820, 774) puts the bus 1.6 m into a wall (convex hull at (-826.2, 767.8, y 21.9)): the same wall the drive-through hits',
});

const base = cityAndCatalog();
const { city, graph, structures } = base;
const nav = new Navigator(graph);
const ground = (p: { x: number; z: number }) => groundHeightAt(city, p);
const yAt = (e: LaneEdge, s: number) => edgeY(e, s) ?? ground(e.center.pts[0] && dirAt(e.center, s) ? posOn(e, s) : e.a);
function posOn(e: LaneEdge, s: number) {
  const { cum, pts } = e.center;
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
}
const heading = (d: { x: number; z: number }) => Math.atan2(-d.z, d.x);

describe('underpass catalog', () => {
  it('finds the known structures', () => {
    const ids = structures.map((s) => s.id);
    console.log(`${structures.length} structures, ${structures.reduce((n, s) => n + s.passages.length, 0)} passages:\n  ${ids.join('\n  ')}`);
    expect(structures.some((s) => s.kind === 'cut' && s.name === 'Av. 12 de Octubre' && s.passages.length >= 4)).toBe(true);
    expect(structures.some((s) => s.kind === 'bridge' && s.name === 'Av. Patria' && s.passages.length >= 2)).toBe(true);
  });

  it('puts every drivable lifted edge inside the play area in some passage', () => {
    const covered = new Set(structures.flatMap((s) => s.passages.flatMap((p) => p.edges)));
    const missing = graph.edges.filter(
      (e) => e.drivable && e.lift && Math.max(...e.lift.map(Math.abs)) >= LIFT_STRUCTURE && e.center.pts.some((p) => inPlayArea(city, p)) && !covered.has(e.id),
    );
    expect(missing.map((e) => `e${e.id} ${e.road}`)).toEqual([]);
  });
});

for (const s of structures.filter((x) => x.passages.length))
  describe(s.id, () => {
    for (const p of s.passages) {
      check(`route joints are legal and level ${p.id}`, () => {
        const bad: string[] = [];
        for (let i = 0; i < p.route.length - 1; i++) {
          const a = graph.edges[p.route[i]];
          const b = graph.edges[p.route[i + 1]];
          if (a.to !== b.from) bad.push(`e${a.id} doesn't lead into e${b.id}`);
          const dy = Math.abs(yAt(a, a.len) - yAt(b, 0));
          if (dy > NAV.JOINT_TOL) bad.push(`e${a.id}→e${b.id} step ${dy.toFixed(2)} m at node ${a.to}`);
        }
        expect(bad, bad.join('\n')).toEqual([]);
      });

      check(`Navigator routes through the passage ${p.id}`, () => {
        const first = graph.edges[p.edges[0]];
        const last = graph.edges[p.edges[p.edges.length - 1]];
        const path = nav.route({ edge: first.id, s: Math.min(2, first.len / 2) }, { edge: last.id, s: Math.max(last.len - 2, last.len / 2) });
        expect(path, 'route').not.toBeNull();
        expect(path!.edges).toEqual(p.edges);
      });

      check(`locate picks the right level ${p.id}`, () => {
        const bad: string[] = [];
        for (const q of samples(graph, city, p.edges, NAV.STEP)) {
          if (Math.abs(q.lift) < LIFT_STRUCTURE) continue;
          // On the structure's own lane, at its height.
          const got = nav.locate(q.pos, heading(q.dir), q.y, ground);
          const gy = got && yAt(graph.edges[got.edge], got.s);
          if (!got || Math.abs(gy! - q.y) > NAV.LEVEL_TOL) bad.push(`in e${q.edge} at (${q.pos.x.toFixed(1)}, ${q.pos.z.toFixed(1)}) y ${q.y.toFixed(1)}: got e${got?.edge} y ${gy?.toFixed(1)}`);
          // On a road crossing over (or under) it, at that road's height.
          for (const c of crossingEdges(city, graph, q.pos, q.y)) {
            const ce = graph.edges[c.edge];
            const at = posOn(ce, c.s);
            const g2 = nav.locate(at, heading(dirAt(ce.center, c.s)), c.y, ground);
            const y2 = g2 && yAt(graph.edges[g2.edge], g2.s);
            if (!g2 || Math.abs(y2! - c.y) > NAV.LEVEL_TOL) bad.push(`on e${c.edge} ${ce.road} over/under at (${at.x.toFixed(1)}, ${at.z.toFixed(1)}) y ${c.y.toFixed(1)}: got e${g2?.edge} y ${y2?.toFixed(1)}`);
          }
        }
        expect(bad, bad.join('\n')).toEqual([]);
      });
    }
  });

describe('R reset (snapToRoad) in and over every structure', () => {
  let built: Built;
  beforeAll(async () => {
    built = await buildAll(base);
  }, 60_000);

  const bus = busById('interparroquial');
  const { length: L, width: W, height: H } = bus.body;
  /** Walls (not the road under it) cutting into a bus box at a snapped pose, pitched to the road. */
  function blocked(pos: { x: number; z: number }, h: number, y: number, pitch: number): string | null {
    const hits = intrusions(built.world, { x: pos.x, y: y + NAV.SNAP_LIFT + H / 2, z: pos.z }, yawPitchRoll(h, pitch), { x: L / 2, y: H / 2, z: W / 2 }, NAV.SNAP_DEPTH);
    if (!hits.length) return null;
    const worst = hits.reduce((a, b) => (a.depth > b.depth ? a : b));
    return `shape ${worst.shape} ${worst.depth.toFixed(2)} m deep at ${fmt(worst.point)}`;
  }

  for (const s of structures.filter((x) => x.passages.length))
    for (const p of s.passages)
      check(`snapToRoad keeps the level and clears walls ${p.id}`, () => {
        const bad: string[] = [];
        for (const q of samples(graph, city, p.edges, NAV.STEP)) {
          if (Math.abs(q.lift) < LIFT_STRUCTURE) continue;
          const cases = [{ what: `in e${q.edge}`, pos: q.pos, h: heading(q.dir), y: q.y }];
          for (const c of crossingEdges(city, graph, q.pos, q.y)) {
            const ce = graph.edges[c.edge];
            cases.push({ what: `on e${c.edge} ${ce.road}`, pos: posOn(ce, c.s), h: heading(dirAt(ce.center, c.s)), y: c.y });
          }
          for (const k of cases) {
            const r = snapToRoad(city, k.pos, k.h, k.y);
            const where = `${k.what} at (${k.pos.x.toFixed(1)}, ${k.pos.z.toFixed(1)}) y ${k.y.toFixed(1)}`;
            if (Math.abs(r.y - k.y) > NAV.SNAP_TOL) {
              bad.push(`${where}: snapped to y ${r.y.toFixed(1)} at (${r.pos.x.toFixed(1)}, ${r.pos.z.toFixed(1)})`);
              continue;
            }
            // Pitch the box to the road under the snapped spot (front and back wheels' heights).
            const f = { x: Math.cos(r.heading), z: -Math.sin(r.heading) };
            const yOf = (pt: { x: number; z: number }) => snapToRoad(city, pt, r.heading, r.y).y;
            const front = yOf({ x: r.pos.x + (f.x * L) / 2, z: r.pos.z + (f.z * L) / 2 });
            const back = yOf({ x: r.pos.x - (f.x * L) / 2, z: r.pos.z - (f.z * L) / 2 });
            const hit = blocked(r.pos, r.heading, r.y, Math.atan2(front - back, L));
            if (hit) bad.push(`${where}: snapped bus at (${r.pos.x.toFixed(1)}, ${r.pos.z.toFixed(1)}) y ${r.y.toFixed(1)} touches ${hit}`);
          }
        }
        expect(bad, bad.join('\n')).toEqual([]);
      });
});
