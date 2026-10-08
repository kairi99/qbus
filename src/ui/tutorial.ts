import type { Action } from '../core/input';
import { FARE_CENTS, START_TIME, STOP_SPEED } from '../gameplay/routeGame';
import { MIN_TO_START, NITRO_DURATION } from '../gameplay/nitro';
import { COMBO_WINDOW, MAX_MULTIPLIER, TOP_SPEED } from '../gameplay/scoring';
import type { StarThresholds } from '../gameplay/stars';
import { money, targetsText } from './gameHud';

const kmh = (ms: number) => Math.round(ms * 3.6);

/** [key, what it does]: every binding in `core/input.ts`. */
const KEYS: [string, string][] = [
  ['W / ↑', 'Acelerar'],
  ['S / ↓', 'Frenar y retro'],
  ['A D / ← →', 'Girar'],
  ['Espacio', 'Freno de mano'],
  ['Shift', 'Nitro'],
  ['H', 'Pito'],
  ['C', 'Cámara (conductor)'],
  ['Q', 'Mirar atrás'],
  ['R', 'Volver a la calle'],
  ['M', 'Radio'],
  ['Esc / P', 'Pausa'],
];

/** The on-screen controls (`ui/touchControls.ts`). */
const TOUCH: [string, string][] = [
  ['Pulgar izq.', 'Desliza para girar'],
  ['Dale / Freno', 'Acelerar / frenar y retro'],
  ['Mano', 'Freno de mano'],
  ['Nitro', 'Nitro (el botón es el tanque)'],
  ['📯 / 👀', 'Pito / mirar atrás'],
  ['🎥 / 📻', 'Cámara / radio'],
  ['↺', 'Volver a la calle'],
  ['❚❚', 'Pausa'],
];

/** Standard gamepad mapping, as read by `core/input.ts`. */
const PAD = 'RT/LT acelerar/frenar · stick izq. girar · A mano · RB nitro · LB mirar atrás · Y cámara · X radio · L3 pito · Back calle · Start pausa';

const nitroText = () => `
  <li><b>Nitro:</b> el tanque arranca lleno y se quema en ${NITRO_DURATION} s. Para soltarlo necesitas al menos ${MIN_TO_START === 0.5 ? 'medio tanque' : `el ${Math.round(MIN_TO_START * 100)} % del tanque`} (la rayita del medidor).</li>
  <li>Solo se recarga <b>derrapando</b>, pasando <b>con las justas</b> junto a los carros (o haciendo saltar a la gente) y <b>pasándote los rojos</b> de los semáforos. Esperar no lo llena.</li>`;

