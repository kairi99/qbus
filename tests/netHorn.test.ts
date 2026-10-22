import { describe, expect, it } from 'vitest';
import { HORN_MIN, HornHold, HornLatch } from '../src/net/horn';
import { cleanCar, parseC2S, type CarState } from '../src/net/protocol';
import { SnapshotBuffer, newPose } from '../src/net/snapshots';

const car = (s: number, h?: 0 | 1): CarState => ({ who: { seat: 0 }, s, p: [s, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], steer: 0, speed: 0, thr: 0, boost: 0, ...(h !== undefined ? { h: h as 1 } : {}) });
const st = (c: unknown) => parseC2S(JSON.stringify({ t: 'st', at: 1, cars: [c] }));

describe('horn latch (sender)', () => {
  it('a tap between two snapshots still makes the next one true, then starts over', () => {
    const l = new HornLatch();
    expect(l.take()).toBe(false);
    l.feed(false);
    l.feed(true);
    l.feed(false);
    expect(l.take()).toBe(true);
    expect(l.take()).toBe(false);
  });

  it('a held horn is true at every snapshot, and false once released', () => {
    const l = new HornLatch();
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 4; k++) l.feed(true);
      expect(l.take()).toBe(true);
    }
    l.feed(false);
    expect(l.take()).toBe(false);
  });
});

describe('horn hold (receiver)', () => {
  it('a one-sample tap sounds for HORN_MIN, a held flag for as long as it is set', () => {
    const h = new HornHold();
    const dt = 1 / 60;
    expect(h.step(false, dt)).toBe(false);
    let t = 0;
    let on = h.step(true, dt);
    while (on && t < 2) {
      t += dt;
      on = h.step(false, dt);
    }
    expect(t).toBeGreaterThanOrEqual(HORN_MIN - 2 * dt);
    expect(t).toBeLessThan(HORN_MIN + 2 * dt);
    for (let i = 0; i < 120; i++) expect(h.step(true, dt)).toBe(true);
    for (let i = 0; i < 40; i++) h.step(false, dt);
    expect(h.step(false, dt)).toBe(false);
  });
});

describe('horn flag on the wire', () => {
  it('accepted with or without it, rejected when not 0/1, and kept by the relay clean-up', () => {
    const base = car(1);
    expect(st(base)).not.toBeNull();
    expect(st({ ...base, h: 1 })).not.toBeNull();
    expect(st({ ...base, h: 0 })).not.toBeNull();
    expect(st({ ...base, h: 2 })).toBeNull();
    expect(st({ ...base, h: 'x' })).toBeNull();
    expect(cleanCar(car(1, 1)).h).toBe(1);
    expect('h' in cleanCar(base)).toBe(false);
  });

  it('snapshots carry it to the sampled pose', () => {
    const b = new SnapshotBuffer();
    b.push(100, car(0));
    b.push(167, car(1, 1));
    b.push(233, car(2));
    const pose = newPose();
    b.sample(150, pose);
    expect(pose.horn).toBe(true);
    b.sample(220, pose);
    expect(pose.horn).toBe(false);
    b.sample(100, pose);
    expect(pose.horn).toBe(false);
  });
});
