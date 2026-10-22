import { beforeAll, describe, expect, it } from 'vitest';
import { addGround, createWorld, initRapier, PHYSICS_STEP, GROUP, groups } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { RemoteBus } from '../src/net/remoteBus';
import { MAX_EXTRAPOLATE, RENDER_DELAY, SNAP_DIST, SnapshotBuffer, carState, newPose } from '../src/net/snapshots';
import type { CarState } from '../src/net/protocol';
import type { BusPreset } from '../src/vehicle/busPreset';
import popular from '../data/buses/popular.json';
import articulado from '../data/buses/articulado.json';
import gusanito from '../data/buses/gusanito.json';

const car = (x: number, o: Partial<CarState> = {}): CarState => ({ who: { seat: 0 }, s: x, p: [x, 0, 0], q: [0, 0, 0, 1], v: [10, 0, 0], steer: 0, speed: 10, thr: 1, boost: 0, ...o });

describe('SnapshotBuffer', () => {
  it('interpolates, holds, extrapolates and snaps', () => {
    const b = new SnapshotBuffer();
    const out = newPose();
    expect(b.sample(0, out)).toBe(false);
    b.push(1000, car(0, { steer: 0 }));
    b.push(1100, car(1, { steer: 0.2 }));
    expect(b.sample(1050, out)).toBe(true);
    expect(out.p[0]).toBeCloseTo(0.5);
    expect(out.steer).toBeCloseTo(0.1);
    b.sample(500, out);
    expect(out.p[0]).toBe(0);
    // extrapolation by v for up to MAX_EXTRAPOLATE, then hold
    b.sample(1100 + 100, out);
    expect(out.p[0]).toBeCloseTo(1 + 10 * 0.1);
    b.sample(1100 + 5000, out);
    expect(out.p[0]).toBeCloseTo(1 + 10 * (MAX_EXTRAPOLATE / 1000));
    // out-of-order and duplicates dropped
    expect(b.push(1100, car(9))).toBe(false);
    expect(b.push(1050, car(9))).toBe(false);
    expect(b.length).toBe(2);
    // snap
    b.push(1200, car(1 + SNAP_DIST + 5));
    b.sample(1150, out);
    expect(out.snapped).toBe(true);
    expect(out.p[0]).toBeCloseTo(16);
    b.sample(1050, out);
    expect(out.snapped).toBe(false);
  });

  it('takes the shortest quaternion path and reuses out', () => {
    const b = new SnapshotBuffer();
    const a = Math.PI / 8;
    b.push(0, car(0, { q: [0, Math.sin(a), 0, Math.cos(a)] }));
    b.push(100, car(0, { q: [0, -Math.sin(a), 0, -Math.cos(a)] })); // same rotation negated... 
    const out = newPose();
    const p = out.p;
    b.sample(50, out);
    expect(out.p).toBe(p);
    expect(Math.hypot(...out.q)).toBeCloseTo(1);
    expect(Math.abs(out.q[3])).toBeCloseTo(Math.cos(a)); // not collapsing through zero
  });

  it('interpolates rears and wraps the ring', () => {
    const b = new SnapshotBuffer();
    for (let i = 0; i < 40; i++) b.push(i * 66, car(i, { rears: [[i - 5, 0, 0, 0, 0, 0, 1]] }));
    expect(b.length).toBe(16);
    const out = newPose();
    b.sample(39 * 66 - 33, out);
    expect(out.p[0]).toBeCloseTo(38.5);
    expect(out.rears[0][0]).toBeCloseTo(33.5);
    const r = out.rears[0];
    b.sample(39 * 66 - 40, out);
    expect(out.rears[0]).toBe(r);
  });
});

