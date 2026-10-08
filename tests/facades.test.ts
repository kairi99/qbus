import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { type Building, type CityData, type Vec2, terrainAt } from '../src/world/cityData';
import { BuildingIndex, type FacadeContext, OUT, addFacades, buildingLook, shopBand, windowFloors } from '../src/world/facades';
import { DEFAULT_HILLS } from '../src/world/loadCity';
import { RoadIndex } from '../src/world/roadIndex';
import { LIGHTING, type TimeOfDay } from '../src/world/sky';

/**
 * Facade decoration (windows, cornices, shopfronts, signs) is drawn as quads a few centimeters
 * in front of the building's walls. Two quads in one plane flicker into each other as the camera
 * moves (a sign "blending into the wall"), so: every decoration quad lies in front of its wall,
 * on it and below the roof; overlapping layers are never coplanar; and every shop sign stands
 * clear of everything else on the wall (the old bug: the cornice of one-storey shops sat exactly
 * in the sign's plane, and the fascia stuck out over the roof).
 */

interface Rec {
  layer: 'detail' | 'glow' | 'sign';
  pts: { x: number; y: number; z: number }[];
  color: string;
}

/** A recording stand-in for the chunked builders (in Node there's no sign atlas otherwise). */
function recorder(layer: Rec['layer'], out: Rec[]) {
  const sink = {
    quad: (a: Rec['pts'][0], b: Rec['pts'][0], c: Rec['pts'][0], d: Rec['pts'][0], color: unknown) =>
      out.push({ layer, pts: [a, b, c, d].map((p) => ({ x: p.x, y: p.y, z: p.z })), color: String(color) }),
    add: () => {}, // roof tanks and machine rooms: not on a wall
  };
  return { at: () => sink } as any;
}

interface Wall {
  i: number;
  p0: Vec2;
  d: Vec2;
  n: Vec2;
  len: number;
}

function walls(b: Building): Wall[] {
  const f = b.footprint;
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i].x * f[(i + 1) % f.length].z - f[(i + 1) % f.length].x * f[i].z;
  const orient = s > 0 ? 1 : -1;
  const list: Wall[] = [];
  for (let i = 0; i < f.length; i++) {
    const p0 = f[i];
    const p1 = f[(i + 1) % f.length];
    const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (len < 2.5) continue;
    const d = { x: (p1.x - p0.x) / len, z: (p1.z - p0.z) / len };
    list.push({ i, p0, d, n: { x: orient * d.z, z: -orient * d.x }, len });
  }
  return list;
}

/** A quad in a wall's frame: along the wall (t), out of it, height (y). */
function local(w: Wall, r: Rec) {
  const t = r.pts.map((p) => (p.x - w.p0.x) * w.d.x + (p.z - w.p0.z) * w.d.z);
  const out = r.pts.map((p) => (p.x - w.p0.x) * w.n.x + (p.z - w.p0.z) * w.n.z);
  const y = r.pts.map((p) => p.y);
  return {
    t0: Math.min(...t),
    t1: Math.max(...t),
    o0: Math.min(...out),
    o1: Math.max(...out),
    y0: Math.min(...y),
    y1: Math.max(...y),
  };
}
type Local = ReturnType<typeof local>;

const flat = (q: Local) => q.o1 - q.o0 < 1e-3;
/** Overlap of two quads' (t, y) rectangles, shrunk by a millimeter so touching edges don't count. */
const overlaps = (a: Local, b: Local) => Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0) > 1e-3 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1e-3;

