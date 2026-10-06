/**
 * The pure side of the vehicle sounds (no Web Audio, testable in Node): a fake gearbox
 * that turns speed and throttle into engine RPM, how the recorded loops are pitched and
 * crossfaded at a given RPM, when the air brakes hiss, and how a recording becomes a
 * seamless loop.
 */

export interface EngineVoice {
  idleRpm: number;
  /** Upshift point. */
  redlineRpm: number;
  /** Where the needle lands right after an upshift. */
  shiftRpm: number;
  /** Top of each gear as a fraction of top speed (ascending, the last one past 1). */
  gears: number[];
  /** RPM the idle and the on-load recordings were made at (playbackRate = rpm / ref). */
  idleRef: number;
  loadRef: number;
  /** Lowpass cutoff (Hz) off throttle at idle, and how far a full load opens it. */
  cutoff: number;
  cutoffOpen: number;
}

/**
 * Front-engine truck-chassis bus (Hino AK, Chevrolet FTR): a low-revving six-cylinder diesel
 * with a long first gear. The idle recording fires at 30 Hz (600 rpm for a six), the load
 * one at 75.5 Hz (1510 rpm).
 */
export const DIESEL: EngineVoice = {
  idleRpm: 650,
  redlineRpm: 2300,
  shiftRpm: 1350,
  gears: [0.14, 0.3, 0.5, 0.74, 1.05],
  idleRef: 600,
  loadRef: 1510,
  cutoff: 900,
  cutoffOpen: 3600,
};

