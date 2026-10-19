import { Rng } from '../core/rng';

/** The rain setting: showers at random moments, never, or raining from the start. */
export type RainSetting = 'random' | 'off' | 'always';
export const RAIN_SETTINGS: readonly RainSetting[] = ['random', 'off', 'always'];

export function parseRainSetting(s: unknown): RainSetting | null {
  return RAIN_SETTINGS.includes(s as RainSetting) ? (s as RainSetting) : null;
}

/** What the weather is doing right now. */
export interface WeatherState {
  /** How hard it rains, 0 (dry) to 1 (a downpour). */
  rain: number;
  /** How wet the road is, 0..1: follows the rain up quickly, dries slowly after it. */
  wet: number;
  /** Water standing at the bottom of the underpasses (m). Only a downpour floods them. */
  flood: number;
}

/** First shower starts this long into the game (s, uniform): a random moment of any shift. */
export const FIRST_DRY: [number, number] = [25, 200];
/** Dry spell between showers (s). */
export const DRY: [number, number] = [120, 300];
/** A shower lasts this long (s), plus its ramps. */
export const SHOWER: [number, number] = [100, 240];
/** The rain takes this long to build up, and to die away (s). */
export const RAMP = 15;
/** A shower's peak is drawn between these; past `DOWNPOUR` it's a downpour (it floods). */
export const PEAK: [number, number] = [0.35, 1];
export const DOWNPOUR = 0.7;
/** The road gets wet this fast (time constant, s) and dries this slowly. */
const WET_TAU = 6;
const DRY_TAU = 90;
/** Floodwater: rises at up to this rate (m/s, in the heaviest rain), drains at this one, never deeper than FLOOD_MAX. */
export const FLOOD_RISE = 0.012;
export const FLOOD_DRAIN = 0.005;
export const FLOOD_MAX = 0.75;
/** Tire grip on a soaked road (a fraction of dry). */
export const WET_GRIP = 0.7;

/** Tire grip for a road this wet (1 dry, WET_GRIP soaked). */
export function gripFor(wet: number): number {
  return 1 - (1 - WET_GRIP) * Math.max(0, Math.min(1, wet));
}

/**
 * The weather of one game: dry spells and showers of random length and strength, the first
 * starting at a random moment (`random`), or a shower that never ends (`always`; `peak` fixes
 * its strength, e.g. `?rain=` in tests), or none (`off`). Pure: a function of the seed and the
 * time stepped through `update`.
 */
export class Weather {
  readonly state: WeatherState = { rain: 0, wet: 0, flood: 0 };
  private rng: Rng;
  /** Time into the current phase, and how long it lasts. */
  private t = 0;
  private len: number;
  private raining: boolean;
  private peak: number;

  constructor(
    readonly setting: RainSetting,
    seed: number,
    peak?: number,
  ) {
    this.rng = new Rng(seed);
    this.raining = setting === 'always';
    this.peak = peak ?? (setting === 'always' ? this.rng.range(0.5, 1) : this.rng.range(...PEAK));
    this.len = setting === 'always' ? Infinity : this.rng.range(...FIRST_DRY);
    // Raining from the start: the road is already wet and the shower already at its peak.
    if (this.raining) {
      this.t = RAMP;
      this.state.rain = this.peak;
      this.state.wet = this.peak;
    }
  }

  update(dt: number): WeatherState {
    const s = this.state;
    if (this.setting !== 'off') {
      this.t += dt;
      if (this.t >= this.len) {
        this.t = 0;
        this.raining = !this.raining;
        if (this.raining) {
          this.peak = this.rng.range(...PEAK);
          this.len = this.rng.range(...SHOWER) + 2 * RAMP;
        } else this.len = this.rng.range(...DRY);
      }
      s.rain = this.raining ? this.peak * Math.min(1, this.t / RAMP, (this.len - this.t) / RAMP) : 0;
    }
    const tau = s.rain > s.wet ? WET_TAU : DRY_TAU;
    s.wet += (s.rain - s.wet) * Math.min(1, dt / tau);
    // Drains can't keep up with a downpour: water collects at the bottom of the underpasses.
    const over = (s.rain - DOWNPOUR) / (1 - DOWNPOUR);
    s.flood = over > 0 ? Math.min(FLOOD_MAX, s.flood + FLOOD_RISE * over * dt) : Math.max(0, s.flood - FLOOD_DRAIN * dt);
    return s;
  }
}
