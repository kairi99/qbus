import { describe, expect, it } from 'vitest';
import { DRAFT_RANGE, draftOf, Slipstream } from '../src/gameplay/slipstream';

const fast = 90 / 3.6;
const user = (s: number, off = 0, v = fast, len = 12) => ({ s, off, v, len });

describe('slipstream', () => {
  it('pulls harder closer behind, none alongside, ahead or out of range', () => {
    const me = user(100);
    const near = draftOf(me, [me, user(100 + 12 + 5)]);
    const far = draftOf(me, [me, user(100 + 12 + 25)]);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(draftOf(me, [me, user(100 + 12 + DRAFT_RANGE + 1)])).toBe(0);
    // Overlapping (side by side) or behind us: no pull.
    expect(draftOf(me, [me, user(105)])).toBe(0);
    expect(draftOf(me, [me, user(80)])).toBe(0);
    // In the other lane: none.
    expect(draftOf(me, [me, user(120, 3.5)])).toBe(0);
  });

  it('needs speed from both', () => {
    expect(draftOf(user(100, 0, 20 / 3.6), [user(120)])).toBe(0);
    expect(draftOf(user(100), [user(120, 0, 20 / 3.6)])).toBe(0);
  });

  it('builds up, then fades faster', () => {
    const sl = new Slipstream();
    sl.step(1, 0.4);
    expect(sl.level).toBeGreaterThan(0.3);
    expect(sl.level).toBeLessThan(0.7);
    for (let i = 0; i < 20; i++) sl.step(1, 0.1);
    expect(sl.level).toBe(1);
    sl.step(0, 0.2);
    expect(sl.level).toBeLessThan(0.5);
  });
});
