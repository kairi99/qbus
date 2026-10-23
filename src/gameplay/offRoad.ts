/** Beyond the asphalt's edge by more than this (m) is off the road: the shoulder still counts. */
export const OFFROAD_MARGIN = 2;
/** Seconds off the road before the countdown shows (a wide bend, a quick cut). */
export const OFFROAD_GRACE = 2;
/** The countdown (s): back on the road before it ends, or the bus is put back where it left. */
export const OFFROAD_COUNT = 6;

export interface OffRoadInput {
  /** Distance past the asphalt's edge (m; negative on the road). */
  edge: number;
  /** Front axle's place along the track (m) and the side of the middle it is on (+/- off). */
  s: number;
  off: number;
  /** Wheels touching ground: in the air nothing counts (a jump over a ditch, a fall). */
  wheels: number;
  /** The race is on and the bus is free to drive (not on the grid, waiting out a reset, falling). */
  active: boolean;
}

/**
 * Driving on the mountain beside the road, pure: after OFFROAD_GRACE s off the asphalt (past the
 * shoulder) a countdown of OFFROAD_COUNT s starts; back on the road cancels it; when it runs out
 * `update` returns 'expired' once, and `departS`/`side` say where the bus left the road.
 */
export class OffRoad {
  /** Seconds left (0: no countdown). */
  countdown = 0;
  /** Where the bus last was on the road (track m) and on which side (-1 left, 1 right). */
  departS = -1;
  side = 1;
  private grace = 0;

  update(dt: number, f: OffRoadInput): 'expired' | null {
    if (!f.active) {
      this.cancel();
      return null;
    }
    if (f.edge <= OFFROAD_MARGIN) {
      this.cancel();
      this.departS = f.s;
      this.side = f.off < 0 ? -1 : 1;
      return null;
    }
    if (f.wheels === 0) return null;
    if (this.countdown <= 0) {
      this.grace += dt;
      if (this.grace >= OFFROAD_GRACE) this.countdown = OFFROAD_COUNT;
      return null;
    }
    this.countdown = Math.max(0, this.countdown - dt);
    if (this.countdown > 0) return null;
    this.grace = 0;
    return 'expired';
  }

  private cancel(): void {
    this.countdown = 0;
    this.grace = 0;
  }

  reset(): void {
    this.cancel();
    this.departS = -1;
  }
}
