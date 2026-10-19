import { describe, expect, it } from 'vitest';
import { DOWNPOUR, FIRST_DRY, FLOOD_MAX, WET_GRIP, Weather, gripFor, parseRainSetting } from '../src/gameplay/weather';

/** Steps a weather through `seconds`, calling `each` with the state every second. */
function run(w: Weather, seconds: number, each?: (t: number) => void) {
  for (let t = 0; t < seconds; t += 0.1) {
    w.update(0.1);
    if (each && Math.abs(t - Math.round(t)) < 0.05) each(t);
  }
}

describe('weather', () => {
  it('random: dry at first, then a shower starts at some moment within the first few minutes', () => {
    const starts: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const w = new Weather('random', seed);
      let start = -1;
      run(w, FIRST_DRY[1] + 5, (t) => {
        if (start < 0 && w.state.rain > 0) start = t;
      });
      expect(start).toBeGreaterThanOrEqual(FIRST_DRY[0] - 1);
      starts.push(start);
    }
    // Different games, different moments.
    expect(new Set(starts.map((s) => Math.round(s / 20))).size).toBeGreaterThan(4);
  });

  it('a shower builds up, stops again and the road dries slowly after it', () => {
    const w = new Weather('random', 7);
    let peak = 0;
    let stoppedAt = -1;
    let wetAtStop = 0;
    run(w, 900, (t) => {
      peak = Math.max(peak, w.state.rain);
      if (peak > 0 && stoppedAt < 0 && w.state.rain === 0) ((stoppedAt = t), (wetAtStop = w.state.wet));
    });
    expect(peak).toBeGreaterThan(0.3);
    expect(stoppedAt).toBeGreaterThan(0);
    expect(wetAtStop).toBeGreaterThan(0.05);
  });

  it('only a downpour floods the underpasses, up to FLOOD_MAX, and the water drains after it', () => {
    const light = new Weather('always', 1, DOWNPOUR - 0.1);
    run(light, 300);
    expect(light.state.flood).toBe(0);
    const heavy = new Weather('always', 1, 1);
    run(heavy, 30);
    expect(heavy.state.flood).toBeGreaterThan(0.2);
    run(heavy, 300);
    expect(heavy.state.flood).toBeCloseTo(FLOOD_MAX);
  });

  it('a random game sometimes gets a downpour that floods', () => {
    let flooded = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const w = new Weather('random', seed);
      let max = 0;
      run(w, 600, () => (max = Math.max(max, w.state.flood)));
      if (max > 0.2) flooded++;
    }
    expect(flooded).toBeGreaterThan(2);
    expect(flooded).toBeLessThan(25);
  });

  it('off never rains; always starts wet at its peak', () => {
    const off = new Weather('off', 3);
    run(off, 1000, () => expect(off.state.rain).toBe(0));
    const on = new Weather('always', 3, 0.8);
    expect(on.state.rain).toBeCloseTo(0.8);
    expect(on.state.wet).toBeCloseTo(0.8);
    run(on, 500, () => expect(on.state.rain).toBeCloseTo(0.8));
  });

  it('grip falls with how wet the road is', () => {
    expect(gripFor(0)).toBe(1);
    expect(gripFor(1)).toBeCloseTo(WET_GRIP);
    expect(gripFor(0.5)).toBeGreaterThan(WET_GRIP);
    expect(gripFor(0.5)).toBeLessThan(1);
    expect(parseRainSetting('always')).toBe('always');
    expect(parseRainSetting('lluvia')).toBeNull();
  });
});
