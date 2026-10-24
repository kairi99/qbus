import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CityData, Vec2 } from '../src/world/cityData';
import { groundHeightAt } from '../src/world/cityData';
import { CIRCUIT_LEAD, CIRCUIT_RUNOFF, circuitTrack } from '../src/world/circuitTrack';
import { loadCity, loadZone } from '../src/world/loadCity';
import * as THREE from 'three';
import { RAPIER, createWorld, initRapier } from '../src/physics/world';
import { buildCity } from '../src/world/cityBuilder';
import { courseInside } from '../src/world/circuitBuilder';
import { GROUP, groups } from '../src/physics/world';
import { buildRoadGraph } from '../src/world/roadGraph';
import { isCircuit, lapOf, lapStart, locateOnTrack, onMountain, trackPose, trackPoint, type TrackData } from '../src/world/track';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const circuit = city.circuits?.[0];
const hash = (v: unknown) => createHash('sha1').update(JSON.stringify(v)).digest('hex');

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
const heading = (a: Vec2, b: Vec2) => Math.atan2(b.z - a.z, b.x - a.x);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Distance from p to segment ab. */
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/** Distance from p to the lap polyline. */
function lapDist(p: Vec2): number {
  const pts = circuit!.points;
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(p, pts[i], pts[i + 1]));
  return d;
}

