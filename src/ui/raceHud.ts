import { IDLE, WINDOW } from '../gameplay/launch';
import { type Racer, raceClock } from '../gameplay/raceGame';
import { setText } from './dom';

/** The tachometer's scale: 0 to 8 (×1000 rpm), the needle sweeping 240°. */
const TACH_MAX = 8;
const SWEEP = 240;
/** rpm 0..1 (launch) to the dial's 0..8: idle sits at ~0.8, redline at 7. */
const dial = (rpm: number) => 0.8 + ((rpm - IDLE) / (1 - IDLE)) * 6.2;
const angle = (v: number) => -SWEEP / 2 + (v / TACH_MAX) * SWEEP;

export interface RaceResultRow {
  name: string;
  bus: string;
  /** Null: still on the road (online, until the server has the time), or out of the race. */
  time: number | null;
  estimated: boolean;
  player: boolean;
}

export interface RaceResults {
  place: number;
  rows: RaceResultRow[];
  launch: string;
  best: number | null;
  newBest: boolean;
  /** Online: the server's results are final (a racer without a time is out of the race). */
  final?: boolean;
  /** Online with the room gone: only the player's own result. */
  solo?: boolean;
}

export type RaceHudAction = 'again' | 'menu' | 'lobby';

/**
 * The race's HUD (Spanish): the route and the player's place and time (top left), the big
 * countdown, the tachometer with its green launch window (big during the countdown, gone a
 * moment after GO), a progress strip with every racer on it, and the results card.
 */
export class RaceHud {
  onAction: ((a: RaceHudAction) => void) | null = null;
  private el: HTMLElement;
  private k: Record<string, HTMLElement> = {};
  private needle: SVGElement;
  private dots: HTMLElement[] = [];
  private tachHideIn = -1;

