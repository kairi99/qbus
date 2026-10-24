/** Each pickup fills this much of the tank. */
export const PICKUP_FILL = 0.5;
/** Seconds until a taken pickup is back on the road. */
export const PICKUP_RESPAWN = 15;
/** A racer takes a pickup this far beyond its own sides (m): the canister's radius and some. */
const REACH = 0.6;

/**
 * The nitro pickups on a race track (`TrackData.pickups`), pure: a racer that runs over one
 * takes it (half a tank), and it's gone for PICKUP_RESPAWN seconds. Racers are told by where
 * they are along the track (`s` of the front axle, last step's and this one's, so nothing is
 * skipped at a low frame rate), how far off the middle and how big they are.
 */
export class Pickups {
  /** Seconds until each is back (0: on the road). */
  readonly gone: Float32Array;

  /** `lap`: on a street circuit, its lap length (m): every spot is on each lap, so positions compare modulo it. */
  constructor(readonly spots: readonly { s: number; off: number }[], private readonly lap = 0) {
    this.gone = new Float32Array(spots.length);
  }

  step(dt: number): void {
    for (let i = 0; i < this.gone.length; i++) if (this.gone[i] > 0) this.gone[i] = Math.max(0, this.gone[i] - dt);
  }

  /**
   * A racer whose front went from `s0` to `s1` (m along), `off` right of the middle, `length` long
   * and `width` wide: the pickups it ran over, taken (their indices; usually none).
   */
  take(s0: number, s1: number, off: number, length: number, width: number, out: number[] = []): number[] {
    out.length = 0;
    const lo = Math.min(s0, s1) - length;
    const hi = Math.max(s0, s1);
    // Only a short step's worth: a racer put back on the road (a fall, a reset) hasn't driven there.
    if (hi - lo > length + 30) return out;
    const mid = (lo + hi) / 2;
    for (let i = 0; i < this.spots.length; i++) {
      const p = this.spots[i];
      // The copy of this spot on the racer's lap.
      const at = this.lap > 0 ? p.s + Math.round((mid - p.s) / this.lap) * this.lap : p.s;
      if (this.gone[i] > 0 || at < lo || at > hi || Math.abs(p.off - off) > width / 2 + REACH) continue;
      this.gone[i] = PICKUP_RESPAWN;
      out.push(i);
    }
    return out;
  }

  reset(): void {
    this.gone.fill(0);
  }
}
