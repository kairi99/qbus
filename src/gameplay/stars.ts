import type { Vec2 } from '../world/cityData';
import { MISSIONS } from './missions';
import { RouteGame, type RouteStop } from './routeGame';

/**
 * The model driver behind each star: door-to-door pace (m/s along the legal streets from stop
 * to stop, corners and braking included), trick money per second of the shift, and missions
 * completed. The paces are what the real physics bus keeps when an autopilot drives it
 * (`tools/sim-shift.ts`, no traffic): 9.5 m/s cruising at 40 km/h, 13 at 60 km/h with nitro,
 * 16 flat out with handbrake drifts (which earns it 0.6 to 4 cents a second in tricks).
 *  - 1 star: a steady, clean shift; fares and tips only.
 *  - 2 stars: a quick shift with some tricks and a mission done.
 *  - 3 stars: an expert run flat out, chaining tricks all the way, two missions done.
 */
export const STAR_TIERS = [
  { pace: 9.5, tricks: 0, missions: 0 },
  { pace: 13, tricks: 0.5, missions: 1 },
  { pace: 16, tricks: 2, missions: 2 },
] as const;
/** Reference capacity: the thresholds don't depend on the bus. */
const CAPACITY = 40;
const SEEDS = [1, 2, 3, 4, 5, 6];
const STEP = 0.25;
/** A mission's bonus, on average over the pool. */
const MISSION_CENTS = MISSIONS.reduce((s, m) => s + m.reward, 0) / MISSIONS.length;
/** Never fewer than this many cents per star tier, and each tier this far above the last. */
const FLOOR = [50, 150, 300] as const;
const GAP = 50;

export type StarThresholds = [number, number, number];

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * A model shift under the real rules: a driver averaging `pace` m/s door to door. Returns the
 * fares and tips it earns (cents) and how long the shift lasts (time bonuses included).
 * `legs[i]` is the driving distance into stop i from the stop before it.
 */
export function modelShift(route: RouteStop[], legs: number[], start: Vec2, pace: number, seed: number): { cents: number; seconds: number } {
  const game = new RouteGame(route, { seed, capacity: CAPACITY, start });
  game.start();
  let seconds = 0;
  for (let n = 0; !game.over && n < 500; n++) {
    const i = game.activeIndex;
    const to = game.activeStop.zone;
    const len = n === 0 ? dist(start, to) : legs[i];
    const wait = len / pace;
    // On the way, nowhere near the stop.
    const away = { x: to.x + 1e4, z: to.z };
    let t = 0;
    while (!game.over && t + STEP < wait) {
      game.update(STEP, { pos: away, speed: pace });
      t += STEP;
    }
    seconds += t;
    if (game.over) break;
    game.update(wait - t, { pos: to, speed: 0 });
    seconds += wait - t;
  }
  return { cents: game.cents, seconds };
}

/**
 * Money needed for 1, 2 and 3 stars on a route: what each tier's model driver earns there
 * (fares and tips under the real rules, averaged over a few passenger draws, plus its tricks
 * over the shift and its missions). A route with long legs or detours through one-way streets
 * asks for less fare money than a tight one; tricks and missions ask the same everywhere.
 */
export function starThresholds(route: RouteStop[], legs: number[], start: Vec2): StarThresholds {
  let prev = 0;
  return STAR_TIERS.map((tier, k) => {
    let sum = 0;
    for (const seed of SEEDS) {
      const { cents, seconds } = modelShift(route, legs, start, tier.pace, seed);
      sum += cents + tier.tricks * seconds;
    }
    const avg = sum / SEEDS.length + tier.missions * MISSION_CENTS;
    // Rounded to 5 cents, and each tier clearly above the one before.
    prev = Math.max(prev + GAP, FLOOR[k], Math.round(avg / 5) * 5);
    return prev;
  }) as StarThresholds;
}

/** 0..3 stars for a shift's money. */
export function starsFor(cents: number, t: StarThresholds): number {
  return t.filter((c) => cents >= c).length;
}