const keyList = (rows: [string, string][], cls: string) =>
  `<dl class="tut-keys ${cls}">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

const controls = () => `
  <h2>Los controles</h2>
  ${keyList(KEYS, 'keys-only')}
  ${keyList(TOUCH, 'touch-only')}
  <p class="tut-pad" data-pad hidden><b>Control:</b> ${PAD}</p>`;

/** The pages of the card: a route shift explains the job, free roam just the ride. */
function pages(free: boolean, targets: StarThresholds | null): string[] {
  if (free)
    return [
      `<h2>Paseo libre</h2>
      <ul>
        <li>Aquí no hay paradas, reloj ni pasajes: date la vuelta por la ciudad a tu gusto.</li>
        <li>Hay tráfico y gente por las veredas: pita y se apuran (o se lanzan a un lado).</li>
        ${nitroText()}
      </ul>`,
      controls(),
    ];
  return [
    `<h2>Tu turno, ñaño</h2>
    <ul>
      <li>Recoge y deja pasajeros en cada <b>parada</b> de la ruta, en orden: métete en la zona marcada y baja de <b>${kmh(STOP_SPEED)} km/h</b>.</li>
      <li>Sigue la <b>flecha</b> y el <b>minimapa</b>: te llevan por calles legales.</li>
      <li>El <b>reloj</b> arranca en ${START_TIME} s cuando aceleras; cada parada suma tiempo, más si llegas volando. En 0 se acaba el turno.</li>
      <li>Cada pasajero paga ${money(FARE_CENTS)} al bajarse, más <b>propina</b> si lo llevas rápido.</li>
      <li>Tres <b>misiones</b> opcionales (en la esquina) pagan un bono.</li>
    </ul>
    ${targets ? `<p class="tut-stars">Metas: ${targetsText(targets)}</p>` : ''}`,
    `<h2>Nitro y acrobacias</h2>
    <ul>
      ${nitroText()}
      <li><b>Acrobacias que pagan:</b> derrapes, saltos, pasar con las justas, pasarte un rojo, golpear objetos e ir a más de ${kmh(TOP_SPEED)} km/h.</li>
      <li>Encadénalas (menos de ${COMBO_WINDOW} s entre una y otra) para un <b>combo</b> de hasta ×${MAX_MULTIPLIER}. Un choque lo corta.</li>
    </ul>`,
    controls(),
  ];
}

/**
 * How-to-play card shown before driving starts (route shift or free roam), a few short pages.
 * While it's open it takes the keyboard (Enter/Space/→ next, ← back, Esc skips), the main loop
 * holds the bus still and sends it the pad's actions (A next, Start skips), so the shift's
 * clock, which starts on the first throttle, can't run.
 */
export class Tutorial {
  open = false;
  page = 0;
  /** Closed; `dontShow`: the player ticked "No mostrar otra vez". */
  onClose: ((dontShow: boolean) => void) | null = null;
  private el: HTMLElement;
  private pages: HTMLElement[];
  private nextBtn: HTMLButtonElement;
  private backBtn: HTMLButtonElement;
  private dots: HTMLElement;
  private dontShow: HTMLInputElement;

  constructor(
    private root: HTMLElement,
    free: boolean,
    targets: StarThresholds | null,
  ) {
    const el = (this.el = document.createElement('div'));
    el.className = 'gh-results tut';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', free ? 'Cómo jugar el paseo libre' : 'Cómo jugar el turno');
    el.innerHTML = `
      <div class="gh-results-card tut-card">
        ${pages(free, targets).map((p) => `<section class="tut-page" hidden>${p}</section>`).join('')}
        <div class="tut-foot">
          <label class="tut-skip"><input type="checkbox" data-dont /> No mostrar otra vez</label>
          <span class="tut-dots" data-dots aria-hidden="true"></span>
        </div>
        <div class="gh-actions">
          <button class="gh-btn" data-back>‹ Atrás</button>
          <button class="gh-btn gh-btn-go" data-next></button>
        </div>
      </div>`;
    root.appendChild(el);
    this.pages = [...el.querySelectorAll<HTMLElement>('.tut-page')];
    this.nextBtn = el.querySelector('[data-next]')!;
    this.backBtn = el.querySelector('[data-back]')!;
    this.dots = el.querySelector('[data-dots]')!;
    this.dontShow = el.querySelector('[data-dont]')!;
    this.nextBtn.addEventListener('click', () => this.next());
    this.backBtn.addEventListener('click', () => this.back());

    // Ahead of `Input` (capture on window): while open, no key reaches the game.
    addEventListener('keydown', (e) => this.key(e), true);
    // A focused button clicks on Space's release: the keydown already moved the page.
    addEventListener('keyup', (e) => this.open && e.code === 'Space' && e.target !== this.dontShow && e.preventDefault(), true);
    const pad = () => this.el.querySelector<HTMLElement>('[data-pad]')!.toggleAttribute('hidden', !navigator.getGamepads?.().some((p) => p));
    addEventListener('gamepadconnected', pad);
    addEventListener('gamepaddisconnected', pad);
    pad();
  }

  show(): void {
    this.open = true;
    this.el.hidden = false;
    this.root.classList.add('tut-open');
    this.go(0);
  }

  next(): void {
    if (this.page < this.pages.length - 1) this.go(this.page + 1);
    else this.close();
  }

  back(): void {
    if (this.page > 0) this.go(this.page - 1);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
    this.root.classList.remove('tut-open');
    // Nothing left focused, so Space (the handbrake) doesn't press a button behind the game.
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onClose?.(this.dontShow.checked);
  }

  /** A pad (or other device) action while open: A moves on, Start skips the rest. */
  action(a: Action): void {
    if (a === 'confirm') this.next();
    if (a === 'pause') this.close();
  }

  private go(i: number): void {
    this.page = i;
    this.pages.forEach((p, k) => (p.hidden = k !== i));
    const last = i === this.pages.length - 1;
    this.nextBtn.innerHTML = last ? '¡Dale! <small>Enter</small>' : 'Siguiente › <small>Enter</small>';
    this.backBtn.hidden = i === 0;
    this.dots.textContent = this.pages.map((_, k) => (k === i ? '●' : '○')).join(' ');
    this.nextBtn.focus();
  }

  private key(e: KeyboardEvent): void {
    if (!this.open) return;
    e.stopPropagation();
    if (e.repeat) return e.preventDefault();
    const code = e.code;
    // Space on the checkbox ticks it; Tab moves between the buttons.
    if (code === 'Space' && e.target === this.dontShow) return;
    const btn = e.target instanceof HTMLButtonElement && this.el.contains(e.target) ? e.target : null;
    if (btn && (code === 'Enter' || code === 'NumpadEnter' || code === 'Space')) btn.click();
    else if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space' || code === 'ArrowRight') this.next();
    else if (code === 'ArrowLeft') this.back();
    else if (code === 'Escape') this.close();
    else return;
    e.preventDefault();
  }
}
