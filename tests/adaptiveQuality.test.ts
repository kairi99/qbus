import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, LEVELS, MIN_GAIN, RETRY_BAN, scaleAt, SETTLE, UP_AFTER } from '../src/core/adaptiveQuality';

type Fps = number | ((level: number) => number);

/** Runs `seconds` of frames (each 1/60 s) at `fps` (or a function of the level); returns how many changes it made. */
function run(q: AdaptiveQuality, fps: Fps, seconds: number): number {
  let changes = 0;
  for (let t = 0; t < seconds; t += 1 / 60) if (q.update(typeof fps === 'number' ? fps : fps(q.level), 1 / 60)) changes++;
  return changes;
}

/** A GPU-bound machine: the frame rate follows the pixel count. */
const gpuBound = (base: number) => (level: number) => base / scaleAt(level) ** 2;
/** Capped (30 Hz display, battery saver) or CPU-bound: pixels do not matter. */
const capped = () => 30;

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

  it('a GPU-bound machine steps down while fps stays low, to the last level', () => {
    const q = new AdaptiveQuality();
    run(q, gpuBound(14), 60);
    expect(q.level).toBe(LEVELS - 1);
    expect(scaleAt(q.level)).toBeLessThan(scaleAt(0));
    expect(scaleAt(q.level)).toBeGreaterThan(0.5);
    expect(q.disabled).toBe(false);
  });

  it('a capped machine tries one step, sees no gain, undoes it and stays at full resolution', () => {
    const q = new AdaptiveQuality();
    expect(run(q, capped, 120)).toBe(2);
    expect(q.level).toBe(0);
    expect(q.disabled).toBe(true);
    expect(MIN_GAIN).toBeGreaterThan(1);
  });

  it('shrinks shadows only when even the lowest resolution (which helped) is very slow', () => {
    const q = new AdaptiveQuality();
    run(q, gpuBound(30), 60);
    expect(q.shadowsLow).toBe(false);
    const slow = new AdaptiveQuality();
    run(slow, gpuBound(7), 60);
    expect(slow.level).toBe(LEVELS - 1);
    expect(slow.shadowsLow).toBe(true);
  });

  it('never shrinks shadows on a machine that fewer pixels do not help', () => {
    const q = new AdaptiveQuality();
    run(q, 15, 120);
    expect(q.shadowsLow).toBe(false);
    expect(q.level).toBe(0);
  });

  it('steps back up after a long stretch of high fps', () => {
    const q = new AdaptiveQuality();
    run(q, gpuBound(20), 10);
    const low = q.level;
    expect(low).toBeGreaterThan(0);
    run(q, 60, UP_AFTER + SETTLE + 1);
    expect(q.level).toBeLessThan(low);
  });

  it('does not bounce: a level that failed right after a step up is not tried again', () => {
    const q = new AdaptiveQuality();
    run(q, gpuBound(20), 10);
    const before = q.level;
    run(q, 60, UP_AFTER + 1); // steps up one level
    expect(q.level).toBe(before - 1);
    run(q, gpuBound(20), 6); // ...and falls straight back
    expect(q.level).toBe(before);
    expect(RETRY_BAN).toBeGreaterThan(6);
    run(q, 60, 120);
    expect(q.level).toBe(before);
  });
});