  constructor(root: HTMLElement, from: string, to: string, racers: number) {
    this.el = document.createElement('div');
    this.el.className = 'rh';
    const [w0, w1] = WINDOW.map((r) => angle(dial(r)));
    const arc = (a0: number, a1: number, r: number) => {
      const p = (a: number) => [100 + r * Math.sin((a * Math.PI) / 180), 100 - r * Math.cos((a * Math.PI) / 180)].map((v) => v.toFixed(1)).join(' ');
      return `M ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}`;
    };
    const ticks = Array.from({ length: TACH_MAX + 1 }, (_, v) => {
      const a = (angle(v) * Math.PI) / 180;
      const [x, y] = [100 + 70 * Math.sin(a), 100 - 70 * Math.cos(a)];
      return `<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}">${v}</text>`;
    }).join('');
    this.el.innerHTML = `
      <div class="rh-panel">
        <div class="rh-route">RUTA: ${from.toUpperCase()} → ${to.toUpperCase()}</div>
        <div class="rh-place">POSICIÓN: <b data-k="place">1 / ${racers}</b></div>
        <div class="rh-time" data-k="time">0:00.0</div>
      </div>
      <div class="rh-count" data-k="count"></div>
      <div class="rh-flash" data-k="flash" hidden></div>
      <div class="rh-photo" data-k="photo" hidden></div>
      <div class="rh-wait" data-k="wait" hidden>De vuelta en la vía… <b data-k="waitN">3</b></div>
      <div class="rh-net" data-k="net" hidden></div>
      <div class="rh-hint" data-k="hint">Acelera <span class="keys-only">con <b>W</b></span> y mantén la aguja en lo <b class="rh-green">verde</b>: ¡salida perfecta!</div>
      <div class="rh-strip"><div class="rh-flag">🏁</div></div>
      <div class="rh-tach" data-k="tach">
        <svg viewBox="0 0 200 170">
          <path class="rh-tach-dial" d="${arc(-SWEEP / 2, SWEEP / 2, 88)}"/>
          <path class="rh-tach-red" d="${arc(angle(7), SWEEP / 2, 88)}"/>
          <path class="rh-tach-green" d="${arc(w0, w1, 88)}"/>
          <g class="rh-tach-num">${ticks}</g>
          <text class="rh-tach-label" x="100" y="138">RPM ×1000</text>
          <g class="rh-needle" data-needle><line x1="100" y1="100" x2="100" y2="22"/></g>
          <circle cx="100" cy="100" r="7" class="rh-hub"/>
        </svg>
      </div>
      <div class="gh-results" data-k="results" hidden>
        <div class="gh-results-card rh-results">
          <h2 data-k="rTitle"></h2>
          <ol class="rh-table" data-k="rTable"></ol>
          <p data-k="rLaunch"></p>
          <p data-k="rBest"></p>
          <div class="gh-actions">
            <button class="gh-btn gh-btn-go" data-act="again">Otra carrera <small>Enter</small></button>
            <button class="gh-btn" data-act="menu">Menú</button>
          </div>
        </div>
      </div>`;
    root.appendChild(this.el);
    for (const e of this.el.querySelectorAll<HTMLElement>('[data-k]')) this.k[e.dataset.k!] = e;
    this.needle = this.el.querySelector('[data-needle]')!;
    const strip = this.el.querySelector<HTMLElement>('.rh-strip')!;
    for (let i = 0; i < racers; i++) {
      const d = document.createElement('div');
      d.className = i === 0 ? 'rh-dot rh-dot-me' : 'rh-dot';
      strip.appendChild(d);
      this.dots.push(d);
    }
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act as RaceHudAction | undefined;
      if (act) this.onAction?.(act);
    });
  }

  /** The countdown's big text: 3, 2, 1, then "¡CARRERA!" for a moment. */
  count(text: string, go = false): void {
    const c = this.k.count;
    c.textContent = text;
    // Restart the pop animation.
    c.classList.remove('rh-pop', 'rh-go');
    void c.offsetWidth;
    c.classList.add('rh-pop');
    if (go) {
      c.classList.add('rh-go');
      this.tachHideIn = 1.6;
      this.k.hint.hidden = true;
    }
  }

  /**
   * The finish line: a camera flash, and `text` over it ("¡FOTO FINISH! +0.31 s"; '' for the
   * flash alone); null clears it.
   */
  photo(text: string | null): void {
    const { flash, photo } = this.k;
    flash.hidden = text === null;
    photo.hidden = !text;
    photo.textContent = text ?? '';
    if (text === null) return;
    flash.classList.remove('rh-flash-on');
    void flash.offsetWidth;
    flash.classList.add('rh-flash-on');
  }

  /** `wait`: seconds before the player may go on after an R reset (0: none). */
  update(dt: number, f: { rpm: number | null; place: number; racers: number; time: number; progress: readonly number[]; length: number; wait: number }): void {
    setText(this.k.place, `${f.place} / ${f.racers}`);
    const waiting = f.wait > 0;
    if (this.k.wait.hidden === waiting) this.k.wait.hidden = !waiting;
    if (waiting) setText(this.k.waitN, String(Math.ceil(f.wait)));
    setText(this.k.time, raceClock(f.time));
    if (f.rpm !== null) this.needle.setAttribute('transform', `rotate(${angle(dial(f.rpm)).toFixed(1)} 100 100)`);
    if (this.tachHideIn > 0 && (this.tachHideIn -= dt) <= 0) {
      this.k.tach.classList.add('rh-tach-off');
      this.k.count.textContent = '';
    }
    f.progress.forEach((s, i) => {
      const k = Math.max(0, Math.min(1, s / f.length));
      this.dots[i].style.left = `${(k * 100).toFixed(1)}%`;
    });
  }

  showResults(r: RaceResults | null): void {
    const box = this.k.results;
    box.hidden = !r;
    if (!r) {
      this.k.tach.classList.remove('rh-tach-off');
      this.k.hint.hidden = false;
      this.k.count.textContent = '';
      this.tachHideIn = -1;
      return;
    }
    this.k.rTitle.textContent = r.solo ? 'Terminaste la carrera' : r.place === 1 ? '¡GANASTE, ÑAÑO!' : `Llegaste ${r.place}º`;
    this.k.rTable.innerHTML = r.rows
      .map((row) => `<li class="${row.player ? 'rh-me' : ''}"><span>${row.name}</span><small>${row.bus}</small><b>${row.time === null ? (r.final ? 'retirado' : 'en carrera') : `${row.estimated ? '≈ ' : ''}${raceClock(row.time)}`}</b></li>`)
      .join('');
    this.k.rLaunch.textContent = `Salida: ${r.launch}`;
    this.k.rBest.textContent = r.newBest ? `¡Récord de la ruta! ${raceClock(r.best!)}` : r.best !== null ? `Récord: ${raceClock(r.best)}` : '';
    this.k.rBest.classList.toggle('rh-record', r.newBest);
  }

  /** Online: "Volver a la sala" in place of another race. */
  setOnline(): void {
    const again = this.el.querySelector<HTMLElement>('[data-act="again"]')!;
    again.dataset.act = 'lobby';
    again.innerHTML = 'Volver a la sala <small>Enter</small>';
  }

  /** Online: the connection banner ("Reconectando…"); null hides it. */
  setNet(text: string | null): void {
    const el = this.k.net;
    if (el.hidden === (text === null)) {
      if (text !== null) setText(el, text);
      return;
    }
    el.hidden = text === null;
    if (text !== null) setText(el, text);
  }

  /** Online with the room gone: the way out is the menu. */
  setOffline(): void {
    this.el.querySelector<HTMLElement>('[data-act="lobby"]')!.innerHTML = 'Menú <small>Enter</small>';
    this.el.querySelector<HTMLElement>('[data-act="menu"]')!.hidden = true;
  }

  /** Racer i's dot on the progress strip in its own color (online: each player's; null keeps the default). */
  setColors(colors: readonly (string | null)[]): void {
    colors.forEach((c, i) => {
      if (c && this.dots[i]) this.dots[i].style.background = c;
    });
  }

  /** Hides racer i's dot on the strip (it left the race). */
  hideDot(i: number): void {
    if (this.dots[i]) this.dots[i].hidden = true;
  }

  get resultsOpen(): boolean {
    return !this.k.results.hidden;
  }
}

/** Rows for the results card, from the race's racers in finishing order. */
export function resultRows(racers: Racer[], order: number[], buses: string[]): RaceResultRow[] {
  return order.map((i) => ({ name: racers[i].name, bus: buses[i], time: racers[i].time, estimated: racers[i].estimated, player: i === 0 }));
}