/** Every building's facades built for one time of day, checked wall by wall. */
function facadeProblems(tod: TimeOfDay): { problems: string[]; signs: number; quads: number } {
  const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
  city.terrain!.scale = DEFAULT_HILLS;
  const h = (p: Vec2) => terrainAt(city, p);
  const recs: Rec[] = [];
  const ctx: FacadeContext = {
    detail: recorder('detail', recs),
    glow: recorder('glow', recs),
    signs: recorder('sign', recs),
    ground: h,
    roads: new RoadIndex(city.roads),
    avenues: new RoadIndex(city.roads.filter((r) => r.kind === 'avenue' || /^Av\.? /.test(r.name))),
    buildings: new BuildingIndex(city.buildings.map((b) => b.footprint)),
    light: LIGHTING[tod],
  };
  const problems: string[] = [];
  let signs = 0;
  let quads = 0;
  for (const [bi, b] of city.buildings.entries()) {
    recs.length = 0;
    const top = Math.max(...b.footprint.map(h));
    const roofY = top + b.height;
    addFacades(ctx, b, buildingLook(ctx, b), top);
    quads += recs.length;
    const ws = walls(b);
    // Each quad flat on a wall (parallel to it, just in front) belongs to that wall.
    const onWall = new Map<number, { r: Rec; q: Local }[]>();
    const loose: Rec[] = []; // balconies' sides and slabs, awnings: sticking out of a wall
    for (const r of recs) {
      let home: { w: Wall; q: Local } | null = null;
      for (const w of ws) {
        const q = local(w, r);
        if (flat(q) && q.o0 > -1e-3 && q.o0 < 0.3 && q.t0 > -0.2 && q.t1 < w.len + 0.2) {
          home = { w, q };
          break;
        }
      }
      if (!home) {
        if (r.layer === 'sign') problems.push(`building ${bi}: a sign isn't on any of its walls`);
        loose.push(r);
        continue;
      }
      const list = onWall.get(home.w.i) ?? [];
      list.push({ r, q: home.q });
      onWall.set(home.w.i, list);
    }
    for (const w of ws) {
      const list = onWall.get(w.i) ?? [];
      const where = `building ${bi} wall ${w.i} (${w.p0.x.toFixed(1)}, ${w.p0.z.toFixed(1)}), ${b.height} m`;
      for (const { r, q } of list) {
        if (q.o0 < OUT.plinth - 1e-4) problems.push(`${where}: ${r.layer} quad only ${(q.o0 * 100).toFixed(1)} cm off the wall`);
        if (q.y1 > roofY + 0.12 + 1e-4) problems.push(`${where}: ${r.layer} quad ${(q.y1 - roofY).toFixed(2)} m over the roof`);
      }
      // No two overlapping layers in the same plane (different colors flicker into each other).
      const sorted = [...list].sort((a, b) => a.q.o0 - b.q.o0);
      for (let a = 0; a < sorted.length; a++)
        for (let k = a + 1; k < sorted.length && sorted[k].q.o0 - sorted[a].q.o0 < 0.005; k++) {
          const A = sorted[a];
          const B = sorted[k];
          if ((A.r.color !== B.r.color || A.r.layer !== B.r.layer) && overlaps(A.q, B.q))
            problems.push(`${where}: coplanar ${A.r.layer} ${A.r.color} and ${B.r.layer} ${B.r.color} at ${(A.q.o0 * 100).toFixed(1)} cm, y ${A.q.y0.toFixed(2)}–${A.q.y1.toFixed(2)}`);
        }
      for (const s of list.filter((e) => e.r.layer === 'sign')) {
        signs++;
        const q = s.q;
        if (q.o0 < OUT.sign - 1e-4) problems.push(`${where}: sign only ${(q.o0 * 100).toFixed(1)} cm off the wall`);
        if (q.t0 < 0 || q.t1 > w.len) problems.push(`${where}: sign runs off the wall (t ${q.t0.toFixed(2)}–${q.t1.toFixed(2)} of ${w.len.toFixed(2)})`);
        if (q.y1 > roofY + 0.05) problems.push(`${where}: sign over the roof`); // a parapet fascia stands a little over it
        for (const p of s.r.pts) if (ctx.buildings.contains(p)) problems.push(`${where}: sign inside a building`);
        // Nothing else on the wall in front of it or within 3 cm behind it...
        for (const o of list)
          if (o !== s && overlaps(o.q, q) && o.q.o0 > q.o0 - 0.03) problems.push(`${where}: ${o.r.layer} ${o.r.color} at ${(o.q.o0 * 100).toFixed(1)} cm covers or touches the sign`);
        // ...and nothing sticking out of the wall cuts through it.
        for (const r of loose) {
          const o = local(w, r);
          if (o.o0 < q.o0 && o.o1 > q.o0 && overlaps(o, q)) problems.push(`${where}: ${r.layer} ${r.color} cuts through the sign`);
        }
      }
    }
  }
  return { problems, signs, quads };
}

describe('facade decoration on La Mariscal', () => {
  for (const tod of ['day', 'night'] as const)
    it(`stays in front of its walls, under the roof, never coplanar (${tod})`, () => {
      const { problems, signs, quads } = facadeProblems(tod);
      expect(quads).toBeGreaterThan(50_000);
      expect(signs).toBeGreaterThan(1000);
      expect(problems.slice(0, 20)).toEqual([]);
    });
});

describe('shopfront layout', () => {
  it('fits under the ceiling, sign inside the fascia, opening under it', () => {
    for (const ceiling of [2.6, 2.9, 3.05, 3.12, 3.6, 5])
      for (const parapet of [false, true]) {
        const b = shopBand(0, ceiling, parapet);
        expect(b.fascia1).toBeLessThanOrEqual(ceiling + 1e-9);
        expect(b.fascia1 - b.fascia0).toBeGreaterThanOrEqual(0.45 - 1e-9);
        expect(b.sign0).toBeGreaterThan(b.fascia0);
        expect(b.sign1).toBeLessThan(b.fascia1);
        expect(b.sign1).toBeGreaterThan(b.sign0 + 0.25);
        expect(b.open).toBeLessThan(b.fascia0);
        expect(b.open).toBeGreaterThanOrEqual(2.05);
        if (parapet) expect(b.fascia1).toBe(ceiling);
      }
  });

  it('windows rows fit below the roof', () => {
    for (let h = 2; h < 60; h += 0.25) {
      const f = windowFloors(h);
      expect(f).toBeGreaterThanOrEqual(1);
      if (h >= 2.8) expect((f - 1) * 3.2 + 2.45).toBeLessThanOrEqual(h - 0.35 + 1e-9);
    }
  });
});
