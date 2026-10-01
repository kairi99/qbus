import type { Vec2 } from '../world/cityData';
import { RouteGame, type RouteStop } from './routeGame';

/**
 * Average speeds (m/s, along the legal streets between stops) of the model drivers that set a
 * route's star thresholds: about 29, 40 and 50 km/h door to door. Trick money isn't counted,
 * so drifting and close calls make up for a slower drive.
 */
export const STAR_SPEEDS = [8, 11, 14] as const;
/** Seconds the model loses braking into each stop. */
const DWELL = 3;
/** Reference capacity: the thresholds don't depend on the bus. */
const CAPACITY = 40;
const SEEDS = [1, 2, 3, 4, 5, 6];
const STEP = 0.25;
/** Never fewer than this many cents per star tier (one fare, two, four...). */
const FLOOR = [35, 100, 200] as const;

export type StarThresholds = [number, number, number];

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Money (cents) a driver averaging `speed` m/s ends a shift with (fares and tips), under the
 * real rules. `legs[i]` is the driving distance into stop i from the stop before it.
 */
export function modelShift(route: RouteStop[], legs: number[], start: Vec2, speed: number, seed: number): number {
  const game = new RouteGame(route, { seed, capacity: CAPACITY, start });
  game.start();
  for (let n = 0; !game.over && n < 500; n++) {
    const i = game.activeIndex;
    const to = game.activeStop.zone;
    const len = n === 0 ? dist(start, to) : legs[i];
    const wait = len / speed + DWELL;
    // On the way, nowhere near the stop.
    const away = { x: to.x + 1e4, z: to.z };
    let t = 0;
    while (!game.over && t + STEP < wait) {
      game.update(STEP, { pos: away, speed });
      t += STEP;
    }
    if (game.over) break;
    game.update(wait - t, { pos: to, speed: 0 });
  }
  return game.cents;
}

/**
 * Money needed for 1, 2 and 3 stars on a route, from model drivers playing it by the rules
 * (averaged over a few passenger draws), so a route with long legs or detours through one-way
 * streets asks for less than a tight one.
 */
export function starThresholds(route: RouteStop[], legs: number[], start: Vec2): StarThresholds {
  let prev = 0;
  return STAR_SPEEDS.map((speed, k) => {
    const avg = SEEDS.reduce((s, seed) => s + modelShift(route, legs, start, speed, seed), 0) / SEEDS.length;
    // Rounded to 5 cents, and each tier clearly above the one before.
    prev = Math.max(prev + 25, FLOOR[k], Math.round(avg / 5) * 5);
    return prev;
  }) as StarThresholds;
}

/** 0..3 stars for a shift's money. */
export function starsFor(cents: number, t: StarThresholds): number {
  return t.filter((c) => cents >= c).length;
}
