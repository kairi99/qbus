import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, LEVELS, RETRY_BAN, scaleAt, SETTLE, UP_AFTER } from '../src/core/adaptiveQuality';

/** Runs `seconds` of frames at `fps` (each frame 1/60 s); returns how many changes it made. */
function run(q: AdaptiveQuality, fps: number, seconds: number): number {
  let changes = 0;
  for (let t = 0; t < seconds; t += 1 / 60) if (q.update(fps, 1 / 60)) changes++;
  return changes;
}

describe('adaptive quality', () => {
  it('never leaves full resolution on a machine that holds 60 fps', () => {
    const q = new AdaptiveQuality();
    expect(run(q, 60, 120)).toBe(0);
    expect(q.level).toBe(0);
    expect(q.shadowsLow).toBe(false);
  });

  it('ignores a short dip', () => {
    const q = new AdaptiveQuality();
    run(q, 60, 10);
    run(q, 20, 1);
    run(q, 60, 10);
    expect(q.level).toBe(0);
  });

  it('steps down while the frame rate stays low, one step per settle time, down to the last level', () => {
    const q = new AdaptiveQuality();
    run(q, 30, 60);
    expect(q.level).toBe(LEVELS - 1);
    expect(scaleAt(q.level)).toBeLessThan(scaleAt(0));
    expect(scaleAt(q.level)).toBeGreaterThan(0.5);
  });

  it('shrinks shadows only when even the lowest resolution is very slow', () => {
    const q = new AdaptiveQuality();
    run(q, 33, 60);
    expect(q.shadowsLow).toBe(false);
    run(q, 15, 20);
    expect(q.shadowsLow).toBe(true);
  });

  it('steps back up after a long stretch of high fps', () => {
    const q = new AdaptiveQuality();
    run(q, 30, 10);
    const low = q.level;
    expect(low).toBeGreaterThan(0);
    run(q, 60, UP_AFTER + SETTLE + 1);
    expect(q.level).toBeLessThan(low);
  });

  it('does not bounce: a level that failed right after a step up is not tried again', () => {
    const q = new AdaptiveQuality();
    run(q, 30, 10);
    const before = q.level;
    run(q, 60, UP_AFTER + 1); // steps up one level
    expect(q.level).toBe(before - 1);
    run(q, 30, 4); // ...and falls straight back
    expect(q.level).toBe(before);
    expect(RETRY_BAN).toBeGreaterThan(4);
    run(q, 60, 120);
    expect(q.level).toBe(before);
  });
});
