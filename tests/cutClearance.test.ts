import { describe, expect, it } from 'vitest';
import type { Road } from '../src/world/cityData';
import { distToPolyline } from '../src/world/geom';
import { clearCuts } from '../src/world/osm/cutClearance';

const line = (z: number, x0 = 0, x1 = 200): { x: number; z: number }[] => [x0, (x0 + x1) / 2, x1].map((x) => ({ x, z }));
const street = (z: number, extra: Partial<Road> = {}): Road => ({ name: 'Avenida', kind: 'street', points: line(z), width: 6, lanes: 1, oneway: true, ...extra });
// A divided avenue whose southbound carriageway dives into an underpass: 4 m between centerlines,
// as OSM draws 12 de Octubre by El Ejido, each carriageway 6 m wide.
const cut = (z: number): Road => ({ ...street(z), points: line(z), lift: [0, -5, 0] });

describe('clearCuts', () => {
  it('pushes a street alongside a cut clear of its floor and wall', () => {
    const [moved, c] = clearCuts([street(0), cut(4)]);
    const mid = moved.points.filter((p) => p.x > 70 && p.x < 130);
    expect(mid.length).toBeGreaterThan(5);
    for (const p of mid) expect(distToPolyline(p, c.points)).toBeGreaterThanOrEqual(6 + 1.1 - 0.05);
    // Its ends (junctions) stay exactly where they were.
    expect(moved.points[0]).toEqual({ x: 0, z: 0 });
    expect(moved.points.at(-1)).toEqual({ x: 200, z: 0 });
  });

  it('leaves streets crossing over the underpass, ramps and far streets alone', () => {
    const over: Road = { ...street(0), points: [{ x: 100, z: -60 }, { x: 100, z: 60 }] };
    const far = street(30);
    const roads = [over, cut(4), far];
    const out = clearCuts(roads);
    expect(out[0]).toBe(over);
    expect(out[1]).toBe(roads[1]);
    expect(out[2]).toBe(far);
  });

  it('gives a ramp\'s shallow walled top room on a bend, but leaves a street overlapping it there alone', () => {
    // A ramp climbing out of its cut: 4 m down at x 0, 0.6 m down by x 100 (still walled there)
    // and bending left there (12 de Octubre's S→N link to Patria, Ladrón de Guevara beside it).
    const ramp: Road = { ...street(0), points: [{ x: 0, z: 0 }, { x: 60, z: 0 }, { x: 100, z: 0 }, { x: 120, z: -12 }], lift: [-4, -2, -0.6, 0] };
    const beside: Road = { ...street(7.5), points: [{ x: 40, z: 7.5 }, { x: 100, z: 7.5 }, { x: 160, z: 7.5 }] };
    const [, moved] = clearCuts([ramp, beside]);
    const at = moved.points.reduce((b, p) => (Math.abs(p.x - 98) < Math.abs(b.x - 98) ? p : b));
    // Already clear of its shoulder and wall (1.5 m): only the bend allowance moves it.
    expect(at.z).toBeGreaterThan(7.5 + 0.3);
    const over: Road = { ...street(4), points: [{ x: 40, z: 4 }, { x: 100, z: 4 }, { x: 160, z: 4 }] };
    const [, kept] = clearCuts([{ ...ramp, lift: [-0.9, -0.8, -0.6, 0] }, over]);
    for (const p of kept.points) expect(p.z).toBeCloseTo(4, 1);
  });

  it('never moves a street toward another street or a busway beside it', () => {
    const other = street(-7);
    const bus: Road = { ...street(-5), access: 'brt', width: 3.4 };
    for (const roads of [[street(0), cut(4), other], [street(0), cut(4)]]) {
      const busways = roads.length === 2 ? [bus] : [];
      const [moved] = clearCuts(roads, busways);
      for (const p of moved.points) expect(p.z).toBeGreaterThanOrEqual(-0.01);
    }
  });
});
