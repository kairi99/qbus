import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CityData } from '../src/world/cityData';
import { terrainHeight } from '../src/world/terrain';
import { locateOnTrack, trackPoint } from '../src/world/track';
import {
  type BoulderPose,
  FALL,
  OPEN_MARGIN,
  OPEN_LANE,
  SLIDE_TRACKS,
  type SlideAdvice,
  WARN,
  boulderPose,
  mudAt,
  mudPatches,
  slideAdvice,
  slideField,
  slidePhase,
  slideSites,
} from '../src/gameplay/landslides';

const city: CityData = JSON.parse(readFileSync('data/cities/silante.json', 'utf8'));
const race = city.race!;
const terrain = city.terrain!;
const ground = (p: { x: number; z: number }) => terrainHeight(terrain, p.x, p.z);
const hw = race.width / 2;
const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);

describe('landslides on the Silante', () => {
  it('only the Silante has them', () => {
    expect(SLIDE_TRACKS.has('silante')).toBe(true);
    expect(SLIDE_TRACKS.has('papallacta')).toBe(false);
  });

  it('same seed, same slides; other seeds, other slides', () => {
    const a = JSON.stringify(slideSites(race, 7, ground));
    expect(JSON.stringify(slideSites(race, 7, ground))).toBe(a);
    expect(JSON.stringify(slideSites(race, 8, ground))).not.toBe(a);
    expect(JSON.stringify(slideSites(race, 9, ground))).not.toBe(a);
  });

  it('gives 4 sites on a 5 km race, spread one per segment, away from start, finish, pickups and tight bends', () => {
    for (const seed of SEEDS) {
      const sites = slideSites(race, seed, ground);
      expect(sites.length).toBe(4);
      sites.forEach((site, i) => {
        expect(site.s).toBeGreaterThanOrEqual(race.start + 400);
        expect(site.s).toBeLessThanOrEqual(race.finish - 300);
        if (i) expect(site.s - sites[i - 1].s).toBeGreaterThan(300);
        for (const p of race.pickups) expect(Math.abs(p.s - site.s)).toBeGreaterThanOrEqual(60);
        expect(site.len).toBeGreaterThanOrEqual(30);
        expect(site.len).toBeLessThanOrEqual(60);
        expect(site.boulders.length).toBeGreaterThanOrEqual(4);
        expect(site.boulders.length).toBeLessThanOrEqual(7);
        expect(site.trigger).toBeGreaterThanOrEqual(8);
      });
    }
  });

  it('is always on the uphill side: the ground climbs at least 4 m within 12 m of the edge', () => {
    for (const seed of SEEDS.slice(0, 15))
      for (const site of slideSites(race, seed, ground)) {
        const q = trackPoint(race, site.s);
        const off = site.side * (hw + 12);
        const p = { x: q.x - q.dz * off, z: q.z + q.dx * off };
        expect(ground(p) - q.y).toBeGreaterThanOrEqual(4);
      }
  });

  it('boulders start up the slope on the ground and rest on the road, on the uphill half, never within 0.4 m of the middle', () => {
    const pose: BoulderPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    for (const seed of SEEDS)
      for (const site of slideSites(race, seed, ground))
        site.boulders.forEach((b, k) => {
          expect(b.r).toBeGreaterThanOrEqual(0.7);
          expect(b.r).toBeLessThanOrEqual(1.7);
          const start = locateOnTrack(race, b.start);
          expect(start.off * site.side).toBeGreaterThan(hw + 9);
          expect(b.start.y).toBeCloseTo(Math.max(ground(b.start), trackPoint(race, start.s).y) + 0.9 * b.r, 1);
          const rest = locateOnTrack(race, b.rest);
          expect(rest.off * site.side - b.r).toBeGreaterThanOrEqual(OPEN_MARGIN - 0.02);
          expect(rest.y + 0.9 * b.r).toBeCloseTo(b.rest.y, 1);
          // The open half stays free for the whole fall, not only at rest.
          for (let t = site.trigger; t <= site.trigger + WARN + FALL + 1; t += 0.05) {
            boulderPose(race, site, k, t, pose);
            const at = locateOnTrack(race, pose);
            expect(at.off * site.side - b.r).toBeGreaterThanOrEqual(OPEN_MARGIN - 0.25);
          }
        });
  });

  it('the open half has room for a bus: the free lane is wider than 3.2 m (the biggest vehicles are 2.6 m)', () => {
    for (const seed of SEEDS)
      for (const site of slideSites(race, seed, ground)) {
        const innermost = Math.min(...site.boulders.map((b) => locateOnTrack(race, b.rest).off * site.side - b.r));
        expect(innermost + hw).toBeGreaterThan(3.2);
      }
  });

  it('phases: idle, warning 4 s, falling 2 s, then settled', () => {
    const site = slideSites(race, 3, ground)[0];
    expect(slidePhase(site, site.trigger - 0.01)).toBe('idle');
    expect(slidePhase(site, site.trigger)).toBe('warning');
    expect(slidePhase(site, site.trigger + WARN - 0.01)).toBe('warning');
    expect(slidePhase(site, site.trigger + WARN)).toBe('falling');
    expect(slidePhase(site, site.trigger + WARN + FALL - 0.01)).toBe('falling');
    expect(slidePhase(site, site.trigger + WARN + FALL)).toBe('settled');
    expect(slidePhase(site, 1e6)).toBe('settled');
  });

  it('boulders sit still before the fall, land exactly on the rest pose, and move without jumps in between', () => {
    const site = slideSites(race, 5, ground)[1];
    const a: BoulderPose = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
    const b = { ...a };
    site.boulders.forEach((bd, k) => {
      boulderPose(race, site, k, site.trigger + WARN, a);
      expect([a.x, a.y, a.z]).toEqual([bd.start.x, bd.start.y, bd.start.z]);
      boulderPose(race, site, k, 0, a);
      expect([a.x, a.y, a.z]).toEqual([bd.start.x, bd.start.y, bd.start.z]);
      boulderPose(race, site, k, site.trigger + WARN + FALL, a);
      expect([a.x, a.y, a.z]).toEqual([bd.rest.x, bd.rest.y, bd.rest.z]);
      boulderPose(race, site, k, site.trigger + WARN + FALL + 50, a);
      expect([a.x, a.y, a.z]).toEqual([bd.rest.x, bd.rest.y, bd.rest.z]);
      // 1/60 s steps: at most a couple of meters (it falls ~15 m in under 2 s), never a jump.
      let prev = boulderPose(race, site, k, site.trigger + WARN - 0.1, a);
      let px = prev.x, py = prev.y, pz = prev.z;
      for (let t = site.trigger + WARN; t <= site.trigger + WARN + FALL + 0.2; t += 1 / 60) {
        boulderPose(race, site, k, t, b);
        expect(Math.hypot(b.x - px, b.y - py, b.z - pz)).toBeLessThan(1.2);
        expect(Math.hypot(b.qx, b.qy, b.qz, b.qw)).toBeCloseTo(1, 5);
        [px, py, pz] = [b.x, b.y, b.z];
      }
    });
  });

  it('mud: none before the fall, grows over it, full when settled, only on the uphill half (a little spill over the middle)', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const field = slideField(race, seed, ground);
      for (const site of field.sites) {
        const uphill = site.side * 2.5;
        expect(mudAt({ sites: [site], patches: [] }, site.trigger + WARN - 0.01, site.s, uphill)).toBe(0);
        const mid = mudAt({ sites: [site], patches: [] }, site.trigger + WARN + FALL / 2, site.s, uphill);
        const done = mudAt({ sites: [site], patches: [] }, site.trigger + WARN + FALL + 5, site.s, uphill);
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(done);
        expect(done).toBeCloseTo(1, 1);
        // The open half: clean from 1.5 m past the middle.
        for (let d = -site.len / 2; d <= site.len / 2; d += 2) expect(mudAt({ sites: [site], patches: [] }, 1e6, site.s + d, -site.side * 1.6)).toBe(0);
        // Beyond the tongue's ends.
        expect(mudAt({ sites: [site], patches: [] }, 1e6, site.s + site.len / 2 + 4, uphill)).toBe(0);
      }
    }
  });

  it('always-there mud sits only where a river crosses the road: none on the Silante (its streams run off), one on a track a stream crosses', () => {
    expect(mudPatches(race)).toEqual([]);
    const c = trackPoint(race, 1500);
    const river = { points: [{ x: c.x - c.dz * -40, z: c.z + c.dx * -40 }, { x: c.x - c.dz * 40, z: c.z + c.dx * 40 }], y: [0, 0], width: 3 };
    const crossed = { ...race, scenery: { ...race.scenery!, rivers: [river] } };
    const patches = mudPatches(crossed);
    expect(patches.length).toBe(1);
    const p = patches[0];
    expect(p.s).toBeCloseTo(1500, 0);
    expect(p.level).toBe(0.5);
    expect(mudAt({ sites: [], patches }, 0, p.s, 0)).toBeCloseTo(0.5, 5);
    expect(mudAt({ sites: [], patches }, 0, p.s, 3)).toBeCloseTo(0.5, 5);
    expect(mudAt({ sites: [], patches }, 0, p.s + 40, 0)).toBe(0);
    expect(mudAt({ sites: [], patches }, 0, p.s, 0, 1)).toBeGreaterThan(0.5);
  });

  it('advice: nothing while idle, the open lane and a brake-in-time speed once it warns', () => {
    const site = slideSites(race, 11, ground)[0];
    const out: SlideAdvice = { lane: 0, s0: 0, limit: 0, landed: false, ramp: 0 };
    slideAdvice([site], site.trigger - 1, site.s - 60, 12, 4, out);
    expect(out.lane).toBeNaN();
    slideAdvice([site], site.trigger + 1, site.s - 100, 12, 4, out);
    expect(out.lane).toBe(-site.side * OPEN_LANE);
    expect(out.landed).toBe(false);
    expect(out.limit).toBeGreaterThan(18);
    slideAdvice([site], site.trigger + 10, site.s - 200, 12, 4, out);
    expect(out.lane).toBeNaN();
    slideAdvice([site], site.trigger + 10, site.s, 12, 4, out);
    expect(out.landed).toBe(true);
    expect(out.limit).toBeCloseTo(18, 5);
    slideAdvice([site], site.trigger + 10, site.s + site.len / 2 + 40, 12, 4, out);
    expect(out.lane).toBeNaN();
  });
});
