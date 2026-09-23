import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/world/procCity';
import { buildRoute, RouteGame, FARE_CENTS, START_TIME, ZONE_RADIUS, type GameEvent } from '../src/gameplay/routeGame';
import type { Vec2 } from '../src/world/cityData';

const city = generateCity({ seed: 42 });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

function newGame(seed = 1, capacity = 30) {
  const route = buildRoute(city, { count: 6 });
  const game = new RouteGame(route, { seed, capacity, start: city.spawn.pos });
  game.start();
  return { route, game };
}

/** Park at the active stop and let the game service it. */
function arrive(game: RouteGame, after = 5): GameEvent[] {
  const zone = game.activeStop.zone;
  const events = game.update(after, { pos: { x: zone.x + 3, z: zone.z }, speed: 5 }); // rolling in: not yet
  return [...events, ...game.update(0.1, { pos: zone, speed: 0.5 })];
}

describe('buildRoute', () => {
  const route = buildRoute(city, { count: 8 });

  it('picks distinct stops, spaced apart', () => {
    expect(route).toHaveLength(8);
    expect(new Set(route.map((r) => r.stop.id)).size).toBe(8);
    for (let i = 0; i < route.length - 1; i++) expect(dist(route[i].stop.pos, route[i + 1].stop.pos)).toBeGreaterThan(80);
  });

  it('starts near the spawn point', () => {
    const d0 = dist(route[0].stop.pos, city.spawn.pos);
    const farther = city.stops.filter((s) => dist(s.pos, city.spawn.pos) < d0).length;
    expect(farther).toBeLessThan(city.stops.length / 3);
  });

  it('puts each stop zone on the road beside its shelter', () => {
    for (const r of route) {
      const d = dist(r.zone, r.stop.pos);
      expect(d).toBeGreaterThan(2);
      expect(d).toBeLessThan(ZONE_RADIUS);
    }
  });
});

describe('RouteGame', () => {
  it('waits for start() before the clock runs', () => {
    const game = new RouteGame(buildRoute(city, { count: 6 }), { seed: 1, capacity: 30, start: city.spawn.pos });
    game.update(10, { pos: city.spawn.pos, speed: 0 });
    expect(game.timeLeft).toBe(START_TIME);
  });

  it('seeds every stop with waiting passengers bound for later stops', () => {
    const { game, route } = newGame();
    for (let i = 0; i < route.length; i++) {
      const waiting = game.waitingAt(i);
      expect(waiting.length).toBeGreaterThan(0);
      for (const p of waiting) {
        expect(p.from).toBe(i);
        expect(p.to).not.toBe(i);
        const ahead = (p.to - p.from + route.length) % route.length;
        expect(ahead).toBeGreaterThanOrEqual(1);
        expect(ahead).toBeLessThanOrEqual(3);
      }
    }
  });

  it('only services a stop when the bus actually stops inside the zone', () => {
    const { game } = newGame();
    const zone = game.activeStop.zone;
    expect(game.update(1, { pos: zone, speed: 10 })).toEqual([]); // blasting through
    expect(game.update(1, { pos: { x: zone.x + ZONE_RADIUS + 5, z: zone.z }, speed: 0 })).toEqual([]); // stopped too far
    const events = game.update(0.1, { pos: zone, speed: 0.5 });
    expect(events.some((e) => e.type === 'arrive')).toBe(true);
  });

  it('boards the waiting passengers and advances to the next stop', () => {
    const { game } = newGame();
    const waiting = game.waitingAt(0).length;
    const events = arrive(game);
    const a = events.find((e) => e.type === 'arrive')!;
    expect(a.type === 'arrive' && a.boarded.length).toBe(waiting);
    expect(game.onBoard).toHaveLength(waiting);
    expect(game.activeIndex).toBe(1);
  });

  it('respects capacity', () => {
    const { game } = newGame(1, 1);
    arrive(game);
    expect(game.onBoard).toHaveLength(1);
  });

  it('drops passengers at their destination, paying fare plus a speed tip', () => {
    const { game, route } = newGame(3);
    const riders = new Map<number, number>();
    let paid = 0;
    let fares = 0;
    for (let lap = 0; lap < route.length + 3; lap++) {
      const events = arrive(game, 2); // fast legs
      for (const e of events) {
        if (e.type !== 'fare') continue;
        fares++;
        paid += e.cents;
        expect(e.passenger.to).toBe((game.activeIndex - 1 + route.length) % route.length);
        expect(e.cents).toBeGreaterThanOrEqual(FARE_CENTS);
        riders.set(e.passenger.id, (riders.get(e.passenger.id) ?? 0) + 1);
      }
    }
    expect(fares).toBeGreaterThan(3);
    expect([...riders.values()].every((n) => n === 1)).toBe(true);
    expect(game.cents).toBe(paid);
    expect(game.delivered).toBe(fares);
  });

  it('tips fast rides more than slow ones', () => {
    const tips = (legSeconds: number) => {
      const { game } = newGame(5);
      let total = 0;
      let n = 0;
      for (let i = 0; i < 5; i++) {
        game.timeLeft = 1e4; // keep the clock from running out on slow runs
        for (const e of arrive(game, legSeconds)) if (e.type === 'fare') (total += e.cents - FARE_CENTS), n++;
      }
      return total / n;
    };
    expect(tips(2)).toBeGreaterThan(tips(120));
  });

  it('adds bonus time for quick legs', () => {
    const quick = newGame().game;
    const before = quick.timeLeft;
    const a = arrive(quick, 3).find((e) => e.type === 'arrive')!;
    expect(a.type === 'arrive' && a.timeBonus).toBeGreaterThan(0);
    expect(quick.timeLeft).toBeGreaterThan(before - 3.2);
  });

  it('warns once when approaching a stop where someone gets off', () => {
    const { game } = newGame(3);
    arrive(game, 2);
    arrive(game, 2);
    const next = game.activeStop.zone;
    const getsOff = game.onBoard.some((p) => p.to === game.activeIndex);
    const near = { x: next.x + 50, z: next.z };
    const a = game.update(0.1, { pos: near, speed: 10 });
    const b = game.update(0.1, { pos: near, speed: 10 });
    expect(a.filter((e) => e.type === 'approach').length).toBe(getsOff ? 1 : 0);
    expect(b.filter((e) => e.type === 'approach')).toEqual([]);
  });

  it('ends when the clock runs out, once', () => {
    const { game } = newGame();
    const events = game.update(START_TIME + 1, { pos: city.spawn.pos, speed: 0 });
    expect(events.filter((e) => e.type === 'gameOver')).toHaveLength(1);
    expect(game.over).toBe(true);
    expect(game.update(1, { pos: game.activeStop.zone, speed: 0 })).toEqual([]);
  });

  it('adds trick money to the score', () => {
    const { game } = newGame();
    game.addTrickCents(40);
    expect(game.cents).toBe(40);
  });
});
