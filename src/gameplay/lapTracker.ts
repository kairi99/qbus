/**
 * The player's laps in a circuit race, pure: which closed laps are new since the last look (a frame
 * can cross two lines), whether one beats the race's best so far (the "¡Vuelta rápida!" banner), and
 * the lap record saved once, at the finish (only a finished race counts).
 */
export class LapTracker {
  private seen = 0;
  /** Best lap of this race so far (s; Infinity: none). */
  best = Infinity;

  /** `laps`: every lap time so far. Returns the faster-than-before ones, after the first lap, to announce. */
  step(laps: readonly number[], fast: number[] = []): number[] {
    fast.length = 0;
    for (; this.seen < laps.length; this.seen++) {
      const t = laps[this.seen];
      if (t < this.best) {
        if (this.seen > 0) fast.push(t);
        this.best = t;
      }
    }
    return fast;
  }

  /** At the player's finish: hand the best lap to `record` (it says whether it's a new record). Nothing before. */
  settle(record: (lap: number) => boolean): boolean {
    return Number.isFinite(this.best) && record(this.best);
  }

  reset(): void {
    this.seen = 0;
    this.best = Infinity;
  }
}
