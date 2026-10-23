import { describe, expect, it } from 'vitest';
import { CLEAN_TIME, FILL_TIME, TIRE_SHARE, TireMud } from '../src/gameplay/tireMud';
import { mudGrip } from '../src/gameplay/landslides';

describe('TireMud', () => {
  it('cakes in deep mud, more slowly in a thin patch', () => {
    const deep = new TireMud();
    deep.step(1, FILL_TIME / 2);
    expect(deep.level).toBeCloseTo(0.5);
    const thin = new TireMud();
    thin.step(0.5, FILL_TIME / 2);
    expect(thin.level).toBeCloseTo(0.25);
    deep.step(1, 10);
    expect(deep.level).toBe(1);
  });

  it('wears off over CLEAN_TIME on the road and the warning goes with it', () => {
    const t = new TireMud();
    t.step(1, 10);
    expect(t.visible).toBe(true);
    t.step(0, CLEAN_TIME / 2);
    expect(t.level).toBeCloseTo(0.5);
    t.step(0, CLEAN_TIME / 2);
    expect(t.level).toBe(0);
    expect(t.visible).toBe(false);
  });

  it('caked tires lose only part of what deep mud takes, never more', () => {
    const t = new TireMud();
    t.step(1, 10);
    const clean = mudGrip(0, 0);
    const caked = mudGrip(t.effective, 0.5);
    const mud = mudGrip(1, 0.5);
    expect(caked).toBeLessThan(clean);
    expect(caked).toBeGreaterThan(mud);
    expect(t.effective).toBe(TIRE_SHARE);
  });

  it('reset cleans at once', () => {
    const t = new TireMud();
    t.step(1, 10);
    t.reset();
    expect(t.level).toBe(0);
  });
});
