/**
 * Mud caked on the tires (race, landslides), pure: driving through mud fills it, driving on
 * clean road wears it off over CLEAN_TIME. Fully caked tires lose TIRE_SHARE of what deep mud
 * takes from the grip, so the loss never passes the mud's own (`mudGrip` with `effective`).
 */

/** Seconds in deep mud to cake the tires fully (a thin patch takes proportionally longer). */
export const FILL_TIME = 2.5;
/** Seconds for fully caked tires to come clean on the road. */
export const CLEAN_TIME = 30;
/** Fully caked tires lose this share of the grip loss deep mud causes. */
export const TIRE_SHARE = 0.5;
/** Below this the warning is gone. */
export const SHOW_LEVEL = 0.03;

export class TireMud {
  /** 0 clean .. 1 fully caked. */
  level = 0;

  /** `mud` (0..1): how deep the road under the tires is this step. Returns the level. */
  step(mud: number, dt: number): number {
    if (mud > 0) this.level = Math.min(1, this.level + (Math.min(1, mud) * dt) / FILL_TIME);
    else this.level = Math.max(0, this.level - dt / CLEAN_TIME);
    return this.level;
  }

  /** The mud depth (0..1) the tires' grip loss equals; combine with the road's own via `Math.max`. */
  get effective(): number {
    return this.level * TIRE_SHARE;
  }

  /** Worth a warning on the screen. */
  get visible(): boolean {
    return this.level > SHOW_LEVEL;
  }

  reset(): void {
    this.level = 0;
  }
}
