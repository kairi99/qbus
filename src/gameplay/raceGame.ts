/**
 * The rules of a race, pure: a grid wait, the 3-2-1 countdown, then each racer's progress along
 * the track (meters from the start line) until the player crosses the finish. Positions come
 * from progress (the finished first, by time). When the player finishes the race is over; a
 * racer still on the road gets a time from its own pace so far (with a small cushion).
 */

/** Seconds per count (3, 2, 1) and of the grid wait before it. */
export const COUNT_STEP = 1;
export const GRID_WAIT = 1.2;

export type RacePhase = 'grid' | 'countdown' | 'racing' | 'over';

export type RaceEvent =
  | { type: 'count'; n: number }
  | { type: 'go' }
  | { type: 'overtake'; place: number; gained: boolean }
  | { type: 'finish'; racer: number; place: number; time: number }
  | { type: 'over' };

export interface Racer {
  name: string;
  /** Meters past the start line (negative on the grid behind it). */
  s: number;
  /** Race time at the finish, null until then. */
  time: number | null;
  /** Finish time estimated from its pace when the race ended without it. */
  estimated: boolean;
}

export class RaceGame {
  phase: RacePhase = 'grid';
  /** Race time since GO (s). */
  time = 0;
  readonly racers: Racer[];
  private wait = GRID_WAIT;
  private count = 3;
  private lastPlace = 0;
  private order: number[] = [];

  /** `names[0]` is the player. `length`: start line to finish (m). */
  constructor(
    names: string[],
    readonly length: number,
  ) {
    this.racers = names.map((name) => ({ name, s: 0, time: null, estimated: false }));
    this.order = names.map((_, i) => i);
  }

  /** The countdown runs (from the grid wait). */
  get started(): boolean {
    return this.phase !== 'grid' || this.wait < GRID_WAIT;
  }

  /** Seconds to GO while counting down (3.., 0 at GO). */
  get countLeft(): number {
    return this.phase === 'countdown' ? this.count : this.phase === 'grid' ? 3 + COUNT_STEP : 0;
  }

  /** Racers may move: the race is on (or over). */
  get green(): boolean {
    return this.phase === 'racing' || this.phase === 'over';
  }

  /** `progress[i]`: racer i's meters past the start line. Nothing moves the clock in 'grid' until `begin`. */
  update(dt: number, progress: readonly number[], begun = true): RaceEvent[] {
    const ev: RaceEvent[] = [];
    // On the grid and counting down, places are the grid's order (the player starts at the back).
    if (this.phase === 'grid' || this.phase === 'countdown') {
      this.racers.forEach((r, i) => (r.s = progress[i]));
      this.order = this.ranking();
      this.lastPlace = this.placeOf(0);
    }
    if (this.phase === 'grid') {
      if (!begun) return ev;
      this.wait -= dt;
      if (this.wait <= 0) {
        this.phase = 'countdown';
        this.count = 3;
        ev.push({ type: 'count', n: 3 });
      }
      return ev;
    }
    if (this.phase === 'countdown') {
      const before = Math.ceil(this.count);
      this.count -= dt / COUNT_STEP;
      const now = Math.ceil(this.count);
      if (this.count <= 0) {
        this.phase = 'racing';
        ev.push({ type: 'go' });
      } else if (now !== before) ev.push({ type: 'count', n: now });
      return ev;
    }
    if (this.phase === 'over') return ev;
    this.time += dt;
    this.racers.forEach((r, i) => {
      r.s = progress[i];
      if (r.time === null && r.s >= this.length) {
        r.time = this.time;
        ev.push({ type: 'finish', racer: i, place: this.racers.filter((o) => o.time !== null).length, time: r.time });
      }
    });
    this.order = this.ranking();
    const place = this.placeOf(0);
    if (this.lastPlace && place !== this.lastPlace) ev.push({ type: 'overtake', place, gained: place < this.lastPlace });
    this.lastPlace = place;
    if (this.racers[0].time !== null) {
      this.phase = 'over';
      // Everyone still racing gets a time from their pace so far (and a 3% cushion: they'd tire).
      for (const r of this.racers)
        if (r.time === null) {
          const pace = Math.max(1, r.s) / this.time;
          r.time = this.time + ((this.length - r.s) / pace) * 1.03;
          r.estimated = true;
        }
      this.order = this.ranking();
      ev.push({ type: 'over' });
    }
    return ev;
  }

  /** Racer indices, first to last. */
  ranking(): number[] {
    return this.racers
      .map((_, i) => i)
      .sort((a, b) => {
        const [ra, rb] = [this.racers[a], this.racers[b]];
        if (ra.time !== null && rb.time !== null) return ra.time - rb.time;
        if (ra.time !== null) return -1;
        if (rb.time !== null) return 1;
        return rb.s - ra.s;
      });
  }

  /** 1-based place of racer `i`. */
  placeOf(i: number): number {
    return this.order.indexOf(i) + 1;
  }
}

/** "1:23.4" */
export function raceClock(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/** How long (s) a new place must hold before it's announced: two buses side by side swap back and forth. */
export const PLACE_SETTLE = 0.7;

/**
 * Announces the player's place changes once they settle: `update` returns the new place and
 * whether it was gained, once per change that holds for `PLACE_SETTLE`, else null.
 */
export class PlaceCaller {
  private shown = 0;
  private pending = 0;
  private held = 0;

  /** Start over from `place` (announced as is). */
  reset(place: number): void {
    this.shown = this.pending = place;
    this.held = 0;
  }

  update(dt: number, place: number): { place: number; gained: boolean } | null {
    if (!this.shown) this.reset(place);
    if (place !== this.pending) {
      this.pending = place;
      this.held = 0;
      return null;
    }
    this.held += dt;
    if (this.held < PLACE_SETTLE || place === this.shown) return null;
    const gained = place < this.shown;
    this.shown = place;
    return { place, gained };
  }
}
