import { beforeAll, describe, expect, it } from 'vitest';
import { GHOST_MAX, GHOST_OPACITY, GHOST_TIME, Ghost } from '../src/gameplay/ghost';
import { PHYSICS_STEP, addGround, createWorld, initRapier } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { RemoteBus } from '../src/net/remoteBus';
import { carState, newPose } from '../src/net/snapshots';
import { parseC2S, type CarState } from '../src/net/protocol';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';
import gusanito from '../data/buses/gusanito.json';

describe('Ghost', () => {
  it('lasts its time, then is solid', () => {
    const g = new Ghost();
    expect(g.active).toBe(false);
    expect(g.fade).toBe(1);
    expect(g.update(1, false)).toBe('solid');
    g.start(2);
    expect(g.active).toBe(true);
    expect(g.update(1, false)).toBe('ghost');
    expect(g.update(0.9, false)).toBe('ghost');
    expect(g.update(0.2, false)).toBe('solid');
    expect(g.active).toBe(false);
    expect(g.fade).toBe(1);
  });

  it('is prolonged while blocked, and asks for a relocation once past GHOST_MAX', () => {
    const g = new Ghost();
    g.start(GHOST_TIME);
    expect(g.update(GHOST_TIME, true)).toBe('ghost');
    let asked = 0;
    for (let t = 0; t < GHOST_MAX + 2; t += 0.5) {
      const e = g.update(0.5, true);
      if (e === 'relocate') asked++;
      else if (!asked) expect(e).toBe('ghost');
    }
    expect(asked).toBe(1);
    expect(g.active).toBe(false);
    // Free before the cap: solid at once, and the blocked test only runs when the time is up.
    g.start(1);
    let calls = 0;
    expect(g.update(0.5, () => (calls++, true))).toBe('ghost');
    expect(calls).toBe(0);
    g.update(0.5, () => true);
    expect(g.update(0.1, () => false)).toBe('solid');
  });

  it('fades between 0.35 and 1, blinking only in the last second', () => {
    const g = new Ghost();
    g.start(5);
    g.update(1, false);
    expect(g.fade).toBe(GHOST_OPACITY);
    const seen = new Set<number>();
    for (let t = 0; t < 3.9; t += 0.02) {
      g.update(0.02, false);
      if (g.active) {
        expect(g.fade).toBeGreaterThanOrEqual(GHOST_OPACITY);
        expect(g.fade).toBeLessThan(1);
      }
      seen.add(Math.round(g.fade * 100));
    }
    expect(seen.size).toBeGreaterThan(5);
    g.reset();
    expect(g.fade).toBe(1);
  });
});

