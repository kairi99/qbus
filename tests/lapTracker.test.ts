import { describe, expect, it } from 'vitest';
import { LapTracker } from '../src/gameplay/lapTracker';
import { draftOf } from '../src/gameplay/slipstream';
import { courseOf } from '../src/ui/minimap';

describe('lap tracker', () => {
  it('announces a lap faster than the race best, never the first, and sees two laps closed in one frame', () => {
    const t = new LapTracker();
    expect(t.step([60])).toEqual([]);
    expect(t.step([60, 62])).toEqual([]);
    expect(t.step([60, 62, 58])).toEqual([58]);
    const u = new LapTracker();
    expect(u.step([60, 59, 58])).toEqual([59, 58]);
    expect(u.best).toBe(58);
  });

  it('saves the best lap once, only when settled at the finish', () => {
    const t = new LapTracker();
    const saved: number[] = [];
    const record = (lap: number) => (saved.push(lap), true);
    t.step([61, 59.5]);
    // Mid-race nothing was recorded.
    expect(saved).toEqual([]);
    expect(t.settle(record)).toBe(true);
    expect(saved).toEqual([59.5]);
    // A race with no closed lap records nothing; a restart forgets the laps.
    t.reset();
    expect(t.settle(record)).toBe(false);
    expect(saved).toHaveLength(1);
  });
});

describe('slipstream on a circuit', () => {
  const o = { s: 1400, off: 0, v: 25, len: 10 };
  it('a racer a lap down tows behind the leader, and a lapped car is towed by the one just ahead', () => {
    expect(draftOf({ s: 1380 - 1500, off: 0, v: 25, len: 10 }, [o])).toBe(0);
    expect(draftOf({ s: 1380 - 1500, off: 0, v: 25, len: 10 }, [o], 1500)).toBeGreaterThan(0);
    expect(draftOf({ s: 1380, off: 0, v: 25, len: 10 }, [{ ...o, s: 1400 - 1500 }], 1500)).toBeGreaterThan(0);
  });
});

describe('circuit minimap course', () => {
  it('the lap loop with the start/finish line on it; nothing on a mountain or a plain city', () => {
    const pts = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 0 }];
    const city: any = { race: { circuit: { data: { points: pts, line: 50 } } } };
    const c = courseOf(city)!;
    expect(c.path).toBe(pts);
    expect(c.line.x).toBeCloseTo(50);
    expect(c.line.z).toBeCloseTo(0);
    expect(c.line.dx).toBeCloseTo(1);
    expect(courseOf({ race: {} } as any)).toBeNull();
    expect(courseOf({} as any)).toBeNull();
  });
});
