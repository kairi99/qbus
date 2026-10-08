/**
 * The pure side of the menu's UI sounds (no Web Audio, testable in Node): which sound an
 * element makes, how loud each one is, the pitch jitter, and the rate limit that keeps hover
 * ticks from rattling when the pointer sweeps across a row of cards.
 */

export type MenuSound =
  /** Pointer or keyboard focus landing on another option: a soft tick. */
  | 'hover'
  /** A menu button (Jugar, Ajustes, Créditos): a short "timbre" buzzer blip. */
  | 'confirm'
  /** Picking a mode, vehicle or zone card: a "ding-dong" stop-request bell. */
  | 'select'
  /** Picking a route: a ticket punch with a coin "clink". */
  | 'route'
  /** ¡Arranca!: a "pi-pí" horn toot and the air brake letting go. */
  | 'start'
  /** ‹ Volver: a low falling blip. */
  | 'back'
  /** A settings radio switch: a click. */
  | 'toggle'
  /** Dragging a volume slider: a tick at the new level. */
  | 'slider';

/**
 * Peak gains, under the same master as the game (0.35 x the volume setting). The game's coin
 * cue peaks at 0.12 (a square wave); UI sounds sit under it, the hover tick ~12 dB lower, so a
 * lot of browsing never gets louder than a fare.
 */
export const MENU_LEVELS: Record<MenuSound, number> = {
  hover: 0.035,
  confirm: 0.07,
  select: 0.08,
  route: 0.09,
  start: 0.12,
  back: 0.07,
  toggle: 0.06,
  slider: 0.06,
};

/** Pitch jitter (± fraction of the playback rate) so repeated sounds don't feel canned. */
export const JITTER: Record<MenuSound, number> = {
  hover: 0.06,
  confirm: 0.03,
  select: 0.02,
  route: 0.04,
  start: 0.01,
  back: 0.03,
  toggle: 0.05,
  slider: 0,
};

/** Playback-rate multiplier for a sound, from a random number in [0, 1). */
export const jitter = (s: MenuSound, rand: number) => 1 + (rand * 2 - 1) * JITTER[s];

/** What the sounds module needs from a DOM element (fakes in tests). */
export interface ElementLike {
  tagName: string;
  getAttribute(name: string): string | null;
}

/** The sound a click on this element makes (null: none). Radios and sliders sound on change/input instead. */
export function clickSound(el: ElementLike): MenuSound | null {
  const go = el.getAttribute('data-go');
  if (go === 'back') return 'back';
  if (go === 'play') return 'start';
  if (go) return 'confirm';
  if (el.getAttribute('data-route') !== null) return 'route';
  if (el.getAttribute('data-mode') !== null || el.getAttribute('data-bus') !== null || el.getAttribute('data-zone') !== null) return 'select';
  return null;
}

/** The sound an input's change makes: a click for a radio switch, a level tick for a slider. */
export function inputSound(el: ElementLike): MenuSound | null {
  const type = el.getAttribute('type');
  if (el.tagName !== 'INPUT') return null;
  return type === 'radio' ? 'toggle' : type === 'range' ? 'slider' : null;
}

/** Elements that tick when hovered or focused. */
export const HOVERABLE = 'button:not([disabled]), .mn-choice, input[type="range"]';

/**
 * Rate limit for hover/focus ticks: one per new element, at most one every `gap` seconds,
 * and none for a moment after a louder sound (clicking a card also focuses it, and a new
 * screen focuses its first button).
 */
export class TickLimiter {
  private last = -Infinity;
  private quietUntil = -Infinity;
  private current: unknown = null;

  constructor(
    private readonly gap = 0.06,
    private readonly hush = 0.25,
  ) {}

  /** True if a tick for `target` at time `t` (seconds) should play. */
  tick(target: unknown, t: number): boolean {
    if (target === this.current) return false;
    this.current = target;
    if (t < this.quietUntil || t - this.last < this.gap) return false;
    this.last = t;
    return true;
  }

  /** A louder sound just played at `t`: hold the ticks off for a moment. */
  loud(t: number): void {
    this.quietUntil = t + this.hush;
  }

  /** The pointer left every option: entering the same one again ticks. */
  leave(): void {
    this.current = null;
  }
}

/** Minimum seconds between slider preview ticks while dragging. */
export const SLIDER_GAP = 0.07;
/** How long ¡Arranca! waits before leaving the page, so the horn is heard (ms). */
export const START_DELAY_MS = 380;