/** AE86: a revvy 1.6 l petrol four. Both layers come from one idle recording. */
export const PETROL: EngineVoice = {
  idleRpm: 900,
  redlineRpm: 7400,
  shiftRpm: 4600,
  gears: [0.24, 0.42, 0.62, 0.82, 1.05],
  idleRef: 900,
  loadRef: 2600,
  cutoff: 1400,
  cutoffOpen: 6000,
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * RPM for a speed (fraction of top speed, past 1 with nitro) and throttle 0..1: climbs through
 * each gear and drops back at every shift. At a crawl in first the clutch slips, so throttle
 * alone revs it up a little.
 */
export function engineRpm(speedFrac: number, throttle: number, v: EngineVoice): { rpm: number; gear: number } {
  const s = clamp(speedFrac, 0, 1.4);
  let gear = v.gears.findIndex((top) => s < top);
  if (gear < 0) gear = v.gears.length - 1;
  const lo = gear === 0 ? 0 : v.gears[gear - 1];
  const t = clamp((s - lo) / (v.gears[gear] - lo), 0, 1.15);
  const floor = gear === 0 ? v.idleRpm : v.shiftRpm;
  const rpm = floor + (v.redlineRpm - floor) * t;
  const slip = v.idleRpm + clamp(throttle, 0, 1) * (v.redlineRpm - v.idleRpm) * 0.25;
  return { rpm: Math.max(rpm, slip), gear };
}

export interface EngineMix {
  idleRate: number;
  idleGain: number;
  loadRate: number;
  loadGain: number;
  /** Lowpass cutoff in Hz: a diesel off throttle is a muffled rumble, on load it barks. */
  cutoff: number;
  /** Overall engine level, 0..~1.2. */
  volume: number;
}

/**
 * How the two recorded layers play at an RPM and load (0..1): each is pitched by RPM over
 * the RPM it was recorded at, the idle fades out and the on-load layer in (equal power) as
 * the revs rise or the throttle goes down, and load opens the filter and the volume.
 */
export function engineMix(rpm: number, load: number, v: EngineVoice): EngineMix {
  const x = clamp((rpm - v.idleRpm) / (v.redlineRpm - v.idleRpm), 0, 1.2);
  const l = clamp(load, 0, 1);
  const a = clamp(smoothstep(0.04, 0.5, x) + l * 0.3, 0, 1);
  return {
    idleRate: rpm / v.idleRef,
    idleGain: Math.cos((a * Math.PI) / 2),
    loadRate: rpm / v.loadRef,
    loadGain: Math.sin((a * Math.PI) / 2) * (0.55 + 0.45 * l),
    cutoff: v.cutoff + v.cutoffOpen * (0.25 * Math.min(x, 1) + 0.75 * l),
    volume: 0.65 + 0.35 * Math.min(x, 1) + 0.3 * l,
  };
}

/**
 * The mix: gain of each sound as it plays (before the master volume). Every recording is
 * normalized to about -18 LUFS (see public/sounds/CREDITS.md), so these ratios are the
 * loudness ratios the player hears. Measured as played (rate and lowpass included), the bus
 * engine sits near -25 LUFS at idle, -21.5 cruising and -16.5 flat out; the one-shots land
 * between -22 and -18.5, a little over the cruising engine, and the horn on top at -15.5.
 */
export const LEVELS = {
  /** Engine output = this x `EngineMix.volume`. The car is ~3 dB under the bus. */
  engine: { bus: 1, car: 0.53 },
  airRelease: 0.85,
  airHiss: 0.6,
  /** The air dryer's purge, a short sharp "psht" a few seconds after setting the brake. */
  airPurge: 0.45,
  doorOpen: 0.85,
  doorClose: 1,
  /** Stop-request buzzer ("timbre"). */
  timbre: 0.7,
  horn: { bus: 1.4, car: 1.2 },
  /** A traffic car honking at the bus, right next to it. */
  trafficHorn: 0.55,
} as const;

/** Linear gain to decibels. */
export const db = (gain: number) => 20 * Math.log10(gain);

/**
 * Turbo whistle of the bus's diesel: a thin whine that rises with the revs and only shows up
 * under load (boost), well under the engine itself.
 */
export function turboWhistle(rpm: number, load: number, v: EngineVoice): { freq: number; gain: number } {
  const x = clamp((rpm - v.idleRpm) / (v.redlineRpm - v.idleRpm), 0, 1.2);
  const boost = clamp(load, 0, 1) * smoothstep(0.1, 0.7, x);
  return { freq: 1800 + 2600 * Math.min(x, 1.1), gain: 0.016 * boost };
}

/** Engine load from the throttle input (negative = brake, or reverse once stopped) and the signed speed in m/s. */
export function engineLoad(throttle: number, speed: number, boosting = false): number {
  if (boosting) return 1;
  if (throttle > 0 && speed > -1) return throttle;
  if (throttle < 0 && speed < 1) return -throttle;
  return 0;
}

/** Same rule as the physics: throttle against the direction of travel brakes. */
export function isBraking(throttle: number, speed: number, handbrake = false): boolean {
  return (throttle < 0 && speed > 1) || (throttle > 0 && speed < -1) || (handbrake && Math.abs(speed) > 1);
}

/** Below this (m/s) the bus counts as stopped. */
const STOPPED = 1;
/** Pulling up counts as a braked stop if the brake was on this recently (s). */
const BRAKED_WITHIN = 1.5;
/** A fresh brake application above this speed (m/s) makes a short hiss. */
const HARD_BRAKE_SPEED = 9;

/** Stopped this long (s) after setting the brake, the compressor cuts out and the dryer purges. */
const PURGE_AFTER = 4;

/**
 * Air brakes: the long "pssshh" when the bus comes to a stop on the brakes (the driver
 * setting the brake at the stop), a short hiss when the brakes go on hard at speed, and the
 * air dryer's purge ("psht") once the compressor has topped the tanks up at a long stop.
 */
export class AirBrakes {
  private sinceBrake = Infinity;
  private moving = false;
  private releaseCooldown = 0;
  private hissCooldown = 0;
  /** Seconds stopped since the last release, or -1 once purged / when moving. */
  private stoppedFor = -1;

  /** `speed` is |speed| in m/s. */
  step(dt: number, speed: number, braking: boolean): 'release' | 'hiss' | 'purge' | null {
    this.releaseCooldown -= dt;
    this.hissCooldown -= dt;
    let out: 'release' | 'hiss' | 'purge' | null = null;
    if (this.stoppedFor >= 0) {
      if (speed >= STOPPED) this.stoppedFor = -1;
      else if ((this.stoppedFor += dt) >= PURGE_AFTER) {
        this.stoppedFor = -1;
        out = 'purge';
      }
    }
    if (braking) {
      if (this.sinceBrake > 0.6 && speed > HARD_BRAKE_SPEED && this.hissCooldown <= 0) {
        out = 'hiss';
        this.hissCooldown = 3;
      }
      this.sinceBrake = 0;
    } else this.sinceBrake += dt;
    if (speed > 3) this.moving = true;
    if (this.moving && speed < STOPPED) {
      this.moving = false;
      if (this.sinceBrake < BRAKED_WITHIN && this.releaseCooldown <= 0) {
        out = 'release';
        this.releaseCooldown = 2;
        this.stoppedFor = 0;
      }
    }
    return out;
  }
}

/**
 * Turns a recording into a seamless loop: the output is `xfade` samples shorter than the
 * input, starting `xfade` in, and its last `xfade` samples blend the input's tail into its
 * head (equal power), so the end flows into the start. Decoders may add a few ms of padding
 * at either end of an MP3; `guard` samples are dropped from the end and the head is faded in
 * under the blend, so that padding never makes a click.
 */
export function makeLoop(input: Float32Array, xfade: number, guard = 0): Float32Array {
  const usable = input.length - guard;
  const len = usable - xfade;
  if (len <= xfade) return input.slice();
  const out = new Float32Array(len);
  for (let i = 0; i < len - xfade; i++) out[i] = input[i + xfade];
  for (let j = 0; j < xfade; j++) {
    const w = (j + 0.5) / xfade;
    out[len - xfade + j] = input[len + j] * Math.cos((w * Math.PI) / 2) + input[j] * Math.sin((w * Math.PI) / 2);
  }
  return out;
}