describe('Circuito Zona Rosa (mariscal.json)', () => {
  it('is defined', () => {
    expect(circuit).toBeDefined();
    expect(circuit!.id).toBe('zonarosa');
    expect(circuit!.name).toBe('Circuito Zona Rosa');
    expect(circuit!.laps).toBe(3);
  });

  it('is one closed lap of 1.5 to 2.5 km, a point every ~2 m', () => {
    const p = circuit!.points;
    expect(dist(p[0], p[p.length - 1])).toBeLessThan(1e-6);
    let len = 0;
    for (let i = 1; i < p.length; i++) {
      const d = dist(p[i - 1], p[i]);
      expect(d).toBeGreaterThan(1);
      expect(d).toBeLessThan(3);
      len += d;
    }
    expect(len).toBeGreaterThan(1500);
    expect(len).toBeLessThan(2500);
    expect(circuit!.line).toBeGreaterThan(0);
    expect(circuit!.line).toBeLessThan(len);
  });

  it('has at least 7 corners (over 45 degrees within 40 m)', () => {
    const p = circuit!.points.slice(0, -1);
    const n = p.length;
    const step = dist(p[0], p[1]);
    const span = Math.round(40 / step);
    const turn = (i: number) => wrap(heading(p[(i + 1) % n], p[(i + 2) % n]) - heading(p[i % n], p[(i + 1) % n]));
    const sums: number[] = [];
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let k = 0; k < span; k++) a += turn(i + k);
      sums.push(a);
    }
    // Count separate corners: a run of windows over 45 degrees is one corner.
    let corners = 0;
    let inside = false;
    for (let i = 0; i < n + span; i++) {
      const big = Math.abs(sums[i % n]) > Math.PI / 4;
      if (big && !inside) corners++;
      inside = big;
    }
    expect(corners).toBeGreaterThanOrEqual(7);
  });

  it('rounds every corner with a radius of at least 8 m', () => {
    const p = circuit!.points.slice(0, -1);
    const n = p.length;
    const step = dist(p[0], p[1]);
    const span = Math.round(40 / step);
    const at = (i: number) => p[((i % n) + n) % n];
    const turn = (i: number) => wrap(heading(at(i + 1), at(i + 2)) - heading(at(i), at(i + 1)));
    // Local radius over a 3-step window: step / turn angle.
    const radius = (i: number) => (3 * step) / Math.max(1e-9, Math.abs(turn(i) + turn(i + 1) + turn(i + 2)));
    const corners: number[] = [];
    let run: number[] = [];
    for (let i = 0; i < n + span; i++) {
      let a = 0;
      for (let k = 0; k < span; k++) a += turn(i + k);
      if (Math.abs(a) > Math.PI / 4) run.push(i % n);
      else if (run.length) {
        corners.push(Math.min(...run.flatMap((j) => Array.from({ length: span }, (_, k) => radius(j + k)))));
        run = [];
      }
    }
    if (run.length) corners.push(Math.min(...run.flatMap((j) => Array.from({ length: span }, (_, k) => radius(j + k)))));
    expect(corners.length).toBeGreaterThanOrEqual(7);
    for (const r of corners) expect(r).toBeGreaterThanOrEqual(8);
  });

  it('keeps the line 1.5 m inside the barrier on both sides everywhere', () => {
    const c = circuit!;
    for (let i = 0; i < c.points.length; i++) {
      expect(Math.min(c.left[i], c.right[i]), `point ${i}`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('keeps barrier offsets outside the carriageway and the course 9 m wide', () => {
    const c = circuit!;
    const n = c.points.length;
    expect(c.left).toHaveLength(n);
    expect(c.right).toHaveLength(n);
    expect(c.halfRoad).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(c.left[i]).toBeGreaterThanOrEqual(c.halfRoad[i] - 1e-9);
      expect(c.right[i]).toBeGreaterThanOrEqual(c.halfRoad[i] - 1e-9);
      expect(c.left[i] + c.right[i]).toBeGreaterThanOrEqual(9);
    }
  });

  it('puts every mouth where another road leaves the barrier line', () => {
    const c = circuit!;
    const n = c.points.length - 1;
    const step = dist(c.points[0], c.points[1]);
    expect(c.mouths.length).toBeGreaterThan(0);
    for (const m of c.mouths) {
      expect(m.s).toBeGreaterThanOrEqual(0);
      expect(m.s).toBeLessThanOrEqual(step * n + step);
      expect([1, -1]).toContain(m.side);
      const i = Math.min(n - 1, Math.round(m.s / step));
      const a = c.points[i];
      const b = c.points[i + 1];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      // Right-hand normal (+Z is right when facing +X).
      const nx = -(b.z - a.z) / d;
      const nz = (b.x - a.x) / d;
      const off = m.side === 1 ? c.right[i] : c.left[i];
      const bp = { x: a.x + nx * m.side * off, z: a.z + nz * m.side * off };
      // Another road: segments the lap runs along (within 5 m, a filleted corner cuts that much) don't count.
      const near = city.roads.some((r) => {
        for (let k = 0; k < r.points.length - 1; k++) {
          const p0 = r.points[k];
          const p1 = r.points[k + 1];
          const mid = { x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 };
          if ([p0, mid, p1].every((q) => lapDist(q) < 5)) continue;
          if (segDist(bp, p0, p1) <= m.width / 2 + step) return true;
        }
        return false;
      });
      expect(near, `mouth at s=${m.s}`).toBe(true);
    }
  });

  it('puts the start/finish line on Av. Río Amazonas, 110-130 m after the Carrión corner', () => {
    const c = circuit!;
    // The line point and the Carrión x Amazonas apex (the first via, where the lap's first corner is).
    const n = c.points.length - 1;
    const step = dist(c.points[0], c.points[1]);
    const lp = c.points[Math.min(n - 1, Math.round(c.line / step))];
    const apex = { x: -141.3, z: 0.7 };
    const names = city.roads.filter((r) => r.name === 'Av. Río Amazonas');
    const onAmazonas = names.some((r) => r.points.some((_, k) => k < r.points.length - 1 && segDist(lp, r.points[k], r.points[k + 1]) < 1.5));
    expect(onAmazonas).toBe(true);
    // Distance along the street from the apex to the line: the line is on a straight, so the chord is close.
    const along = dist(lp, apex);
    expect(along).toBeGreaterThanOrEqual(110);
    expect(along).toBeLessThanOrEqual(130);
  });

  it('leaves roads, buildings and stops exactly as they were', () => {
    // Pinned from the build before circuits existed (route shifts and free roam read these).
    expect(city.roads).toHaveLength(882);
    expect(city.buildings).toHaveLength(1878);
    expect(city.stops).toHaveLength(88);
    expect(hash(city.roads)).toBe('6b64a880ae08e0468e0be5f62f0357e608ea4fb7');
    expect(hash(city.buildings)).toBe('804d423223a24adc8875d8f062712337dd468608');
    expect(hash(city.stops)).toBe('776ae870b5937b9b11bb599a855d5b6a94c46d76');
  });
});


describe('Circuito Zona Rosa as a race track', () => {
  const track = circuitTrack(city, circuit!);
  const L = track.circuit!.lap;
  const laps = circuit!.laps;

  it('is unrolled: lead-in, laps, run-off', () => {
    expect(isCircuit(track)).toBe(true);
    expect(track.start).toBe(CIRCUIT_LEAD);
    expect(track.finish).toBeCloseTo(CIRCUIT_LEAD + laps * L, 0);
    expect(track.cum[track.cum.length - 1]).toBeCloseTo(track.finish + CIRCUIT_RUNOFF, 0);
    expect(track.cum[0]).toBe(0);
    expect(track.rails).toEqual([]);
    expect(track.drops).toEqual([]);
    expect(track.from).toBe(circuit!.name);
    expect(track.to).toBe(`${laps} vueltas`);
    // The line is where the lap says it is.
    const line = trackPoint(track, track.start);
    const at = circuit!.points.reduce((b, p) => Math.min(b, Math.hypot(p.x - line.x, p.z - line.z)), Infinity);
    expect(at).toBeLessThan(2);
    for (let i = 1; i < track.cum.length; i++) expect(track.cum[i]).toBeGreaterThan(track.cum[i - 1]);
  });

  it('width is the narrowest course; edges repeat per point', () => {
    const narrow = Math.min(...circuit!.left.map((l, i) => l + circuit!.right[i]));
    expect(track.width).toBeCloseTo(narrow, 1);
    expect(track.edges!.left).toHaveLength(track.points.length);
    expect(track.edges!.right).toHaveLength(track.points.length);
    // One lap on, the same place has the same edges.
    const i = track.cum.findIndex((c) => c >= track.start + 300);
    const j = track.cum.findIndex((c) => c >= track.start + 300 + L);
    expect(track.edges!.left[j]).toBeCloseTo(track.edges!.left[i], 0);
    expect(track.edges!.right[j]).toBeCloseTo(track.edges!.right[i], 0);
  });

  it('unrolled circuit: s is continuous over the lap seam', () => {
    for (let lap = 2; lap <= laps; lap++) {
      const a = trackPose(track, lapStart(track, lap) - 0.5);
      const b = trackPose(track, lapStart(track, lap) + 0.5);
      expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeLessThan(1.2);
      expect(Math.abs(wrap(a.heading - b.heading))).toBeLessThan(0.1);
    }
    // And the lap closes: one lap on is the same spot.
    const p = trackPoint(track, track.start + 123);
    const q = trackPoint(track, track.start + 123 + L);
    expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThan(0.5);
  });

  it('lapOf', () => {
    expect(lapOf(track, 0)).toBe(1);
    expect(lapOf(track, track.start - 1)).toBe(1);
    expect(lapOf(track, track.start)).toBe(1);
    expect(lapOf(track, lapStart(track, 2) - 0.01)).toBe(1);
    expect(lapOf(track, lapStart(track, 2))).toBe(2);
    expect(lapOf(track, lapStart(track, 3))).toBe(3);
    expect(lapOf(track, track.finish + 100)).toBe(laps);
    expect(lapOf(track, 1e6)).toBe(laps);
    expect(lapStart(track, 1)).toBe(track.start);
  });

  it('locate keeps a lap-3 car on lap 3', () => {
    const s3 = lapStart(track, 3) + 300;
    const q = trackPoint(track, s3);
    const p = { x: q.x, z: q.z, y: q.y };
    // With the last s as the hint.
    const hinted = locateOnTrack(track, p, s3 - 5, 120, 3);
    expect(hinted.s).toBeGreaterThanOrEqual(lapStart(track, 3));
    expect(hinted.s).toBeCloseTo(s3, 0);
    // The no-hint path after a fall or an R: the caller's lap.
    const lost = locateOnTrack(track, p, -1, 80, lapOf(track, s3));
    expect(lost.s).toBeCloseTo(s3, 0);
    expect(lapOf(track, lost.s)).toBe(3);
    // Without a lap it searches lap 1.
    expect(lapOf(track, locateOnTrack(track, p).s)).toBe(1);
    // Every lap, near its seams too.
    for (let lap = 1; lap <= laps; lap++) {
      for (const d of [-30, 0, 30, L / 2, L - 10]) {
        const s = lapStart(track, lap) + d;
        if (s < 0 || s > track.cum[track.cum.length - 1]) continue;
        // Lap 1's search also covers the lead-in, which is the lap's last 100 m again (the sites keep the hint instead).
        if (lapOf(track, s) === 1 && s > lapStart(track, 2) - 100) continue;
        const r = trackPoint(track, s);
        const f = locateOnTrack(track, { x: r.x, z: r.z, y: r.y }, -1, 80, lapOf(track, s));
        expect(Math.abs(f.s - s), `lap ${lap} d ${d}`).toBeLessThan(1);
      }
    }
  });

  it('mountain tracks ignore the lap hint', () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i * 10, z: 0 }));
    const flat: TrackData = { from: 'a', to: 'b', points: pts, y: pts.map(() => 0), cum: pts.map((_, i) => i * 10), width: 8, start: 20, finish: 450, rails: [], drops: [], pickups: [] };
    expect(onMountain({ race: flat })).toBe(true);
    expect(lapOf(flat, 300)).toBe(1);
    const a = locateOnTrack(flat, { x: 333, z: 2 });
    expect(locateOnTrack(flat, { x: 333, z: 2 }, -1, 80, 3)).toEqual(a);
    expect(a.s).toBeCloseTo(333, 5);
  });

  it('three pairs of pickups, one physical copy per spot (never stacked per lap), off the line and the corners', () => {
    expect(track.pickups).toHaveLength(3 * 2);
    expect(new Set(track.pickups.map((k) => k.s)).size).toBe(3);
    expect(track.pickups.map((k) => k.off).sort()).toEqual([-1.9, -1.9, -1.9, 1.9, 1.9, 1.9]);
    // All within the first lap's span.
    for (const k of track.pickups) expect(k.s - track.start).toBeLessThan(L);
    for (const k of track.pickups) {
      const u = (k.s - track.start) % L;
      expect(Math.min(u, L - u)).toBeGreaterThan(40);
      for (const a of [-10, 0, 10]) {
        const h = (d: number) => {
          const p = trackPose(track, k.s + a + d).heading;
          return p;
        };
        expect(Math.abs(wrap(h(-10) - h(10)))).toBeLessThan((30 * Math.PI) / 180);
      }
    }
  });

  it('pickups sit at least 40 m from every corner apex (sharpest turning point)', () => {
    const h = (u: number) => trackPose(track, track.start + u).heading;
    const turnOver = (u: number, w: number) => Math.abs(wrap(h(u + w) - h(u - w)));
    const apexes: number[] = [];
    let best = -1;
    let bestK = 0;
    // Start in the lead-in's straight-ish part is not assumed: run over one lap and close runs at the end.
    for (let u = 0; u <= L; u++) {
      if (turnOver(u, 10) > (30 * Math.PI) / 180) {
        if (turnOver(u, 5) > bestK) (bestK = turnOver(u, 5)), (best = u);
      } else if (best >= 0) {
        apexes.push(best);
        best = -1;
        bestK = 0;
      }
    }
    expect(apexes.length).toBeGreaterThan(3);
    for (const k of track.pickups) {
      const u = (k.s - track.start) % L;
      for (const a of apexes) {
        const d = Math.abs(u - a);
        expect(Math.min(d, L - d)).toBeGreaterThanOrEqual(40);
      }
    }
  });

  it('height follows the city ground', () => {
    const mid = trackPose(track, track.start + 200);
    expect(mid.y).toBeCloseTo(groundHeightAt(city, mid.pos), 0);
    expect(Math.max(...track.y) - Math.min(...track.y)).toBeLessThan(80);
  });
});

