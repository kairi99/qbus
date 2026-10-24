import { beforeAll, describe, expect, it } from 'vitest';
import { GOOD, IDLE, LaunchRev, WINDOW, aiGrade, gradeOf } from '../src/gameplay/launch';
import { COUNT_STEP, GRID_WAIT, PLACE_SETTLE, PlaceCaller, RaceGame, bestLap, raceClock } from '../src/gameplay/raceGame';
import { CREWS, MAX_RIVALS, parseRivalChoice, rivalVehicles } from '../src/gameplay/raceField';
import { PICKUP_FILL, PICKUP_RESPAWN, Pickups } from '../src/gameplay/pickups';
import { BARRIER_GAP, KEEP_RIGHT, SKILLS, chooseLane, racingLine, speedProfile } from '../src/gameplay/raceDriver';
import { readFileSync } from 'node:fs';
import type { TrackData } from '../src/world/track';
import { loadZone } from '../src/world/loadCity';
import { trackPoint } from '../src/world/track';
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
    const ev = step(g, 55, (t) => [t * 20, t < 20 ? t * 22 : 440 + (t - 20) * 15]);
    expect(ev).toContain('overtake');
    expect(ev.filter((e) => e === 'finish')).toHaveLength(1);
    expect(ev[ev.length - 1]).toBe('over');
    expect(g.phase).toBe('over');
    expect(g.ranking()).toEqual([0, 1]);
    expect(g.racers[0].time).toBeCloseTo(50, 0);
    // The rival's time is estimated from its pace, behind the player's.
    g.estimateRest();
    expect(g.racers[1].estimated).toBe(true);
    expect(g.racers[1].time!).toBeGreaterThan(g.racers[0].time!);
  });

  it("solo: rivals still racing at the player's finish get real times later", () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    step(g, GRID_WAIT + 3 * COUNT_STEP + 0.1, [0, 0]);
    step(g, 45, (t) => [t * 25, t * 20]);
    expect(g.phase).toBe('over');
    expect(g.racers[1].time).toBeNull();
    expect(g.allDone).toBe(false);
    const ev = g.update(0.1, [1100, 1001]);
    expect(ev.map((e) => e.type)).toEqual(['finish']);
    expect(g.racers[1].time).toBe(g.time);
    expect(g.racers[1].estimated).toBe(false);
    expect(g.allDone).toBe(true);
  });

  it('estimateRest fills the rest from pace', () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    step(g, GRID_WAIT + 3 * COUNT_STEP + 0.1, [0, 0]);
    step(g, 45, (t) => [t * 25, t * 20]);
    const t = g.time;
    const s = g.racers[1].s;
    g.estimateRest();
    expect(g.racers[1].estimated).toBe(true);
    expect(g.racers[1].time).toBeCloseTo(t + ((1000 - s) / (s / t)) * 1.03);
    expect(g.allDone).toBe(true);
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

describe('laps', () => {
  const LAP = 500;
  const go = (n = 2) => {
    const g = new RaceGame(Array.from({ length: n }, (_, i) => `r${i}`), 3 * LAP, { laps: { count: 3, lap: LAP } });
    for (let t = 0; t < GRID_WAIT + 3 * COUNT_STEP + 0.2; t += 0.05) g.update(0.05, new Array(n).fill(0));
    return g;
  };
  /** Runs `secs` more; `at(t)` = progress per racer at race time t. */
  const run = (g: RaceGame, secs: number, at: (t: number) => number[]) => {
    const out: { type: string; racer?: number; lap?: number; time?: number }[] = [];
    for (let t = 0; t < secs; t += 0.05) for (const e of g.update(0.05, at(g.time + 0.05))) if (e.type === 'lap' || e.type === 'finish') out.push(e);
    return out;
  };

  it('a lap event fires once per line crossed (laps 2..laps); the finish closes the last lap', () => {
    const g = go();
    const ev = run(g, 80, (t) => [t * 20, t * 10]);
    expect(ev.filter((e) => e.type === 'lap' && e.racer === 0).map((e) => e.lap)).toEqual([2, 3]);
    expect(ev.filter((e) => e.type === 'finish').map((e) => e.racer)).toEqual([0]);
    expect(g.racers[0].lap).toBe(3);
    expect(g.racers[0].lapTimes).toHaveLength(3);
    expect(g.racers[1].lap).toBe(2);
    expect(g.racers[1].lapTimes).toHaveLength(1);
    expect(ev.filter((e) => e.racer === 1).map((e) => e.lap)).toEqual([2]);
  });

  it('lap times sum to the race time at the finish', () => {
    const g = go();
    run(g, 200, (t) => [t * 20 + Math.sin(t) * 30, 0]);
    const me = g.racers[0];
    expect(me.time).not.toBeNull();
    expect(me.lapTimes.reduce((a, b) => a + b, 0)).toBeCloseTo(me.time!, 9);
    expect(bestLap(me)).toBe(Math.min(...me.lapTimes));
  });

  it('a reset back over a line neither un-counts nor repeats the lap', () => {
    const g = go();
    const prog = [LAP - 5, 0];
    run(g, 0.1, () => prog);
    prog[0] = LAP + 10;
    expect(run(g, 0.2, () => prog).map((e) => e.lap)).toEqual([2]);
    prog[0] = LAP - 30;
    expect(run(g, 0.2, () => prog)).toEqual([]);
    expect(g.racers[0].lap).toBe(2);
    prog[0] = LAP + 5;
    expect(run(g, 0.2, () => prog)).toEqual([]);
    expect(g.racers[0].lapTimes).toHaveLength(1);
  });

  it('a lapped car ranks behind on total distance', () => {
    const g = go();
    // The same spot of the lap (x/z) for both: A is a whole lap ahead of B there, on lap 3 to B's 2.
    const spot = 120;
    run(g, 0.2, () => [2 * LAP + spot, LAP + spot]);
    expect(g.racers[0].s % LAP).toBe(g.racers[1].s % LAP);
    expect(g.ranking()).toEqual([0, 1]);
    expect(g.placeOf(0)).toBe(1);
    expect(g.racers[0].lap).toBe(3);
    expect(g.racers[1].lap).toBe(2);
    // B sits ahead on the lap but is the one lapped: A passes it, then B stays behind.
    run(g, 0.2, () => [2 * LAP + spot + 40, LAP + spot + 30]);
    expect(g.ranking()).toEqual([0, 1]);
    run(g, 0.2, () => [2.9 * LAP, 3.4 * LAP]);
    expect(g.racers.every((r) => r.lap <= 3)).toBe(true);
  });

  it('two lines in one frame are timed by interpolation, not 0 s', () => {
    const g = go(1);
    // One 3 s frame (a stall), from just before line 1 to past line 2.
    g.update(0.05, [LAP - 10]);
    const ev = g.update(3, [2 * LAP + 10]).filter((e) => e.type === 'lap');
    expect(ev).toHaveLength(2);
    const laps = g.racers[0].lapTimes;
    expect(laps[0]).toBeGreaterThan(0);
    expect(laps[1]).toBeGreaterThan(0);
    expect(laps[1]).toBeLessThan(3);
    expect(laps[1]).toBeCloseTo((3 * LAP) / (LAP + 20), 1);
    expect(g.racers[0].best).toBe(Math.min(...laps));
  });

  it('a racer first seen past a line (late join) gets no lap time for the laps behind', () => {
    const g = go(2);
    // Its first snapshot lands 1.5 laps on, after the grid's 0 (a jump no bus drives).
    const ev = run(g, 0.3, () => [10, 1.5 * LAP]);
    expect(ev).toEqual([]);
    expect(g.racers[1].lap).toBe(2);
    expect(g.racers[1].lapTimes).toEqual([]);
    expect(g.racers[1].best).toBeNull();
    // Its next line is timed from there on, not from the start of the race.
    const next = run(g, 3, (t) => [10, 1.5 * LAP + (t - 0.3 > 0 ? 100 * (t - 0.3) : 0)]);
    expect(next.filter((e) => e.racer === 1)).toEqual([]);
  });

  it('skipTo (a resume) counts the lines before it without events or times', () => {
    const g = go();
    g.skipTo(0, 1.4 * LAP);
    expect(run(g, 0.2, () => [1.4 * LAP, 0])).toEqual([]);
    expect(g.racers[0].lap).toBe(2);
    expect(g.racers[0].lapTimes).toEqual([]);
  });

  it('without laps nothing changes', () => {
    const g = new RaceGame(['a'], 100);
    expect(g.racers[0]).toMatchObject({ lap: 1, lapTimes: [] });
  });
});

describe('online clock', () => {
  const run = (g: RaceGame, goIns: number[]) => {
    const out: string[] = [];
    for (const go of goIns) for (const e of g.update(0.016, [0, 0], false, go)) out.push(e.type === 'count' ? `count${e.n}` : e.type);
    return out;
  };

  it('counts down from the shared clock with jittery frames', () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    expect(run(g, [4.5, 4.2, 3.4, 3.0, 2.9, 2.2, 1.99, 1.0, 0.8, 0.05, -0.03])).toEqual(['count3', 'count2', 'count1', 'go']);
    expect(g.phase).toBe('racing');
    expect(g.time).toBeCloseTo(0.03);
  });

  it('a late joiner only hears the current count', () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    expect(run(g, [1.4, 1.3, -0.1])).toEqual(['count2', 'go']);
    const h = new RaceGame(['Tú', 'Rival'], 1000);
    expect(run(h, [0.9, 0.5, -0.1])).toEqual(['count1', 'go']);
  });

  it('a frame jump past GO emits go only', () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    expect(run(g, [3.5, -0.2])).toEqual(['go']);
    expect(g.phase).toBe('racing');
  });

  it('race time follows the shared clock', () => {
    const g = new RaceGame(['Tú', 'Rival'], 1000);
    run(g, [0.5, -0.1]);
    g.update(0.9, [10, 20], true, -5.5);
    expect(g.time).toBeCloseTo(5.5);
    expect(g.countLeft).toBeLessThanOrEqual(0);
  });

  it('without estimates, setTime fills a time and re-ranks', () => {
    const g = new RaceGame(['Tú', 'Rival'], 500, { estimate: false });
    run(g, [-0.1]);
    g.update(0.1, [100, 300], true, -10);
    g.update(0.1, [500, 400], true, -30);
    expect(g.phase).toBe('over');
    expect(g.racers[1].time).toBeNull();
    expect(g.racers[1].estimated).toBe(false);
    expect(g.ranking()).toEqual([0, 1]);
    g.setTime(1, 25);
    expect(g.racers[1].time).toBe(25);
    expect(g.ranking()).toEqual([1, 0]);
    expect(g.placeOf(0)).toBe(2);
  });
});