describe('ghost physics', () => {
  beforeAll(() => initRapier());
  const world = () => {
    const w = createWorld();
    addGround(w, 500);
    return w;
  };
  const settle = (w: ReturnType<typeof createWorld>, buses: BusPhysics[], seconds: number) => {
    for (let t = 0; t < seconds; t += PHYSICS_STEP) {
      for (const b of buses) b.update({ throttle: 0, steer: 0, handbrake: true }, PHYSICS_STEP);
      w.step();
    }
  };

  it('a ghost overlapping a parked bus neither pushes it nor is pushed, and stays on the ground', () => {
    const w = world();
    const parked = new BusPhysics(w, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    settle(w, [parked], 2);
    const before = parked.body.translation();
    const ghost = new BusPhysics(w, popular as BusPreset, { x: 0, y: 1, z: 0.8, heading: 0 });
    ghost.setGhost(true);
    expect(ghost.ghost).toBe(true);
    w.step();
    expect(ghost.overlapsOthers(w)).toBe(true);
    // A ghost isn't something a solid vehicle overlaps.
    expect(parked.overlapsOthers(w)).toBe(false);
    settle(w, [parked, ghost], 2);
    const after = parked.body.translation();
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.05);
    const g = ghost.body.translation();
    expect(Math.abs(g.z - 0.8)).toBeLessThan(0.1);
    expect(g.y).toBeGreaterThan(popular.body.height / 2 - 0.2);
    expect(g.y).toBeLessThan(popular.body.height / 2 + 1.5);
    expect(ghost.wheelsOnGround).toBe(ghost.wheelCount);
    // Solid again: pushed apart.
    ghost.setGhost(false);
    expect(parked.overlapsOthers(w)).toBe(true);
    settle(w, [parked, ghost], 3);
    expect(Math.abs(ghost.body.translation().z - parked.body.translation().z)).toBeGreaterThan(popular.body.width * 0.9);
    settle(w, [parked, ghost], 3);
    expect(parked.overlapsOthers(w)).toBe(false);
  });

  it('setGhost(false) restores the exact groups: plain, remote and train', () => {
    const w = world();
    const plain = new BusPhysics(w, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    const train = new BusPhysics(w, gusanito as BusPreset, { x: 0, y: 1, z: 20, heading: 0 });
    const remote = new RemoteBus(w, popular as BusPreset, { x: 0, y: 1, z: 40, heading: 0 });
    for (const b of [plain, train, remote.bus]) {
      const before = b.colliders.map((c) => c.collisionGroups());
      b.setGhost(true);
      expect(b.colliders.map((c) => c.collisionGroups())).not.toEqual(before);
      b.setGhost(true);
      b.setGhost(false);
      expect(b.ghost).toBe(false);
      expect(b.colliders.map((c) => c.collisionGroups())).toEqual(before);
    }
    expect(train.colliders.length).toBeGreaterThan(1);
  });

  it('overlapsOthers sees vehicles but not the ground', () => {
    const w = world();
    const a = new BusPhysics(w, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    expect(a.overlapsOthers(w)).toBe(false);
    const b = new BusPhysics(w, popular as BusPreset, { x: 3, y: 1, z: 0, heading: 0 });
    w.step();
    expect(a.overlapsOthers(w)).toBe(true);
    expect(b.overlapsOthers(w)).toBe(true);
    b.reset({ x: 40, y: 1, z: 0, heading: 0 });
    w.step();
    expect(a.overlapsOthers(w)).toBe(false);
  });

  it('a remote ghost is carried by snapshots and passes through a local bus', () => {
    const w = world();
    const local = new BusPhysics(w, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    settle(w, [local], 1.5);
    const remote = new RemoteBus(w, popular as BusPreset, { x: 30, y: 1, z: 0, heading: 0 });
    const src = new BusPhysics(w, popular as BusPreset, { x: 100, y: 1, z: 0, heading: 0 });
    src.setGhost(true);
    const st = carState(src, { seat: 1 }, 0, 0);
    expect(st.g).toBe(1);
    src.setGhost(false);
    expect(carState(src, { seat: 1 }, 0, 0, st).g).toBeUndefined();
    const lt = local.body.translation();
    const at = (g: boolean): CarState => ({ ...st, p: [lt.x, lt.y, lt.z], v: [0, 0, 0], ...(g ? { g: 1 as const } : { g: undefined }) });
    remote.push(1000, at(true));
    remote.push(1100, at(true));
    remote.apply(1200 + 100, 0.016);
    expect(remote.ghost).toBe(true);
    expect(remote.bus.ghost).toBe(true);
    const before = local.body.translation();
    settle(w, [local], 1);
    const after = local.body.translation();
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.05);
    remote.push(1300, at(false));
    remote.apply(1500, 0.016);
    expect(remote.bus.ghost).toBe(false);
    const pose = newPose();
    expect(pose.ghost).toBe(false);
  });
});

describe('protocol: ghost flag', () => {
  const car = { who: { seat: 0 }, s: 0, p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], steer: 0, speed: 0, thr: 0, boost: 0 };
  const parse = (extra: object) => parseC2S(JSON.stringify({ t: 'st', at: 1, cars: [{ ...car, ...extra }] }));
  it('accepts g absent, 0 or 1, keeps 1, rejects junk', () => {
    expect(parse({})).not.toBeNull();
    expect(parse({ g: 0 })).not.toBeNull();
    const m = parse({ g: 1 });
    expect(m && m.t === 'st' && m.cars[0].g).toBe(1);
    for (const g of [2, '1', true, null, -1]) expect(parse({ g })).toBeNull();
  });
});
