/**
 * The race start's launch: during the countdown the engine revs freely (throttle raises the
 * needle, lifting lets it fall), and at GO where the needle is decides the start. The green
 * window is small: holding the throttle flat out runs past it into wheelspin, so the needle has
 * to be fed and held. Pure; `rpm` runs 0 (idle) to 1 (redline).
 */

/** Idle, and how fast the needle climbs at full throttle / falls when lifting (per second). */
export const IDLE = 0.12;
const RISE = 0.85;
const FALL = 1.1;
/** The green window, and around it the "good" band. */
export const WINDOW: [number, number] = [0.6, 0.72];
export const GOOD: [number, number] = [0.46, 0.84];

export type LaunchGrade = 'perfect' | 'good' | 'bog' | 'spin';

/** What a grade does after GO, and for how long (s). */
export const LAUNCH_EFFECT: Record<LaunchGrade, { boost: number; throttle: number; grip: number; time: number; nitro: number; label: string }> = {
  perfect: { boost: 1, throttle: 1, grip: 1, time: 1.2, nitro: 0.25, label: '¡SALIDA PERFECTA!' },
  good: { boost: 0, throttle: 1, grip: 1, time: 0, nitro: 0, label: '¡Buena salida!' },
  bog: { boost: 0, throttle: 0.35, grip: 1, time: 1.3, nitro: 0, label: '¡SE AHOGA!' },
  spin: { boost: 0, throttle: 1, grip: 0.45, time: 1.2, nitro: 0, label: '¡PATINA!' },
};

export class LaunchRev {
  rpm = IDLE;
  private t = 0;

  update(dt: number, throttle: number): number {
    this.t += dt;
    const th = Math.max(0, Math.min(1, throttle));
    // Climbs slower near the top (the engine's breathing out of it), falls back toward idle.
    if (th > 0) this.rpm += th * RISE * (1 - this.rpm * 0.45) * dt;
    else this.rpm -= FALL * (this.rpm - IDLE) * dt * 2.2;
    this.rpm = Math.max(IDLE, Math.min(1, this.rpm));
    return this.rpm;
  }

  /** The needle as drawn: a little shake near the top. */
  get shown(): number {
    return this.rpm + (this.rpm > 0.8 ? Math.sin(this.t * 47) * 0.012 : 0);
  }

  get inWindow(): boolean {
    return this.rpm >= WINDOW[0] && this.rpm <= WINDOW[1];
  }

  grade(): LaunchGrade {
    return gradeOf(this.rpm);
  }

  reset(): void {
    this.rpm = IDLE;
    this.t = 0;
  }
}

export function gradeOf(rpm: number): LaunchGrade {
  if (rpm >= WINDOW[0] && rpm <= WINDOW[1]) return 'perfect';
  if (rpm >= GOOD[0] && rpm <= GOOD[1]) return 'good';
  return rpm < GOOD[0] ? 'bog' : 'spin';
}

/** What an AI driver gets at GO: better drivers launch better (from a uniform roll). */
export function aiGrade(roll: number, skill: 'easy' | 'normal' | 'hard'): LaunchGrade {
  const perfect = { easy: 0.1, normal: 0.25, hard: 0.45 }[skill];
  const bad = { easy: 0.35, normal: 0.2, hard: 0.1 }[skill];
  if (roll < perfect) return 'perfect';
  if (roll > 1 - bad) return roll > 1 - bad / 2 ? 'bog' : 'spin';
  return 'good';
}
