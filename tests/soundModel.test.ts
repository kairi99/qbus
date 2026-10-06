import { describe, expect, it } from 'vitest';
import { AirBrakes, DIESEL, LEVELS, PETROL, db, engineLoad, engineMix, engineRpm, isBraking, makeLoop, turboWhistle } from '../src/core/soundModel';

const DT = 1 / 60;

describe('engine RPM (fake gearbox)', () => {
  for (const [name, v] of [['diesel', DIESEL], ['petrol', PETROL]] as const) {
    it(`${name}: idles at a standstill, stays in range, and drops at every upshift`, () => {
      expect(engineRpm(0, 0, v).rpm).toBe(v.idleRpm);
      let last = engineRpm(0, 1, v);
      let shifts = 0;
      for (let s = 0.005; s <= 1; s += 0.005) {
        const r = engineRpm(s, 1, v);
        expect(r.rpm).toBeGreaterThanOrEqual(v.idleRpm);
        expect(r.rpm).toBeLessThanOrEqual(v.redlineRpm * 1.01);
        if (r.gear !== last.gear) {
          shifts++;
          expect(r.gear).toBe(last.gear + 1);
          expect(r.rpm).toBeLessThan(last.rpm - 300);
        }
        last = r;
      }
      expect(shifts).toBe(v.gears.length - 1);
    });
  }

  it('throttle at a standstill revs a little (clutch slip), not to the redline', () => {
    const r = engineRpm(0, 1, DIESEL).rpm;
    expect(r).toBeGreaterThan(DIESEL.idleRpm + 100);
    expect(r).toBeLessThan(DIESEL.redlineRpm * 0.6);
  });
});

describe('engine mix', () => {
  it('is all idle layer at idle, mostly load layer revving on throttle', () => {
    const idle = engineMix(DIESEL.idleRpm, 0, DIESEL);
    expect(idle.idleGain).toBeCloseTo(1, 5);
    expect(idle.loadGain).toBeCloseTo(0, 5);
    expect(idle.idleRate).toBeCloseTo(DIESEL.idleRpm / DIESEL.idleRef, 5);
    const high = engineMix(DIESEL.redlineRpm, 1, DIESEL);
    expect(high.loadGain).toBeGreaterThan(0.9);
    expect(high.idleGain).toBeLessThan(0.05);
  });

  it('keeps constant power across the crossfade and opens up with load', () => {
    for (let rpm = DIESEL.idleRpm; rpm <= DIESEL.redlineRpm; rpm += 100) {
      const m = engineMix(rpm, 1, DIESEL);
      expect(m.idleGain ** 2 + m.loadGain ** 2).toBeCloseTo(1, 5);
      const off = engineMix(rpm, 0, DIESEL);
      expect(m.cutoff).toBeGreaterThan(off.cutoff);
      expect(m.volume).toBeGreaterThan(off.volume);
    }
  });

  it('pitches each layer by RPM over the RPM it was recorded at', () => {
    const m = engineMix(1510, 0.5, DIESEL);
    expect(m.loadRate).toBeCloseTo(1, 5);
    expect(m.idleRate).toBeCloseTo(1510 / 600, 5);
  });
});

