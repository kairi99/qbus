/**
 * Pure: the "ghost" a racer becomes when it is put back on the road (R, a fall, an AI rescue): for
 * a few seconds it touches only the static world and is drawn see-through, so it can't reappear
 * inside another vehicle. Past its time it stays a ghost while it still overlaps something, and
 * past `GHOST_MAX` of that the caller moves it to a free spot.
 */

/** Seconds of ghost once the vehicle may move again. */
export const GHOST_TIME = 3;
/** Most seconds the ghost is prolonged past its time while it overlaps another vehicle. */
export const GHOST_MAX = 8;
/** Opacity of the model while a ghost (blinking up a little in the last second). */
export const GHOST_OPACITY = 0.35;

export type GhostState = 'ghost' | 'solid' | 'relocate';

export class Ghost {
  private left = 0;
  private extra = 0;
  private on = false;

  get active(): boolean {
    return this.on;
  }

  /** Becomes a ghost for `seconds` (the whole time, a hold before it may move included). */
  start(seconds: number): void {
    this.left = seconds;
    this.extra = 0;
    this.on = true;
  }

  /**
   * Advances `dt`. `blocked` (a flag, or a function called only once the time is up) tells whether
   * the vehicle overlaps another one: then the ghost goes on, until `GHOST_MAX` has passed and
   * 'relocate' comes once (the ghost ends: call `start` again after moving the vehicle).
   */
  update(dt: number, blocked: boolean | (() => boolean)): GhostState {
    if (!this.on) return 'solid';
    this.left = Math.max(0, this.left - dt);
    if (this.left > 0) return 'ghost';
    if (!(typeof blocked === 'function' ? blocked() : blocked)) {
      this.on = false;
      return 'solid';
    }
    this.extra += dt;
    if (this.extra < GHOST_MAX) return 'ghost';
    this.on = false;
    return 'relocate';
  }

  /** Opacity for the model: 1 when not a ghost, else about 0.35, blinking up in the last second. */
  get fade(): number {
    if (!this.on) return 1;
    if (this.left > 0 && this.left < 1) return GHOST_OPACITY + 0.4 * (0.5 + 0.5 * Math.sin(this.left * 24));
    return GHOST_OPACITY;
  }

  reset(): void {
    this.on = false;
    this.left = 0;
    this.extra = 0;
  }
}
