import { describe, expect, it } from 'vitest';
import { SpectatorCycle, type Watchable } from '../src/gameplay/spectator';

const w = (racer: number, place: number, racing = true): Watchable => ({ racer, place, racing });

describe('SpectatorCycle', () => {
  it('first update picks the racing one with the best place', () => {
    const c = new SpectatorCycle();
    c.update([w(1, 3), w(2, 2), w(3, 1, false), w(4, 5)]);
    expect(c.target).toBe(2);
  });

  it('step wraps in place order', () => {
    const c = new SpectatorCycle();
    c.update([w(1, 3), w(2, 2), w(4, 5)]);
    c.step(1);
    expect(c.target).toBe(1);
    c.step(1);
    expect(c.target).toBe(4);
    c.step(1);
    expect(c.target).toBe(2);
    c.step(-1);
    expect(c.target).toBe(4);
  });

  it('the target finishing moves to the next place, else the one above', () => {
    const c = new SpectatorCycle();
    c.update([w(1, 2), w(2, 3), w(3, 4)]);
    expect(c.target).toBe(1);
    c.update([w(1, 2, false), w(2, 3), w(3, 4)]);
    expect(c.target).toBe(2);
    c.update([w(1, 2, false), w(2, 3, false), w(3, 4)]);
    expect(c.target).toBe(3);
    c.update([w(1, 2), w(2, 3), w(3, 4, false)]);
    expect(c.target).toBe(2);
  });

  it('keeps the target while it still races', () => {
    const c = new SpectatorCycle();
    c.update([w(1, 2), w(2, 3)]);
    c.step(1);
    c.update([w(2, 2), w(1, 3)]);
    expect(c.target).toBe(2);
  });

  it('an empty list gives null', () => {
    const c = new SpectatorCycle();
    c.update([w(1, 2)]);
    c.update([]);
    expect(c.target).toBeNull();
    c.update([w(1, 2, false)]);
    expect(c.target).toBeNull();
  });

  it('a racer gone from the list is never kept', () => {
    const c = new SpectatorCycle();
    c.update([w(1, 2), w(5, 3), w(6, 4)]);
    c.step(1);
    expect(c.target).toBe(5);
    c.update([w(1, 2), w(6, 4)]);
    expect(c.target).toBe(1);
  });
});