describe('the field', () => {
  const pool = ['popular', 'interparroquial', 'buseta', 'articulado', 'gusanito', 'ae86', 'trailer'];

  it('mixed: every rival a different vehicle, none the player’s while there are others', () => {
    for (const player of pool)
      for (let n = 1; n <= MAX_RIVALS; n++) {
        const v = rivalVehicles('mixed', player, n, pool, () => 0.37);
        expect(v).toHaveLength(n);
        expect(new Set(v).size).toBe(n);
        expect(v).not.toContain(player);
      }
    // The crews' own vehicles when the player's isn't among them.
    expect(rivalVehicles('mixed', 'ae86', 3, pool)).toEqual(CREWS.slice(0, 3).map((c) => c.bus));
    expect(rivalVehicles('mixed', 'gusanito', MAX_RIVALS, pool)).toEqual(CREWS.map((c) => c.bus));
  });

  it('the same as the player, or one vehicle for all', () => {
    expect(rivalVehicles('same', 'gusanito', 2, pool)).toEqual(['gusanito', 'gusanito']);
    expect(rivalVehicles('ae86', 'popular', 3, pool)).toEqual(['ae86', 'ae86', 'ae86']);
    expect(parseRivalChoice('nope', pool)).toBe('mixed');
    expect(parseRivalChoice('buseta', pool)).toBe('buseta');
    expect(parseRivalChoice('same', pool)).toBe('same');
  });

  it('the menu link carries the race setup', () => {
    const url = new URLSearchParams(playUrl({ mode: 'race', bus: 'buseta', zone: 'mariscal', route: 'circuito', race: { track: 'papallacta', rivals: 2, rivalBus: 'same', skill: 'hard', traffic: true, slides: true } }));
    expect(Object.fromEntries(url)).toEqual({ play: '1', mode: 'race', city: 'papallacta', bus: 'buseta', rivals: '2', rivalBus: 'same', skill: 'hard', traffic: '1' });
    expect(new URLSearchParams(playUrl({ mode: 'race', bus: 'popular', zone: 'mariscal', route: 'circuito', race: { track: 'papallacta', rivals: 1, rivalBus: 'mixed', skill: 'normal', traffic: false, slides: true } })).has('traffic')).toBe(false);
    const silante = (slides: boolean) => new URLSearchParams(playUrl({ mode: 'race', bus: 'popular', zone: 'mariscal', route: 'circuito', race: { track: 'silante', rivals: 1, rivalBus: 'mixed', skill: 'normal', traffic: false, slides } }));
    expect(silante(false).get('slides')).toBe('0');
    expect(silante(true).has('slides')).toBe(false);
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

  it('on a circuit one spot serves every lap: taken on lap 1 it is gone for lap 2 too, and a racer on lap 2 can take it', () => {
    const lap = 1500;
    const p = new Pickups(spots, lap);
    // Lap 2: the spot is a lap further on.
    expect(p.take(lap + 95, lap + 101, 1.6, 11, 2.5)).toEqual([1]);
    expect(p.gone[1]).toBeGreaterThan(0);
    // A racer one lap down, in the same place, finds it gone (it is the same canister).
    expect(p.take(95, 101, 1.9, 11, 2.5)).toEqual([]);
    for (let t = 0; t < PICKUP_RESPAWN + 0.1; t += 0.1) p.step(0.1);
    // Back: whoever comes past next takes it, on any lap.
    expect(p.take(2 * lap + 95, 2 * lap + 101, 1.9, 11, 2.5)).toEqual([1]);
    // Between spots on any lap: nothing.
    expect(new Pickups(spots, lap).take(lap + 300, lap + 306, 1.9, 11, 2.5)).toEqual([]);
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

  it('starts no pass in a tunnel or just before its portal, finishes one already alongside', () => {
    const bore = [{ s0: 1100, s1: 1300 }];
    const slow = car(30, 1);
    expect(chooseLane(me, [], [slow], KEEP_RIGHT, 140, null, bore).lane).toBeLessThan(0); // portal 100 m on: clear of the 70 m line
    expect(chooseLane(me, [], [car(30, 1)], KEEP_RIGHT, 140, null, [{ s0: 1060, s1: 1300 }]).lane).toBeGreaterThan(0);
    const inside = chooseLane({ ...me, s: 1150 }, [], [{ ...car(30, 1), s: 1180 }], KEEP_RIGHT, 140, null, bore);
    expect(inside.lane).toBeGreaterThan(0);
    expect(inside.limit).toBeLessThan(me.v);
    // Already out in the other half and alongside: the pass goes on.
    expect(chooseLane({ ...me, s: 1150, off: -1.9 }, [], [{ ...car(-3, 1), s: 1147 }], KEEP_RIGHT, 140, null, bore).lane).toBeLessThan(0);
    // Out of the bore again: passes as usual.
    expect(chooseLane({ ...me, s: 1310 }, [], [{ ...car(30, 1), s: 1340 }], KEEP_RIGHT, 140, null, bore).lane).toBeLessThan(0);
  });

  it('meets an oncoming car in a tunnel on the right, and gets back to it from further off', () => {
    const bore = [{ s0: 900, s1: 1300 }];
    expect(chooseLane({ ...me, off: -1.9 }, [], [car(150, -1)], KEEP_RIGHT, 140, null, bore).lane).toBeGreaterThan(KEEP_RIGHT);
    expect(chooseLane({ ...me, off: -1.9 }, [], [car(150, -1)], KEEP_RIGHT).lane).toBe(KEEP_RIGHT);
    expect(chooseLane(me, [], [car(120, -1)], KEEP_RIGHT).lane).toBe(KEEP_RIGHT);
  });

  it('passes another racer close ahead in its lane', () => {
    expect(chooseLane({ ...me, off: 0 }, [{ s: 1010, off: 0.3, v: 15, len: 12 }], [], 0).lane).toBeLessThan(0);
  });
});

describe('place calls', () => {
  it('announces a place once it holds, not while two buses swap side by side', () => {
    const c = new PlaceCaller();
    expect(c.update(0.1, 3)).toBeNull();
    // Alongside: 2, 3, 2, 3 every few frames says nothing.
    for (let i = 0; i < 20; i++) expect(c.update(0.1, i % 2 ? 2 : 3)).toBeNull();
    let call = null;
    for (let t = 0; t <= PLACE_SETTLE + 0.2 && !call; t += 0.1) call = c.update(0.1, 2);
    expect(call).toEqual({ place: 2, gained: true });
    // Said once.
    expect(c.update(1, 2)).toBeNull();
    for (let t = 0; t <= PLACE_SETTLE + 0.2 && call; t += 0.1) call = c.update(0.1, 4);
    for (let t = 0; t <= PLACE_SETTLE + 0.2 && !call; t += 0.1) call = c.update(0.1, 4);
    expect(call).toEqual({ place: 4, gained: false });
  });

  it('back in its place before it settles: nothing to say', () => {
    const c = new PlaceCaller();
    c.reset(2);
    c.update(PLACE_SETTLE / 2, 1);
    for (let i = 0; i < 20; i++) expect(c.update(0.1, 2)).toBeNull();
  });
});

describe('online finish', () => {
  it('after the player finishes, the others still finish on the shared clock', () => {
    const g = new RaceGame(['Tú', 'Ana'], 100, { estimate: false });
    g.update(0.1, [0, 0], true, 0.5);
    g.update(0.1, [0, 0], true, -0.1);
    let ev = g.update(0.1, [100, 40], true, -10);
    expect(ev.map((e) => e.type)).toEqual(['finish', 'over']);
    expect(g.racers[1].time).toBeNull();
    ev = g.update(0.1, [100, 100], true, -14);
    expect(ev).toEqual([{ type: 'finish', racer: 1, place: 2, time: 14 }]);
    expect(g.ranking()).toEqual([0, 1]);
  });
});

describe('lanes on a street circuit', () => {
  const room = { left: 4, right: 4, lap: 1565 };
  const me = { s: 100, off: 0, v: 20, len: 11 };
  const slow = { s: 110, off: 0.2, v: 12, len: 11 };

  it('a slower racer ahead is passed at once, whatever the oncoming half (nobody comes the other way)', () => {
    const way = chooseLane(me, [slow], [], 0, SKILLS.hard.passClear, null, null, room);
    expect(way.limit).toBe(Infinity);
    expect(way.lane).toBeLessThan(0);
  });

  it('passes on the side with room: the far side of the car if it fits, else the other', () => {
    expect(chooseLane({ ...me, off: 3 }, [{ ...slow, off: 2.8 }], [], 0, 110, null, null, room).lane).toBeLessThan(0);
    expect(chooseLane({ ...me, off: -3 }, [{ ...slow, off: -3.2 }], [], 0, 110, null, null, room).lane).toBeGreaterThan(0);
    // The car to our left, the wall to our right: the lane takes what is there.
    const lane = chooseLane({ ...me, off: 1.9 }, [{ ...slow, off: 1.6 }], [], 0, 110, null, null, { ...room, right: 3.6 }).lane;
    expect(Math.abs(lane)).toBeLessThanOrEqual(1.9);
  });

  it('with no room either side it follows at the slower racer’s speed', () => {
    const way = chooseLane(me, [slow], [], 0, 110, null, null, { left: 1, right: 1, lap: 1565 });
    expect(way.limit).toBeLessThan(slow.v + 0.5);
    expect(way.lane).toBe(0);
  });

  it('a racer a lap down is a slower one ahead, a faster one is followed, not passed', () => {
    expect(chooseLane(me, [{ ...slow, s: 110 - 1565 }], [], 0, 110, null, null, room).lane).not.toBe(0);
    expect(chooseLane(me, [{ ...slow, s: 110 + 1565 }], [], 0, 110, null, null, room).lane).not.toBe(0);
    expect(chooseLane(me, [{ ...slow, v: 30 }], [], 0, 110, null, null, room)).toEqual({ lane: 0, limit: Infinity });
  });

  it('the mountain rules are unchanged without a room: an oncoming car holds a pass on the left half', () => {
    const oncoming = [{ s: 160, off: -1.5, v: 15, len: 11, dir: -1 as const }];
    const way = chooseLane(me, [slow], oncoming, 0, 110);
    expect(way.lane).toBeGreaterThan(0);
    expect(way.limit).toBeLessThan(Infinity);
  });
});

describe('the racing line on the Zona Rosa', () => {
  const HALF = 1.25;
  const LEN = 11;
  let race: Awaited<ReturnType<typeof loadZone>>['race'] & object;
  let line: ReturnType<typeof racingLine>;
  /** Signed turn (rad, + right) over 24 m round each 3 m sample of the centerline. */
  let turn: number[];
  beforeAll(async () => {
    race = (await loadZone('zonarosa')).race!;
    line = racingLine(race, HALF, LEN);
    const a = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
    const b = { x: 0, z: 0, y: 0, dx: 1, dz: 0 };
    turn = Array.from(line.off, (_, i) => {
      trackPoint(race, i * 3 - 12, a);
      trackPoint(race, i * 3 + 12, b);
      return Math.asin(Math.max(-1, Math.min(1, a.dx * b.dz - a.dz * b.dx)));
    });
  });

  it('never comes nearer a barrier than the clearance plus its half width', () => {
    const e = race.edges!;
    for (let i = 0; i < line.off.length; i++) {
      const j = race.cum.findIndex((c) => c >= i * 3);
      const at = Math.max(0, j);
      expect(line.off[i]).toBeLessThanOrEqual(e.right[at] - BARRIER_GAP - HALF + 0.3);
      expect(line.off[i]).toBeGreaterThanOrEqual(-(e.left[at] - BARRIER_GAP - HALF) - 0.3);
    }
  });

  it('keeps to the carriageway on the straights, well clear of any corner', () => {
    const e = race.edges!;
    let checked = 0;
    for (let i = 20; i < line.off.length - 20; i++) {
      // No corner within 60 m either way.
      if (turn.slice(i - 20, i + 21).some((t) => Math.abs(t) > 0.12)) continue;
      const j = Math.max(0, race.cum.findIndex((c) => c >= i * 3));
      expect(Math.abs(line.off[i])).toBeLessThanOrEqual(e.road![j] - HALF + 0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('swings outside, inside, outside round a corner of its own, and uses more than the carriageway somewhere', () => {
    const e = race.edges!;
    let swung = 0;
    let wide = false;
    for (let i = 40; i < line.off.length - 40; i++) {
      // The sharpest point of an isolated corner (more than 60 m from the next one).
      const t = turn[i];
      if (Math.abs(t) < 0.5 || turn.slice(i - 20, i + 21).some((u, k) => k !== 20 && Math.abs(u) > Math.abs(t))) continue;
      if (turn.slice(i - 40, i - 12).some((u) => Math.abs(u) > 0.5) || turn.slice(i + 12, i + 41).some((u) => Math.abs(u) > 0.5)) continue;
      const dir = Math.sign(t);
      // Inside at the apex (more toward the turn than 30 m before and after).
      if (line.off[i] * dir > line.off[i - 10] * dir + 0.5 && line.off[i] * dir > line.off[i + 10] * dir + 0.5) swung++;
    }
    for (let i = 0; i < line.off.length; i++) if (Math.abs(line.off[i]) > e.road![Math.max(0, race.cum.findIndex((c) => c >= i * 3))] - HALF + 0.3) wide = true;
    expect(swung).toBeGreaterThanOrEqual(2);
    expect(wide).toBe(true);
  });

  it('the speed plan follows the line: no slower round a corner than on the centerline, and faster overall', () => {
    const on = speedProfile(race, 8, 8, 25, line);
    const centre = speedProfile(race, 8, 8, 25, null);
    const mean = (v: Float32Array) => v.reduce((a, b) => a + b, 0) / v.length;
    expect(Math.min(...on)).toBeGreaterThanOrEqual(Math.min(...centre) - 0.01);
    expect(mean(on)).toBeGreaterThan(mean(centre));
  });

  it('a longer vehicle keeps further off the inside of a bend (its rear swings in)', () => {
    const long = racingLine(race, HALF, 18.4);
    let inner = 0;
    for (let i = 0; i < line.off.length; i++) if (Math.abs(turn[i]) > 0.5 && long.off[i] * Math.sign(turn[i]) < line.off[i] * Math.sign(turn[i])) inner++;
    expect(inner).toBeGreaterThan(10);
  });
});

describe('the line planner edge cases', () => {
  it('a gap narrower than the clearances on both sides gets the midpoint, never min above max', () => {
    // A straight 1.0 m left / 2.0 m right of the centerline: far less than 2 x (gap + half width).
    const n = 40;
    const points = Array.from({ length: n }, (_, i) => ({ x: i * 3, z: 0 }));
    const track = {
      points,
      y: points.map(() => 0),
      cum: points.map((p) => p.x),
      edges: { left: points.map(() => 1), right: points.map(() => 2), road: points.map(() => 1) },
    } as unknown as TrackData;
    const line = racingLine(track, 1.25, 11);
    for (let i = 0; i < line.min.length; i++) {
      expect(line.min[i]).toBeLessThanOrEqual(line.max[i]);
      expect(line.min[i]).toBeCloseTo(line.max[i], 6);
      expect(line.off[i]).toBeCloseTo(line.min[i], 3);
    }
  });

  it('without a line the speed plan of a mountain track is what it always was', () => {
    const papallacta = JSON.parse(readFileSync('data/cities/papallacta.json', 'utf8')).race as TrackData;
    const v = speedProfile(papallacta, 10, 8, 30);
    expect(v.length).toBe(1686);
    expect(Math.min(...v)).toBeCloseTo(17.8549, 3);
    expect(v.indexOf(Math.min(...v))).toBe(244);
    expect(v.reduce((a, b) => a + b, 0)).toBeCloseTo(49208.73, 1);
  });
});
