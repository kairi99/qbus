/** One physics step of what the bus is doing, as far as reckless scoring cares. */
export interface Telemetry {
  dt: number;
  /** Signed forward speed, m/s. */
  speed: number;
  /** Angle between heading and velocity, radians. */
  slipAngle: number;
  airborne: boolean;
  /** Close passes detected this step. */
  nearMisses: number;
  /** Props newly knocked over this step. */
  propsKnocked: number;
}

export type TrickKind = 'drift' | 'air' | 'nearMiss' | 'knock' | 'speed' | 'crash';

export interface TrickEvent {
  kind: TrickKind;
  /** Already multiplied by the combo. 0 for crashes. */
  cents: number;
  multiplier: number;
  /** Seconds of drift/air, when relevant. */
  duration?: number;
}

/** Seconds after a trick during which the next one extends the combo. */
export const COMBO_WINDOW = 3;
const MAX_MULTIPLIER = 5;

const DRIFT_MIN_SLIP = (15 * Math.PI) / 180;
const DRIFT_MIN_SPEED = 20 / 3.6;
const DRIFT_MIN_TIME = 0.5;
/** A drift survives this long below the slip threshold (wobbles while countersteering). */
const DRIFT_GRACE = 0.25;
const AIR_MIN_TIME = 0.35;
const TOP_SPEED = 80 / 3.6;
const TOP_SPEED_INTERVAL = 2;
/** Losing this much speed within CRASH_WINDOW seconds is a crash, not braking. */
const CRASH_DROP = 18 / 3.6;
const CRASH_WINDOW = 0.15;

const CENTS = {
  driftPerSec: 20,
  airPerSec: 40,
  nearMiss: 15,
  knock: 5,
  speed: 5,
};

/** Detects reckless tricks from per-step telemetry and scores them with a combo multiplier. */
export class TrickScorer {
  /** Tricks in the current chain. */
  chain = 0;
  bestCombo = 0;
  longestAir = 0;
  private sinceTrick = Infinity;
  private drift = 0;
  private driftGrace = 0;
  private air = 0;
  private fast = 0;
  private history: { t: number; speed: number }[] = [];
  private clock = 0;

  /** Multiplier the next trick will earn. */
  get multiplier(): number {
    return Math.min(MAX_MULTIPLIER, this.chain + 1);
  }

  update(t: Telemetry): TrickEvent[] {
    const out: TrickEvent[] = [];
    this.clock += t.dt;
    const speed = Math.abs(t.speed);

    // Crash: sudden loss of speed.
    this.history.push({ t: this.clock, speed });
    while (this.history.length && this.history[0].t < this.clock - CRASH_WINDOW) this.history.shift();
    const peak = Math.max(...this.history.map((h) => h.speed));
    if (peak - speed > CRASH_DROP) {
      out.push({ kind: 'crash', cents: 0, multiplier: 1 });
      this.chain = 0;
      this.drift = 0;
      this.fast = 0;
      this.history = [{ t: this.clock, speed }];
    }

    // Drift: awarded when the slide ends.
    const sliding = !t.airborne && speed > DRIFT_MIN_SPEED && Math.abs(t.slipAngle) > DRIFT_MIN_SLIP;
    if (sliding) {
      this.drift += t.dt;
      this.driftGrace = DRIFT_GRACE;
    } else if (this.drift > 0) {
      this.driftGrace -= t.dt;
      if (this.driftGrace <= 0) {
        if (this.drift >= DRIFT_MIN_TIME) out.push(this.award('drift', this.drift * CENTS.driftPerSec, this.drift));
        this.drift = 0;
      }
    }

    // Airtime: awarded on landing.
    if (t.airborne) this.air += t.dt;
    else if (this.air > 0) {
      if (this.air >= AIR_MIN_TIME) {
        out.push(this.award('air', this.air * CENTS.airPerSec, this.air));
        this.longestAir = Math.max(this.longestAir, this.air);
      }
      this.air = 0;
    }

    // Sustained top speed.
    if (speed > TOP_SPEED) {
      this.fast += t.dt;
      if (this.fast >= TOP_SPEED_INTERVAL) {
        this.fast -= TOP_SPEED_INTERVAL;
        out.push(this.award('speed', CENTS.speed));
      }
    } else this.fast = 0;

    for (let i = 0; i < t.nearMisses; i++) out.push(this.award('nearMiss', CENTS.nearMiss));
    for (let i = 0; i < t.propsKnocked; i++) out.push(this.award('knock', CENTS.knock));

    // A trick in progress keeps the combo alive.
    const busy = this.drift > 0 || this.air > 0 || this.fast > 0;
    this.sinceTrick = busy ? 0 : this.sinceTrick + t.dt;
    if (this.sinceTrick > COMBO_WINDOW) this.chain = 0;
    return out;
  }

  private award(kind: TrickKind, baseCents: number, duration?: number): TrickEvent {
    const multiplier = this.multiplier;
    this.chain++;
    this.bestCombo = Math.max(this.bestCombo, this.chain);
    this.sinceTrick = 0;
    return { kind, cents: Math.round(baseCents) * multiplier, multiplier, duration };
  }
}
