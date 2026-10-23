import { describe, expect, it } from 'vitest';
import { OFFROAD_COUNT, OFFROAD_GRACE, OFFROAD_MARGIN, OffRoad } from '../src/gameplay/offRoad';

const on = { edge: -2, s: 100, off: 2, wheels: 4, active: true };
const off = { edge: OFFROAD_MARGIN + 3, s: 130, off: -9, wheels: 4, active: true };

function run(o: OffRoad, f: typeof on, secs: number): string | null {
  let ev: string | null = null;
  for (let t = 0; t < secs - 1e-9; t += 0.1) ev = o.update(0.1, f) ?? ev;
  return ev;
}

describe('OffRoad', () => {
  it('shoulder and road never count', () => {
    const o = new OffRoad();
    expect(run(o, { ...on, edge: OFFROAD_MARGIN }, 30)).toBeNull();
    expect(o.countdown).toBe(0);
  });

  it('starts the countdown after the grace, expires once at the departure point', () => {
    const o = new OffRoad();
    run(o, on, 1);
    run(o, off, OFFROAD_GRACE - 0.3);
    expect(o.countdown).toBe(0);
    run(o, off, 0.5);
    expect(o.countdown).toBeGreaterThan(OFFROAD_COUNT - 0.6);
    expect(run(o, off, OFFROAD_COUNT)).toBe('expired');
    expect(o.departS).toBe(100);
    expect(o.side).toBe(1);
    expect(run(o, off, 0.1)).toBeNull();
  });

  it('back on the road cancels and re-arms the grace', () => {
    const o = new OffRoad();
    run(o, off, OFFROAD_GRACE + 1);
    expect(o.countdown).toBeGreaterThan(0);
    run(o, on, 0.1);
    expect(o.countdown).toBe(0);
    run(o, off, OFFROAD_GRACE - 0.3);
    expect(o.countdown).toBe(0);
  });

  it('is idle when inactive (grid, reset wait, fall) and while airborne', () => {
    const o = new OffRoad();
    run(o, { ...off, active: false }, 20);
    expect(o.countdown).toBe(0);
    run(o, { ...off, wheels: 0 }, 20);
    expect(o.countdown).toBe(0);
  });
});
