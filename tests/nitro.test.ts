import { describe, expect, it } from 'vitest';
import { Nitro, NITRO_DURATION } from '../src/gameplay/nitro';

const DT = 1 / 60;

describe('Nitro', () => {
  it('starts full and a full tank lasts about 1.5 s', () => {
    const n = new Nitro();
    expect(n.level).toBe(1);
    let t = 0;
    while (n.step(true, DT)) t += DT;
    expect(t).toBeCloseTo(NITRO_DURATION, 1);
    expect(n.level).toBe(0);
  });

  it('does nothing when not held, and never refills on its own', () => {
    const n = new Nitro();
    for (let i = 0; i < 30; i++) n.step(true, DT);
    const left = n.level;
    for (let i = 0; i < 600; i++) expect(n.step(false, DT)).toBe(false);
    expect(n.level).toBe(left);
  });

  it('refills by drifting, close calls and red lights, up to full', () => {
    const n = new Nitro();
    while (n.step(true, DT));
    for (let i = 0; i < 60; i++) n.drifting(DT);
    expect(n.level).toBeCloseTo(0.2, 2);
    n.nearMiss();
    expect(n.level).toBeCloseTo(0.4, 2);
    n.redLight();
    expect(n.level).toBeCloseTo(0.65, 2);
    n.nearMiss(10);
    expect(n.level).toBe(1);
  });

  it('needs half a tank to start a burst, but a burst runs until empty', () => {
    const n = new Nitro();
    n.level = 0.49;
    expect(n.step(true, DT)).toBe(false);
    n.level = 0.5;
    expect(n.step(true, DT)).toBe(true);
    // Held on: it keeps burning below half.
    while (n.step(true, DT));
    expect(n.level).toBe(0);
    // Released and refilled to under half: still can't fire.
    n.step(false, DT);
    n.nearMiss(2);
    expect(n.step(true, DT)).toBe(false);
    n.nearMiss();
    expect(n.step(true, DT)).toBe(true);
  });
});
