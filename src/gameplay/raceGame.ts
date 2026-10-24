/**
 * The rules of a race, pure: a grid wait, the 3-2-1 countdown, then each racer's progress along
 * the track (meters from the start line) until the player crosses the finish. Positions come
 * from progress (the finished first, by time). When the player finishes the phase is 'over' but
 * scoring goes on; `estimateRest` gives a racer still on the road a time from its own pace.
 */

/** Seconds per count (3, 2, 1) and of the grid wait before it. */
export const COUNT_STEP = 1;
export const GRID_WAIT = 1.2;

/** A forward step over this many meters AND faster than this many m/s between two updates is a teleport, not driving. */
const TELEPORT_M = 50;
const TELEPORT_SPEED = 200;

export type RacePhase = 'grid' | 'countdown' | 'racing' | 'over';

export type RaceEvent =
  | { type: 'count'; n: number }
  | { type: 'go' }
  | { type: 'overtake'; place: number; gained: boolean }
  | { type: 'finish'; racer: number; place: number; time: number }
  /** Racer crossed the line into `lap` (2..laps); `time` = the lap just completed (s). The last lap's time comes with 'finish'. */
  | { type: 'lap'; racer: number; lap: number; time: number }
  | { type: 'over' };

export interface Racer {
  name: string;
  /** Meters past the start line (negative on the grid behind it). */
  s: number;
  /** Race time at the finish, null until then. */
  time: number | null;
  /** Finish time estimated from its pace when the race ended without it. */
  estimated: boolean;
  /** Current lap, 1..laps (1 without laps). Never goes back, whatever an R reset does. */
  lap: number;
  /** Times (s) of the laps completed so far; at the finish they sum to `time`. */
  lapTimes: number[];
  /** Fastest of `lapTimes` (s), null before the first. */
  best: number | null;
}