describe('physics', () => {
  beforeAll(() => initRapier());

  it('carState rounds and reads rears from an articulated bus', () => {
    const world = createWorld();
    addGround(world, 200);
    const bus = new BusPhysics(world, articulado as BusPreset, { x: 1.23456, y: 2, z: 3, heading: 0.3 });
    const c = carState(bus, { seat: 1 }, 12.3456, 0.5);
    expect(c.p[0]).toBe(Math.round(bus.body.translation().x * 100) / 100);
    expect(String(c.q[0]).length).toBeLessThan(9);
    expect(c.rears).toHaveLength(1);
    expect(c.rears![0]).toHaveLength(7);
    expect(c.s).toBe(12.35);
    expect(c.boost).toBe(0);
    const popularBus = new BusPhysics(world, popular as BusPreset, { x: 50, y: 2, z: 0, heading: 0 });
    expect(carState(popularBus, { ai: 0 }, 0, 0).rears).toBeUndefined();
  });

  it('a remote bus shoves a parked local bus and follows its poses exactly', () => {
    const world = createWorld();
    addGround(world, 500);
    const local = new BusPhysics(world, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    for (let i = 0; i < 120; i++) { local.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP); world.step(); }
    const x0 = local.body.translation().x;
    const remote = new RemoteBus(world, popular as BusPreset, { x: -30, y: 1, z: 0, heading: 0 });
    const L = (popular as BusPreset).body.length;
    const y = remote.bus.body.translation().y;
    let t = 0;
    for (let i = 0; i < 300; i++) {
      t += 1000 / 60;
      remote.push(t, { ...car(0), p: [-30 + (i + 1) * 0.15, y, 0] });
      remote.apply(t + RENDER_DELAY, PHYSICS_STEP);
      local.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    expect(local.body.translation().x - x0).toBeGreaterThan(0.5);
    // follows snapshots (within the one-step lag of the interpolation)
    expect(remote.bus.body.translation().x).toBeGreaterThan(-30 + 299 * 0.15 - 0.2);
    expect(remote.bus.body.translation().y).toBeCloseTo(y, 3);
    expect(L).toBeGreaterThan(0);
  });

  it('remote buses ignore each other and static; wheel ray filter excludes REMOTE', () => {
    const world = createWorld();
    addGround(world, 500);
    const a = new RemoteBus(world, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    const b = new RemoteBus(world, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    const g = groups(GROUP.REMOTE, GROUP.ALL & ~GROUP.STATIC & ~GROUP.TRAFFIC & ~GROUP.REMOTE);
    expect(a.bus.body.collider(0).collisionGroups()).toBe(g);
    expect(a.bus.body.isKinematic()).toBe(true);
    for (let i = 0; i < 30; i++) world.step();
    let contacts = 0;
    world.contactPairsWith(a.bus.body.collider(0), () => contacts++);
    expect(contacts).toBe(0);
    // a local bus's wheel filter keeps REMOTE out
    const local = new BusPhysics(world, popular as BusPreset, { x: 20, y: 1, z: 0, heading: 0 }) as unknown as { wheelGroups: number };
    expect(local.wheelGroups & GROUP.REMOTE).toBe(0);
    const train = new BusPhysics(world, gusanito as BusPreset, { x: 60, y: 1, z: 0, heading: 0 }) as unknown as { wheelGroups: number };
    expect(train.wheelGroups & GROUP.REMOTE).toBe(0);
    b.dispose(world);
    a.dispose(world);
  });

  it('a local bus drives through under no remote roof: wheels ignore remote', () => {
    const world = createWorld();
    addGround(world, 500);
    const remote = new RemoteBus(world, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    // lift remote high; local drops below it: nothing to check but local reaches ground contact
    const local = new BusPhysics(world, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    remote.bus.setPose({ p: [0, 30, 0], q: [0, 0, 0, 1] });
    for (let i = 0; i < 120; i++) { local.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP); world.step(); }
    expect(local.wheelsOnGround).toBe(4);
  });

  it.each([['gusanito', gusanito], ['articulado', articulado]] as const)('remote %s keeps given poses (joints do not fight) and stays in line without rears', (_n, preset) => {
    const world = createWorld();
    addGround(world, 500);
    const r = new RemoteBus(world, preset as BusPreset, { x: 0, y: 1.5, z: 0, heading: 0 });
    const n = r.bus.rears.length;
    // pose along a curve: front heading 0.4, rears further bent
    const rears: number[][] = [];
    for (let i = 0; i < n; i++) {
      const h = 0.4 + 0.15 * (i + 1);
      rears.push([-8 * (i + 1), 1.5, 3 * (i + 1), 0, Math.sin(h / 2), 0, Math.cos(h / 2)]);
    }
    const front = { p: [0, 1.5, 0], q: [0, Math.sin(0.2), 0, Math.cos(0.2)] };
    r.bus.setPose(front, rears);
    for (let i = 0; i < 20; i++) world.step();
    for (let i = 0; i < n; i++) {
      const t = r.bus.rears[i].body.translation();
      expect(t.x).toBeCloseTo(rears[i][0], 3);
      expect(t.z).toBeCloseTo(rears[i][2], 3);
      expect(r.bus.rears[i].body.rotation().y).toBeCloseTo(rears[i][4], 3);
    }
    // rears missing: sections carried rigidly with the front
    const before = r.bus.rears.map((x) => x.body.translation());
    r.bus.setPose({ p: [20, 1.5, 5], q: [0, 0, 0, 1] });
    for (let i = 0; i < 5; i++) world.step();
    const f = r.bus.body.translation();
    expect(f.x).toBeCloseTo(20, 3);
    for (let i = 0; i < n; i++) {
      const t = r.bus.rears[i].body.translation();
      // distance from the front is preserved
      const d0 = Math.hypot(before[i].x - 0, before[i].z - 0);
      expect(Math.hypot(t.x - f.x, t.z - f.z)).toBeCloseTo(d0, 2);
    }
  });

  it('forceGhost keeps a remote a ghost against the snapshots; dispose twice is safe', () => {
    const world = createWorld();
    addGround(world, 500);
    const r = new RemoteBus(world, popular as BusPreset, { x: 0, y: 1, z: 0, heading: 0 });
    r.push(1000, car(0));
    r.apply(1000 + RENDER_DELAY, PHYSICS_STEP);
    expect(r.bus.ghost).toBe(false);
    r.forceGhost = true;
    r.apply(1000 + RENDER_DELAY, PHYSICS_STEP);
    expect(r.bus.ghost).toBe(true);
    expect(r.ghost).toBe(true);
    r.forceGhost = false;
    r.apply(1000 + RENDER_DELAY, PHYSICS_STEP);
    expect(r.bus.ghost).toBe(false);
    r.dispose(world);
    r.dispose(world);
    r.apply(2000, PHYSICS_STEP);
  });
});