describe('loading the zonarosa zone', () => {
  it('loading zonarosa does not touch mariscal', async () => {
    const zr = await loadCity(new URLSearchParams({ city: 'zonarosa', mode: 'race', hills: '1.3' }));
    expect(zr.race?.circuit?.id).toBe('zonarosa');
    expect(zr.terrain!.scale).toBe(1);
    const m = await loadCity(new URLSearchParams({ city: 'mariscal', hills: '1.3' }));
    expect(m.race).toBeUndefined();
    expect(m.terrain!.scale).toBe(1.3);
    expect(zr.terrain!.scale).toBe(1);
    expect(zr.roads).toBe(m.roads);
    expect(zr.terrain).not.toBe(m.terrain);
  });

  it('is the race for the menu and a race, plain Mariscal for free roam and shifts', async () => {
    expect((await loadZone('zonarosa')).race).toBeDefined();
    expect((await loadCity(new URLSearchParams({ city: 'zonarosa', mode: 'online' }))).race).toBeDefined();
    expect((await loadCity(new URLSearchParams({ city: 'zonarosa', mode: 'free', play: '1' }))).race).toBeUndefined();
    expect((await loadCity(new URLSearchParams({ city: 'zonarosa', play: '1' }))).race).toBeUndefined();
  });
});

