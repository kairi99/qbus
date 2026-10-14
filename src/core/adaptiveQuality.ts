/**
 * Adaptive render quality for weak GPUs (pure, no three.js). Good machines never leave their
 * full resolution: it only steps down when the frame rate stays low, and back up when it has
 * stayed high for a long while (unless that step was just tried and failed).
 *
 * Level 0 is full resolution; each step renders fewer pixels per side (`SCALES`). When the lowest resolution still cannot keep up, `shadowsLow` turns on once (a
 * smaller shadow map; it never comes back).
 */
export const SCALES = [1, 0.85, 0.72, 0.6];
export const LEVELS = SCALES.length;

/** Frame rate under which a step down is considered, and over which a step up is. */
export const LOW_FPS = 38;
export const HIGH_FPS = 57;
/** Last resort: below this at the lowest resolution the shadow map shrinks. */
export const VERY_LOW_FPS = 28;
export const DOWN_AFTER = 2; // s of low fps
export const UP_AFTER = 10; // s of high fps
export const SETTLE = 3; // s to let the frame rate recover after any change
export const SHADOWS_AFTER = 4; // s of very low fps at the lowest resolution
/** Stepping up and falling again within this time marks that level as too heavy. */
export const RETRY_BAN = 20;
/** A step down must raise the smoothed fps by this factor, or it is undone and stepping down stops for good
 * (the machine is capped or CPU-bound: fewer pixels would only cost quality). */
export const MIN_GAIN = 1.1;

/** Resolution scale of a level (1 at level 0). */
export const scaleAt = (level: number): number => SCALES[Math.min(level, LEVELS - 1)];

export class AdaptiveQuality {
  level = 0;
  shadowsLow = false;
  private lowFor = 0;
  private highFor = 0;
  private veryLowFor = 0;
  private settle = SETTLE + 2;
  private sinceUp = Infinity;
  /** Levels below this index are too heavy for this machine (a step up to one of them failed). */
  private minLevel = 0;
  /** Fps when the last step down happened; set while that step is still to be judged. */
  private fpsBefore = 0;
  private judging = false;
  /** A step down did not help: never step down (or shrink shadows) again. */
  disabled = false;

  /** Feeds one frame (smoothed fps, frame time in seconds). Returns true when the level or shadows changed. */
  update(fps: number, dt: number): boolean {
    this.sinceUp += dt;
    if (this.settle > 0) {
      this.settle -= dt;
      return false;
    }
    if (this.judging) {
      this.judging = false;
      if (fps < this.fpsBefore * MIN_GAIN) {
        this.level--;
        this.disabled = true;
        return this.changed();
      }
    }
    if (this.disabled) return false;
    this.lowFor = fps < LOW_FPS ? this.lowFor + dt : 0;
    this.highFor = fps > HIGH_FPS ? this.highFor + dt : 0;
    this.veryLowFor = this.level === LEVELS - 1 && fps < VERY_LOW_FPS ? this.veryLowFor + dt : 0;

    if (this.lowFor > DOWN_AFTER && this.level < LEVELS - 1) {
      // Dropping again right after a step up: that level is too much for this machine.
      if (this.sinceUp < RETRY_BAN) this.minLevel = this.level + 1;
      this.level++;
      this.fpsBefore = fps;
      this.judging = true;
      return this.changed();
    }
    if (this.veryLowFor > SHADOWS_AFTER && !this.shadowsLow) {
      this.shadowsLow = true;
      return this.changed();
    }
    if (this.highFor > UP_AFTER && this.level > 0 && this.level - 1 >= this.minLevel) {
      this.level--;
      this.sinceUp = 0;
      return this.changed();
    }
    return false;
  }

  private changed(): true {
    this.lowFor = this.highFor = this.veryLowFor = 0;
    this.settle = SETTLE;
    return true;
  }
}
