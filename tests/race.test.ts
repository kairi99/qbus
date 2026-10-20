import { describe, expect, it } from 'vitest';
import { GOOD, IDLE, LaunchRev, WINDOW, aiGrade, gradeOf } from '../src/gameplay/launch';
import { COUNT_STEP, GRID_WAIT, RaceGame, raceClock } from '../src/gameplay/raceGame';
import { CREWS, MAX_RIVALS, parseRivalChoice, rivalVehicles } from '../src/gameplay/raceField';
import { PICKUP_FILL, PICKUP_RESPAWN, Pickups } from '../src/gameplay/pickups';
import { KEEP_RIGHT, chooseLane } from '../src/gameplay/raceDriver';
import { Nitro } from '../src/gameplay/nitro';
import { playUrl } from '../src/menu/menu';

describe('the launch', () => {
  it('idles with no throttle, climbs with it, falls back when lifting', () => {
    const l = new LaunchRev();
    for (let t = 0; t < 2; t += 0.02) l.update(0.02, 0);
    expect(l.rpm).toBeCloseTo(IDLE, 5);
    for (let t = 0; t < 0.5; t += 0.02) l.update(0.02, 1);
    const up = l.rpm;
    expect(up).toBeGreaterThan(0.4);
    for (let t = 0; t < 0.3; t += 0.02) l.update(0.02, 0);
    expect(l.rpm).toBeLessThan(up);
  });

  it('flat out runs past the window into wheelspin; feathering holds it in the window', () => {
    const flat = new LaunchRev();
    for (let t = 0; t < 3; t += 0.02) flat.update(0.02, 1);
    expect(flat.grade()).toBe('spin');
    const fed = new LaunchRev();
    let inside = 0;
    for (let t = 0; t < 4; t += 0.02) {
      fed.update(0.02, fed.rpm < (WINDOW[0] + WINDOW[1]) / 2 ? 1 : 0);
      if (t > 1.5 && fed.inWindow) inside++;
    }
    expect(inside / (2.5 / 0.02)).toBeGreaterThan(0.9);
    expect(fed.grade()).toBe('perfect');
  });

  it('grades by where the needle is', () => {
    expect(gradeOf(IDLE)).toBe('bog');
    expect(gradeOf((WINDOW[0] + WINDOW[1]) / 2)).toBe('perfect');
    expect(gradeOf((GOOD[0] + WINDOW[0]) / 2)).toBe('good');
    expect(gradeOf(0.99)).toBe('spin');
  });

  it('better AI drivers launch better', () => {
    const perfect = (k: 'easy' | 'normal' | 'hard') => Array.from({ length: 100 }, (_, i) => aiGrade(i / 100, k)).filter((g) => g === 'perfect').length;
    expect(perfect('hard')).toBeGreaterThan(perfect('normal'));
    expect(perfect('normal')).toBeGreaterThan(perfect('easy'));
  });
});

describe('the race', () => {
  const step = (g: RaceGame, secs: number, progress: number[] | ((t: number) => number[]), dt = 0.05) => {
    const out: string[] = [];
    for (let t = 0; t < secs; t += dt) for (const e of g.update(dt, typeof progress === 'function' ? progress(g.time) : progress)) out.push(e.type === 'count' ? `count${e.n}` : e.type);
    return out;
  };

  it('waits on the grid until begun, then counts 3-2-1 and goes', () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    for (let t = 0; t < 5; t += 0.05) g.update(0.05, [0, 0], false);
    expect(g.phase).toBe('grid');
    const ev = step(g, GRID_WAIT + 3 * COUNT_STEP + 0.2, [0, 0]);
    expect(ev).toEqual(['count3', 'count2', 'count1', 'go']);
    expect(g.green).toBe(true);
  });

  it('on the grid, places follow the grid (the player at the back)', () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    g.update(0.05, [-16, -6]);
    expect(g.placeOf(0)).toBe(2);
  });

  it('places racers by progress, reports overtakes, ends when the player finishes', () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    step(g, GRID_WAIT + 3 * COUNT_STEP + 0.1, [0, 0]);
    // The rival leads, then the player passes it and finishes first.
    const ev = step(g, 60, (t) => [t * 20, t < 20 ? t * 22 : 440 + (t - 20) * 15]);
    expect(ev).toContain('overtake');
    expect(ev.filter((e) => e === 'finish')).toHaveLength(1);
    expect(ev[ev.length - 1]).toBe('over');
    expect(g.phase).toBe('over');
    expect(g.ranking()).toEqual([0, 1]);
    expect(g.racers[0].time).toBeCloseTo(50, 0);
    // The rival's time is estimated from its pace, behind the player's.
    expect(g.racers[1].estimated).toBe(true);
    expect(g.racers[1].time!).toBeGreaterThan(g.racers[0].time!);
  });

  it('a rival that finishes first keeps its real time and first place', () => {
    const g = new RaceGame(['Tú', 'Rival'], 500);
    step(g, GRID_WAIT + 3 * COUNT_STEP + 0.1, [0, 0]);
    step(g, 60, (t) => [t * 10, t * 20]);
    expect(g.ranking()).toEqual([1, 0]);
    expect(g.racers[1].estimated).toBe(false);
    expect(g.racers[1].time).toBeCloseTo(25, 0);
  });

  it('formats race times', () => {
    expect(raceClock(83.44)).toBe('1:23.4');
    expect(raceClock(7.06)).toBe('0:07.1');
  });
});