describe('the circuit dressing (real colliders)', () => {
  let zr: CityData;
  let world: ReturnType<typeof createWorld>;
  beforeAll(async () => {
    await initRapier();
    zr = await loadCity(new URLSearchParams({ city: 'zonarosa', mode: 'race' }));
    world = createWorld();
    buildCity(zr, world, new THREE.Scene(), buildRoadGraph(zr));
    world.step();
  }, 120_000);

  const lap = () => zr.race!.circuit!.data;
  /** Unit tangent at lap point i and its right-hand normal (+Z is right facing +X). */
  const frame = (c: ReturnType<typeof lap>, i: number) => {
    const a = c.points[Math.max(0, i - 1)];
    const b = c.points[Math.min(c.points.length - 1, i + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const t = { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
    return { t, n: { x: -t.z, z: t.x } };
  };
  const cast = (o: { x: number; y: number; z: number }, d: { x: number; z: number }, max: number) => world.castRay(new RAPIER.Ray(o, { x: d.x, y: 0, z: d.z }), max, true)?.timeOfImpact ?? null;

  it('course is clear', () => {
    const c = lap();
    const bad: string[] = [];
    for (let i = 0; i < c.points.length - 1; i++) {
      const p = c.points[i];
      const { n } = frame(c, i);
      for (const side of [1, -1]) {
        // (The offsets stop 0.3 m short of buildings along the ray to the raster boundary, 0.25 m cells: a building corner up to 0.5 m nearer along this normal is the data, the barrier is drawn there anyway.)
        const reach = (side > 0 ? c.right[i] : c.left[i]) - 0.5;
        for (const h of [0.6, 1.5, 3.3]) {
          const toi = cast({ x: p.x, y: groundHeightAt(zr, p) + h, z: p.z }, { x: n.x * side, z: n.z * side }, reach);
          if (toi !== null) bad.push(`(${p.x.toFixed(1)}, ${p.z.toFixed(1)}) side ${side} at ${h} m: ${toi.toFixed(2)} of ${reach.toFixed(2)} m`);
        }
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('every mouth is closed', () => {
    const c = lap();
    const n = c.points.length - 1;
    const cum = c.points.map((_, i) => 0);
    for (let i = 1; i <= n; i++) cum[i] = cum[i - 1] + Math.hypot(c.points[i].x - c.points[i - 1].x, c.points[i].z - c.points[i - 1].z);
    const open: string[] = [];
    for (const m of c.mouths) {
      for (const along of [-m.width / 2 + 0.5, 0, m.width / 2 - 0.5]) {
        const j = Math.min(n - 1, Math.max(0, cum.findIndex((v) => v >= m.s + along)));
        const { n: nn } = frame(c, j);
        const off = m.side > 0 ? c.right[j] : c.left[j];
        // From the side street, 5 m out, looking at the course along the street.
        const from = { x: c.points[j].x + nn.x * m.side * (off + 5), z: c.points[j].z + nn.z * m.side * (off + 5) };
        const toi = cast({ x: from.x, y: groundHeightAt(zr, from) + 0.4, z: from.z }, { x: -nn.x * m.side, z: -nn.z * m.side }, off + 5);
        if (toi === null || toi > 5.1) open.push(`mouth s=${m.s} side ${m.side} along ${along.toFixed(1)}: ${toi}`);
      }
    }
    expect(open).toEqual([]);
  });

  it('barriers are continuous', () => {
    const c = lap();
    const gaps: string[] = [];
    for (let i = 0; i < c.points.length - 1; i++) {
      const a = c.points[i];
      const b = c.points[i + 1];
      const na = frame(c, i).n;
      const nb = frame(c, i + 1).n;
      for (const side of [1, -1])
        for (let k = 0; k < 8; k++) {
          const u = k / 8;
          const off = ((side > 0 ? c.right[i] : c.left[i]) * (1 - u) + (side > 0 ? c.right[i + 1] : c.left[i + 1]) * u) - 1;
          const nx = na.x * (1 - u) + nb.x * u;
          const nz = na.z * (1 - u) + nb.z * u;
          const p = { x: a.x + (b.x - a.x) * u + nx * side * off, z: a.z + (b.z - a.z) * u + nz * side * off };
          const toi = cast({ x: p.x, y: groundHeightAt(zr, p) + 0.4, z: p.z }, { x: nx * side, z: nz * side }, 2.5);
          if (toi === null || toi > 1.4) gaps.push(`lap point ${i}.${k} side ${side}: ${toi}`);
        }
    }
    expect(gaps).toEqual([]);
  }, 120_000);
  it('nothing is pushed through a barrier or a mouth wall', () => {
    const c = lap();
    const n = c.points.length - 1;
    const inside = courseInside(c, 0.1);
    const balls: { body: RAPIER.RigidBody; side: number; i: number; start: Vec2 }[] = [];
    // Dynamic balls hit each barrier from the course side every 6 m, both sides (mouth walls are the barrier there), 12 m/s; they touch only the static world.
    for (let i = 0; i < n; i += 3)
      for (const side of [1, -1]) {
        const { n: nn } = frame(c, i);
        const at = (side > 0 ? c.right[i] : c.left[i]) - 0.8;
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(c.points[i].x + nn.x * side * at, groundHeightAt(zr, c.points[i]) + 0.55, c.points[i].z + nn.z * side * at).setLinvel(nn.x * side * 12, 0, nn.z * side * 12),
        );
        world.createCollider(RAPIER.ColliderDesc.ball(0.3).setRestitution(0).setCollisionGroups(groups(0x0100, GROUP.STATIC) >>> 0), body);
        balls.push({ body, side, i, start: { x: c.points[i].x + nn.x * side * at, z: c.points[i].z + nn.z * side * at } });
      }
    for (let k = 0; k < 90; k++) world.step();
    // (A start spot the course polygon does not cover, in a plaza's bulge where neighbouring points' offsets are small, says nothing.)
    const tested = balls.filter((b) => inside(b.start));
    expect(tested.length).toBeGreaterThan(balls.length * 0.9);
    // Past the wall = outside the course measured at the ball's own spot (a diagonal wall recedes along the lap: the nominal offset at the start is the wrong line).
    const out = tested.filter((b) => !inside(b.body.translation())).map((b) => `lap point ${b.i} side ${b.side}`);
    for (const b of balls) world.removeRigidBody(b.body);
    expect(out).toEqual([]);
  }, 120_000);
});