/** The racer's fastest completed lap (s), null before the first. */
export function bestLap(r: Racer): number | null {
  return r.best;
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
  /** Last count announced on an external clock. */
  private shown = 0;
  /** Race time each racer's current lap began (s). */
  private lapAt: number[];
  /** Each racer's progress at the last racing update (NaN: none yet, its first sample is judged on its own). */
  private prevS: number[];

  /**
   * `names[0]` is the player. `length`: start line to finish (m). `estimate: false` (online):
   * `estimateRest` does nothing, racers still on the road keep a null time until `setTime`.
   * `laps` (a circuit): `length` is `count` x `lap` meters; each line crossed by a racer's progress
   * starts the next lap (once: going back over one never un-counts or repeats it).
   */
  constructor(
    names: string[],
    readonly length: number,
    private readonly opts: { estimate?: boolean; laps?: { count: number; lap: number } } = {},
  ) {
    this.racers = names.map((name) => ({ name, s: 0, time: null, estimated: false, lap: 1, lapTimes: [], best: null }));
    this.lapAt = names.map(() => 0);
    this.prevS = names.map(() => NaN);
    this.order = names.map((_, i) => i);
  }

  /**
   * Racer `i` was put back at `progress` m by a resume (online page back): the lines before it count as crossed,
   * with no lap event and no time: the lap it is on has no known start, so it is not timed either.
   */
  skipTo(i: number, progress: number): void {
    const laps = this.opts.laps;
    const r = this.racers[i];
    if (!laps) return;
    r.lap = Math.max(r.lap, Math.min(laps.count, Math.floor(progress / laps.lap) + 1));
    if (r.lap > 1) this.lapAt[i] = NaN;
    this.prevS[i] = NaN;
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

  /**
   * `progress[i]`: racer i's meters past the start line. Nothing moves the clock in 'grid' until `begun`.
   * `goIn` (online): seconds to GO on the shared clock (negative after): it sets the phase, the count
   * and the race time; `begun` and the grid wait are ignored.
   */
  update(dt: number, progress: readonly number[], begun = true, goIn?: number): RaceEvent[] {
    const ev: RaceEvent[] = [];
    // On the grid and counting down, places are the grid's order (the player starts at the back).
    if (this.phase === 'grid' || this.phase === 'countdown') {
      this.racers.forEach((r, i) => (r.s = progress[i]));
      this.order = this.ranking();
      this.lastPlace = this.placeOf(0);
    }
    if (goIn !== undefined && (this.phase === 'grid' || this.phase === 'countdown')) {
      this.count = goIn / COUNT_STEP;
      if (goIn <= 0) {
        this.phase = 'racing';
        this.time = -goIn;
        ev.push({ type: 'go' });
      } else if (goIn <= 3 * COUNT_STEP) {
        this.phase = 'countdown';
        const n = Math.ceil(this.count);
        if (n !== this.shown) ev.push({ type: 'count', n });
        this.shown = n;
      }
      return ev;
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
    // The race goes on after the player's finish: the others' crossings still count (online the
    // host reports its AI's times to the server; solo they can be watched, or `estimateRest`).
    const over = this.phase === 'over';
    const t0 = this.time;
    this.time = goIn !== undefined ? -goIn : this.time + dt;
    this.racers.forEach((r, i) => {
      r.s = progress[i];
      const laps = this.opts.laps;
      if (laps && r.time === null) {
        const p0 = this.prevS[i];
        // First sample (a late join, a resume), or a jump no bus drives (a remote's first snapshot, far on): lines already behind it are not crossings, and that lap has no known start.
        if (Number.isNaN(p0) || (r.s - p0 > TELEPORT_M && r.s - p0 > TELEPORT_SPEED * (this.time - t0))) {
          const at = Math.min(laps.count, Math.floor(Math.max(0, r.s) / laps.lap) + 1);
          if (at > r.lap) r.lap = at;
          if (r.lap > 1) this.lapAt[i] = NaN;
        }
        // Lines crossed in order, each at its interpolated time; the last one is the finish (below), which closes the final lap.
        while (r.lap < laps.count && r.s >= r.lap * laps.lap) {
          const line = r.lap * laps.lap;
          const k = r.s > p0 ? Math.max(0, Math.min(1, (line - p0) / (r.s - p0))) : 1;
          const at = Number.isNaN(p0) ? this.time : t0 + (this.time - t0) * k;
          const t = at - this.lapAt[i];
          this.lapAt[i] = at;
          r.lap++;
          if (!Number.isNaN(t)) {
            r.lapTimes.push(t);
            if (r.best === null || t < r.best) r.best = t;
            ev.push({ type: 'lap', racer: i, lap: r.lap, time: t });
          }
        }
        this.prevS[i] = r.s;
      }
      if (r.time === null && r.s >= this.length) {
        r.time = this.time;
        if (laps && !Number.isNaN(this.lapAt[i])) {
          const t = this.time - this.lapAt[i];
          r.lapTimes.push(t);
          if (r.best === null || t < r.best) r.best = t;
        }
        ev.push({ type: 'finish', racer: i, place: this.racers.filter((o) => o.time !== null).length, time: r.time });
      }
    });
    this.order = this.ranking();
    if (over) return ev;
    const place = this.placeOf(0);
    if (this.lastPlace && place !== this.lastPlace) ev.push({ type: 'overtake', place, gained: place < this.lastPlace });
    this.lastPlace = place;
    if (this.racers[0].time !== null) {
      this.phase = 'over';
      this.order = this.ranking();
      ev.push({ type: 'over' });
    }
    return ev;
  }

  /** Every racer has a time. */
  get allDone(): boolean {
    return this.racers.every((r) => r.time !== null);
  }

  /**
   * Gives everyone still racing a time from their pace so far (and a 3% cushion: they'd tire).
   * No-op online (`estimate: false`): the real times come from the server.
   */
  estimateRest(): void {
    if (this.opts.estimate === false) return;
    for (const r of this.racers)
      if (r.time === null) {
        const pace = Math.max(1, r.s) / this.time;
        r.time = this.time + ((this.length - r.s) / pace) * 1.03;
        r.estimated = true;
      }
    this.order = this.ranking();
  }

  /** Fills racer `i`'s real time (the server's results) and re-ranks. */
  setTime(i: number, time: number): void {
    this.racers[i].time = time;
    this.racers[i].estimated = false;
    this.order = this.ranking();
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

  /** Racer at 1-based `place` as of the last update (no allocation, unlike `ranking`). */
  racerAt(place: number): number {
    return this.order[place - 1];
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
