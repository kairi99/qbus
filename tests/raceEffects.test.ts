import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TireSmoke, dustOf, smokeOf } from '../src/vehicle/tireSmoke';
import { crowdSpots } from '../src/world/spectators';
import { finishCamera } from '../src/gameplay/raceSession';
import { locateOnTrack, trackPoint } from '../src/world/track';
import type { TrackData } from '../src/world/track';

/** A straight 600 m test track on flat ground, 8 m wide. */
const straight: TrackData = {
  from: 'A',
  to: 'B',
  points: Array.from({ length: 61 }, (_, i) => ({ x: i * 10, z: 0 })),
  y: new Array(61).fill(0),
  cum: Array.from({ length: 61 }, (_, i) => i * 10),
  width: 8,
  start: 100,
  finish: 500,
  rails: [],
  drops: [],
  pickups: [],
};

describe('tire smoke and dust', () => {
  it('smoke only once the tires slide well past a normal turn, or spin at the launch', () => {
    expect(smokeOf((5 * Math.PI) / 180, 20, 0)).toBe(0);
    expect(smokeOf((25 * Math.PI) / 180, 20, 0)).toBeGreaterThan(0.5);
    expect(smokeOf((-35 * Math.PI) / 180, 20, 0)).toBe(1);
    // Sliding at a walk: nothing much.
    expect(smokeOf((30 * Math.PI) / 180, 1, 0)).toBeLessThan(0.2);
    expect(smokeOf(0, 0, 1)).toBe(1);
  });

  it('dust only off the asphalt and moving', () => {
    expect(dustOf(-1, 20)).toBe(0);
    expect(dustOf(1, 1)).toBe(0);
    expect(dustOf(1, 20)).toBe(1);
  });

  it('puffs fade and are gone a few seconds later', () => {
    const scene = new THREE.Scene();
    const smoke = new TireSmoke(scene);
    const bus = {
      preset: { wheels: { rearOffset: -2, track: 1 } },
      body: { translation: () => ({ x: 0, y: 1, z: 0 }), linvel: () => ({ x: 10, y: 0, z: 0 }) },
      heading: 0,
      roadHeight: () => 0,
    } as never;
    for (let i = 0; i < 30; i++) {
      smoke.emit(bus, 1, 0, 1 / 30);
      smoke.update(1 / 30);
    }
    expect(smoke.mesh.visible).toBe(true);
    for (let i = 0; i < 200; i++) smoke.update(1 / 30);
    expect(smoke.mesh.visible).toBe(false);
  });
});

describe('the crowd', () => {
  it('stands both sides of the road, off the asphalt and short of the trees', () => {
    const fans = crowdSpots(straight, 50, 120, () => 0);
    expect(fans.length).toBeGreaterThan(40);
    const offs = fans.map((f) => locateOnTrack(straight, f).off);
    expect(offs.some((o) => o > 0) && offs.some((o) => o < 0)).toBe(true);
    for (const o of offs) {
      expect(Math.abs(o)).toBeGreaterThan(straight.width / 2 + 1.5);
      expect(Math.abs(o)).toBeLessThan(straight.width / 2 + 3.5);
    }
    // Facing the road.
    for (const f of fans) expect(Math.sign(f.fz)).toBe(-Math.sign(f.z));
  });

  it('never over a drop or up a cut', () => {
    // Right of the road (+z) the ground falls 10 m away; left of it, level.
    const fans = crowdSpots(straight, 50, 120, (p) => (p.z > 0 ? -10 : 0));
    expect(fans.length).toBeGreaterThan(10);
    for (const f of fans) expect(f.z).toBeLessThan(0);
  });
});

describe('the finish camera', () => {
  it('stands past the line beside the road, on the low side', () => {
    const cam = finishCamera(straight, (p) => (p.z > 0 ? -6 : 3));
    const at = locateOnTrack(straight, cam);
    expect(at.s).toBeGreaterThan(straight.finish);
    expect(at.off).toBeGreaterThan(straight.width / 2);
    // Over the road's height, so it looks over the line.
    expect(cam.y).toBeGreaterThan(trackPoint(straight, at.s).y + 1.5);
  });
});