describe('mix levels', () => {
  // Engine loudness as played, relative to the normalized recordings: gain x volume, at
  // idle, cruising (60% of top speed, light throttle) and flat out.
  const engineDb = (kind: 'bus' | 'car', speedFrac: number, load: number) => {
    const v = kind === 'bus' ? DIESEL : PETROL;
    return db(LEVELS.engine[kind] * engineMix(engineRpm(speedFrac, load, v).rpm, load, v).volume);
  };

  it('the engine gets louder with throttle, and the bus louder than the car', () => {
    for (const kind of ['bus', 'car'] as const) {
      expect(engineDb(kind, 0.6, 0.3)).toBeGreaterThan(engineDb(kind, 0, 0) + 2);
      expect(engineDb(kind, 0.6, 1)).toBeGreaterThan(engineDb(kind, 0.6, 0) + 2);
    }
    for (const [s, l] of [[0, 0], [0.6, 0.3], [0.9, 1]])
      expect(engineDb('bus', s, l)).toBeGreaterThan(engineDb('car', s, l) + 2);
  });

  it('one-shots sit a little over the cruising bus engine, not far over it', () => {
    const cruise = engineDb('bus', 0.6, 0.3);
    for (const g of [LEVELS.airRelease, LEVELS.doorOpen, LEVELS.doorClose, LEVELS.timbre, LEVELS.horn.bus]) {
      expect(db(g) - cruise).toBeGreaterThan(-4);
      expect(db(g) - cruise).toBeLessThan(6);
    }
    // The horn is the loudest thing the driver controls; the air brakes never beat it.
    expect(LEVELS.horn.bus).toBeGreaterThan(LEVELS.airRelease);
  });

  it('the turbo only whistles under load, rising with the revs, far under the engine', () => {
    expect(turboWhistle(DIESEL.idleRpm, 1, DIESEL).gain).toBe(0);
    expect(turboWhistle(2000, 0, DIESEL).gain).toBe(0);
    const lo = turboWhistle(1400, 1, DIESEL);
    const hi = turboWhistle(2200, 1, DIESEL);
    expect(hi.freq).toBeGreaterThan(lo.freq);
    expect(hi.gain).toBeGreaterThan(0);
    expect(db(hi.gain)).toBeLessThan(-30);
  });
});

describe('throttle meaning', () => {
  it('pushing against the motion brakes, with no engine load', () => {
    expect(isBraking(-1, 10)).toBe(true);
    expect(engineLoad(-1, 10)).toBe(0);
    expect(isBraking(1, -5)).toBe(true);
    expect(isBraking(-1, 0)).toBe(false);
    expect(engineLoad(-1, 0)).toBe(1); // reversing
    expect(engineLoad(0.5, 10)).toBe(0.5);
    expect(engineLoad(0, 10, true)).toBe(1);
  });
});

describe('air brakes', () => {
  it('releases once when the bus brakes to a stop', () => {
    const a = new AirBrakes();
    const events: string[] = [];
    let v = 14;
    for (let i = 0; i < 600; i++) {
      v = Math.max(0, v - 8 * DT);
      const e = a.step(DT, v, v > 0);
      if (e) events.push(e);
    }
    expect(events).toEqual(['hiss', 'release', 'purge']);
  });

  it('purges once after a long stop, not if the bus pulls away first', () => {
    const run = (stopFor: number) => {
      const a = new AirBrakes();
      const events: string[] = [];
      const push = (e: string | null) => e && events.push(e);
      for (let i = 0; i < 60; i++) push(a.step(DT, 10, false));
      for (let i = 0; i < 60; i++) push(a.step(DT, 0, true));
      for (let t = 0; t < stopFor; t += DT) push(a.step(DT, 0, false));
      for (let i = 0; i < 600; i++) push(a.step(DT, 10, false));
      return events;
    };
    expect(run(8)).toEqual(['release', 'purge']);
    expect(run(2)).toEqual(['release']);
  });

  it('stays quiet when coasting to a stop or crawling at a stop', () => {
    const a = new AirBrakes();
    let v = 6;
    for (let i = 0; i < 600; i++) {
      v = Math.max(0, v - 1 * DT);
      expect(a.step(DT, v, false)).toBeNull();
    }
    for (let i = 0; i < 600; i++) expect(a.step(DT, 0.5 + 0.4 * Math.sin(i / 20), i % 60 < 30)).toBeNull();
  });
});

describe('makeLoop', () => {
  it('wraps around without a jump', () => {
    const sr = 8000;
    const n = sr;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 97.3 * i) / sr) + 0.3 * Math.sin((2 * Math.PI * 211.7 * i) / sr);
    const loop = makeLoop(x, 800, 40);
    expect(loop.length).toBe(n - 840);
    const maxStep = Math.max(...Array.from(loop.slice(1), (v, i) => Math.abs(v - loop[i])));
    const wrap = Math.abs(loop[0] - loop[loop.length - 1]);
    expect(wrap).toBeLessThan(maxStep * 1.5);
  });
});
