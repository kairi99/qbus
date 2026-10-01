/** A full tank burns out in this many seconds. */
export const NITRO_DURATION = 1.5;
/** Tank refilled per second of drifting. */
const DRIFT_FILL_PER_SEC = 0.2;
/** Tank refilled by each close call with a car (or a pedestrian diving away). */
const NEAR_MISS_FILL = 0.2;
/** A new burst needs at least half a tank (no tapping it on fumes); a burst in progress runs dry. */
export const MIN_TO_START = 0.5;

/**
 * Nitro tank: starts full, burns out fast while held, and only refills by driving recklessly
 * (drifting and close calls), never by waiting.
 */
export class Nitro {
  /** 0..1 */
  level = 1;
  /** Burning this step. */
  active = false;

  /** Enough in the tank to start a burst. */
  get ready(): boolean {
    return this.level >= MIN_TO_START;
  }

  /** Burns nitro while `held`; returns whether the boost is on this step. */
  step(held: boolean, dt: number): boolean {
    this.active = held && (this.active ? this.level > 0 : this.ready);
    if (this.active) this.level = Math.max(0, this.level - dt / NITRO_DURATION);
    return this.active;
  }

  drifting(dt: number): void {
    this.fill(DRIFT_FILL_PER_SEC * dt);
  }

  nearMiss(count = 1): void {
    this.fill(NEAR_MISS_FILL * count);
  }

  reset(): void {
    this.level = 1;
    this.active = false;
  }

  private fill(amount: number): void {
    this.level = Math.min(1, this.level + amount);
  }
}