describe('the field', () => {
  const pool = ['popular', 'interparroquial', 'buseta', 'articulado', 'gusanito', 'ae86'];

  it('mixed: every rival a different vehicle, none the player’s while there are others', () => {
    for (const player of pool)
      for (let n = 1; n <= MAX_RIVALS; n++) {
        const v = rivalVehicles('mixed', player, n, pool, () => 0.37);
        expect(v).toHaveLength(n);
        expect(new Set(v).size).toBe(n);
        expect(v).not.toContain(player);
      }
    // The crews' own vehicles when the player's isn't among them.
    expect(rivalVehicles('mixed', 'ae86', 3, pool)).toEqual(CREWS.map((c) => c.bus));
  });

  it('the same as the player, or one vehicle for all', () => {
    expect(rivalVehicles('same', 'gusanito', 2, pool)).toEqual(['gusanito', 'gusanito']);
    expect(rivalVehicles('ae86', 'popular', 3, pool)).toEqual(['ae86', 'ae86', 'ae86']);
    expect(parseRivalChoice('nope', pool)).toBe('mixed');
    expect(parseRivalChoice('buseta', pool)).toBe('buseta');
    expect(parseRivalChoice('same', pool)).toBe('same');
  });

  it('the menu link carries the race setup', () => {
    const url = new URLSearchParams(playUrl({ mode: 'race', bus: 'buseta', zone: 'mariscal', route: 'circuito', race: { track: 'papallacta', rivals: 2, rivalBus: 'same', skill: 'hard', traffic: true } }));
    expect(Object.fromEntries(url)).toEqual({ play: '1', mode: 'race', city: 'papallacta', bus: 'buseta', rivals: '2', rivalBus: 'same', skill: 'hard', traffic: '1' });
    expect(new URLSearchParams(playUrl({ mode: 'race', bus: 'popular', zone: 'mariscal', route: 'circuito', race: { track: 'papallacta', rivals: 1, rivalBus: 'mixed', skill: 'normal', traffic: false } })).has('traffic')).toBe(false);
  });
});

describe('nitro pickups', () => {
  const spots = [
    { s: 100, off: -1.9 },
    { s: 100, off: 1.9 },
  ];

  it('a racer running over one takes it (only that one), and it comes back later', () => {
    const p = new Pickups(spots);
    expect(p.take(95, 101, 1.6, 11, 2.5)).toEqual([1]);
    // Gone: the next one over it gets nothing.
    expect(p.take(95, 101, 1.9, 11, 2.5)).toEqual([]);
    for (let t = 0; t < PICKUP_RESPAWN + 0.1; t += 0.1) p.step(0.1);
    expect(p.take(95, 101, 1.9, 11, 2.5)).toEqual([1]);
  });

  it('counts the whole length of the bus (a low frame rate never skips one), not a jump back onto the road', () => {
    const p = new Pickups(spots);
    // The nose already past it this frame, the tail still on it.
    expect(p.take(104, 108, -1.5, 11, 2.5)).toEqual([0]);
    // Put back on the road 200 m on: it didn't drive over them.
    expect(new Pickups(spots).take(0, 200, 1.9, 11, 2.5)).toEqual([]);
    // In the middle of the road: neither.
    expect(new Pickups(spots).take(95, 101, 0, 11, 1.7)).toEqual([]);
  });

  it('fill half a tank', () => {
    const n = new Nitro();
    n.level = 0.1;
    n.bonus(PICKUP_FILL);
    expect(n.level).toBeCloseTo(0.6);
  });
});

describe('lanes in traffic', () => {
  const me = { s: 1000, off: 1.2, v: 18, len: 11 };
  const car = (ds: number, dir: 1 | -1, v = 12) => ({ s: 1000 + ds, off: dir * 2.1, v, dir, len: 4.4 });

  it('keeps its lane on an empty road', () => {
    expect(chooseLane(me, [], [], KEEP_RIGHT)).toEqual({ lane: KEEP_RIGHT, limit: Infinity });
  });

  it('passes a slower car on the left with the road clear, follows it with an oncoming car near', () => {
    expect(chooseLane(me, [], [car(30, 1)], KEEP_RIGHT).lane).toBeLessThan(0);
    const held = chooseLane(me, [], [car(30, 1), car(110, -1)], KEEP_RIGHT);
    expect(held.lane).toBeGreaterThan(0);
    expect(held.limit).toBeLessThan(me.v);
  });

  it('never cuts back in on a car still alongside', () => {
    const passing = { ...me, off: -1.9 };
    // Our nose 3 m past its middle: it's still beside us.
    expect(chooseLane(passing, [], [car(-3, 1)], KEEP_RIGHT).lane).toBeLessThan(0);
    // Past our tail: back to the right.
    expect(chooseLane(passing, [], [car(-20, 1)], KEEP_RIGHT).lane).toBeGreaterThan(0);
  });

  it('gets back to its own half for an oncoming car, and over to the right to meet it', () => {
    expect(chooseLane({ ...me, off: -1.5 }, [], [car(85, -1)], KEEP_RIGHT).lane).toBe(KEEP_RIGHT);
    expect(chooseLane({ ...me, off: -1.5 }, [], [car(50, -1)], KEEP_RIGHT).lane).toBeGreaterThan(KEEP_RIGHT);
  });

  it('passes another racer close ahead in its lane', () => {
    expect(chooseLane({ ...me, off: 0 }, [{ s: 1010, off: 0.3, v: 15, len: 12 }], [], 0).lane).toBeLessThan(0);
  });
});
