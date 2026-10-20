/** A bus this far under the road beside it has gone over the edge (m). */
export const FALL_DEPTH = 6;
/** Or off the asphalt, below it and with no wheel down for this long (s): it's on its way down. */
export const FALL_AIR = 1.2;
/** Seconds between going over and being put back on the road (the plunge, in view). */
export const FALL_SHOW = 1.6;
/** Put back this far behind where it went over (m), in the middle of the road. */
export const FALL_BACK = 25;

/** What the watch is told each step: the bus against the road nearest it. */
export interface FallInput {
  /** The road's height there, and the bus's middle's (m). */
  roadY: number;
  busY: number;
  /** How far off the centerline it is (m), and the road's half width. */
  off: number;
  halfWidth: number;
  wheelsOnGround: number;
}

/**
 * Notices a bus going over the edge of a mountain road (off the asphalt and falling, or already
 * well under it), then counts down while the plunge is in view; `update` returns 'fell' once
 * when it goes over and 'respawn' once it's time to put it back on the road. Pure.
 */
export class FallWatch {
  /** Falling (between 'fell' and 'respawn'). */
  falling = false;
  private air = 0;
  private show = 0;

  update(dt: number, f: FallInput): 'fell' | 'respawn' | null {
    if (this.falling) {
      this.show -= dt;
      if (this.show > 0) return null;
      this.falling = false;
      this.air = 0;
      return 'respawn';
    }
    const below = f.roadY - f.busY;
    const off = Math.abs(f.off) > f.halfWidth + 0.5;
    this.air = off && below > 0.5 && f.wheelsOnGround === 0 ? this.air + dt : 0;
    if ((off && below > FALL_DEPTH) || this.air > FALL_AIR) {
      this.falling = true;
      this.show = FALL_SHOW;
      return 'fell';
    }
    return null;
  }

  reset(): void {
    this.falling = false;
    this.air = 0;
    this.show = 0;
  }
}
