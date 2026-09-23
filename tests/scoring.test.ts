import { describe, expect, it } from 'vitest';
import { TrickScorer, type Telemetry, type TrickEvent, COMBO_WINDOW } from '../src/gameplay/scoring';

const DT = 1 / 60;
const kmh = (v: number) => v / 3.6;
const base: Telemetry = { dt: DT, speed: kmh(50), slipAngle: 0, airborne: false, nearMisses: 0, propsKnocked: 0 };

function run(s: TrickScorer, t: Partial<Telemetry>, seconds: number): TrickEvent[] {
  const out: TrickEvent[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) out.push(...s.update({ ...base, ...t }));
  return out;
}

describe('TrickScorer', () => {
  it('awards nothing for plain driving', () => {
    const s = new TrickScorer();
    expect(run(s, {}, 5)).toEqual([]);
  });

  it('awards a drift when the slide ends, scaled by its length', () => {
    const short = new TrickScorer();
    const long = new TrickScorer();
    const slide = { slipAngle: 0.5 };
    expect(run(short, slide, 1)).toEqual([]); // nothing while still sliding
    const a = run(short, {}, 1).find((e) => e.kind === 'drift')!;
    run(long, slide, 3);
    const b = run(long, {}, 1).find((e) => e.kind === 'drift')!;
    expect(a.cents).toBeGreaterThan(0);
    expect(b.cents).toBeGreaterThan(a.cents * 2);
  });

  it('ignores tiny wiggles and slow-speed slides', () => {
    const s = new TrickScorer();
    run(s, { slipAngle: 0.5 }, 0.2);
    expect(run(s, {}, 1)).toEqual([]);
    run(s, { slipAngle: 0.8, speed: kmh(8) }, 2);
    expect(run(s, {}, 1)).toEqual([]);
  });

  it('awards airtime on landing', () => {
    const s = new TrickScorer();
    expect(run(s, { airborne: true }, 0.8)).toEqual([]);
    const [e] = run(s, {}, 0.1);
    expect(e.kind).toBe('air');
    expect(e.cents).toBeGreaterThan(0);
  });

  it('awards near misses and knocked props per event', () => {
    const s = new TrickScorer();
    const [miss] = s.update({ ...base, nearMisses: 1 });
    expect(miss.kind).toBe('nearMiss');
    const knocks = s.update({ ...base, propsKnocked: 3 });
    expect(knocks.filter((e) => e.kind === 'knock')).toHaveLength(3);
  });

  it('rewards sustained top speed', () => {
    const s = new TrickScorer();
    const events = run(s, { speed: kmh(88) }, 4.1);
    expect(events.filter((e) => e.kind === 'speed').length).toBeGreaterThanOrEqual(2);
  });

  it('chains tricks inside the combo window into a growing multiplier', () => {
    const s = new TrickScorer();
    const e1 = s.update({ ...base, nearMisses: 1 })[0];
    run(s, {}, COMBO_WINDOW * 0.5);
    const e2 = s.update({ ...base, nearMisses: 1 })[0];
    run(s, {}, COMBO_WINDOW * 0.5);
    const e3 = s.update({ ...base, nearMisses: 1 })[0];
    expect([e1.multiplier, e2.multiplier, e3.multiplier]).toEqual([1, 2, 3]);
    expect(e3.cents).toBe(e1.cents * 3);
    expect(s.bestCombo).toBe(3);
  });

  it('drops the combo after the window expires', () => {
    const s = new TrickScorer();
    s.update({ ...base, nearMisses: 1 });
    s.update({ ...base, nearMisses: 1 });
    expect(s.multiplier).toBe(3);
    run(s, {}, COMBO_WINDOW + 0.1);
    expect(s.multiplier).toBe(1);
    expect(s.update({ ...base, nearMisses: 1 })[0].multiplier).toBe(1);
  });

  it('caps the multiplier', () => {
    const s = new TrickScorer();
    let last: TrickEvent | undefined;
    for (let i = 0; i < 12; i++) last = s.update({ ...base, nearMisses: 1 })[0];
    expect(last!.multiplier).toBe(5);
  });

  it('a crash (sudden stop) breaks the combo and is reported', () => {
    const s = new TrickScorer();
    s.update({ ...base, nearMisses: 1 });
    s.update({ ...base, nearMisses: 1 });
    run(s, { speed: kmh(60) }, 0.5);
    const events = run(s, { speed: kmh(5) }, 0.1);
    expect(events.some((e) => e.kind === 'crash')).toBe(true);
    expect(s.multiplier).toBe(1);
  });

  it('hard braking is not a crash', () => {
    const s = new TrickScorer();
    run(s, { speed: kmh(60) }, 0.5);
    const events: TrickEvent[] = [];
    for (let v = 60; v > 0; v -= 0.35) events.push(...s.update({ ...base, speed: kmh(v) }));
    expect(events.some((e) => e.kind === 'crash')).toBe(false);
  });
});
