import type { Rating } from '../gameplay/routeGame';
import type { TrickKind } from '../gameplay/scoring';

export type HudAction = 'again' | 'menu' | 'resume';

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const TRICK_LABEL: Record<TrickKind, string> = {
  drift: 'Derrape',
  air: 'Al aire',
  nearMiss: 'Con las justas',
  knock: 'Chuta',
  speed: 'Rapidazo',
  crash: 'Choque',
};

export const RATING_LABEL: Record<Rating, string> = { fast: 'Volando', ok: 'A tiempo', slow: 'Qué lento' };

export interface Results {
  cents: number;
  delivered: number;
  bestCombo: number;
  longestAir: number;
}

/** Route/score overlay: timer, money, destination board, combo, popups, speech and results. */
export class GameHud {
  private el: Record<string, HTMLElement> = {};
  private speechUntil = 0;
  private clock = 0;

  constructor(root: HTMLElement, routeName = '') {
    const wrap = document.createElement('div');
    wrap.className = 'gh';
    wrap.innerHTML = `
      <div class="gh-top">
        <div class="gh-timer" data-k="timer">90</div>
        <div class="gh-board" data-k="board">
          <div class="gh-board-stop" data-k="stop"></div>
          <div class="gh-board-meta"><span data-k="dist"></span><span data-k="off"></span></div>
        </div>
        <div class="gh-feed" data-k="feed"></div>
      </div>
      <div class="gh-money" data-k="money">$0.00</div>
      <div class="gh-route">${routeName}</div>
      <div class="gh-riders" data-k="riders"></div>
      <div class="gh-combo" data-k="combo"></div>
      <div class="gh-speech" data-k="speech"><small data-k="speaker"></small><span data-k="line"></span></div>
      <div class="gh-prompt" data-k="prompt">Acelera con <b>W</b> para empezar la ruta</div>
      <div class="gh-results" data-k="results" hidden>
        <div class="gh-results-card">
          <h2>Fin del turno</h2>
          <div class="gh-results-total" data-k="rTotal"></div>
          <dl>
            <dt>Pasajeros entregados</dt><dd data-k="rDelivered"></dd>
            <dt>Mejor combo</dt><dd data-k="rCombo"></dd>
            <dt>Mayor vuelo</dt><dd data-k="rAir"></dd>
          </dl>
          <div class="gh-actions">
            <button class="gh-btn gh-btn-go" data-act="again">Otra vuelta <small>Enter</small></button>
            <button class="gh-btn" data-act="menu">Menú</button>
          </div>
        </div>
      </div>
      <div class="gh-results gh-pause" data-k="pause" hidden>
        <div class="gh-results-card">
          <h2>Pausa</h2>
          <div class="gh-actions gh-actions-col">
            <button class="gh-btn gh-btn-go" data-act="resume">Seguir <small>Esc</small></button>
            <button class="gh-btn" data-act="again">Reiniciar turno</button>
            <button class="gh-btn" data-act="menu">Volver al menú</button>
          </div>
        </div>
      </div>`;
    root.appendChild(wrap);
    wrap.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    wrap.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => b.addEventListener('click', () => this.onAction?.(b.dataset.act as HudAction)));
  }

  /** Clicks on results/pause buttons. */
  onAction: ((a: HudAction) => void) | null = null;

  showPause(on: boolean): void {
    this.el.pause.hidden = !on;
    if (on) this.el.pause.querySelector<HTMLElement>('button')?.focus();
  }

  update(dt: number, s: { timeLeft: number; cents: number; onBoard: number; capacity: number; chain: number; started: boolean }): void {
    this.clock += dt;
    const secs = Math.ceil(s.timeLeft);
    this.el.timer.textContent = String(secs);
    this.el.timer.classList.toggle('low', s.started && secs <= 10);
    this.el.money.textContent = money(s.cents);
    this.el.riders.textContent = `${s.onBoard} a bordo`;
    this.el.prompt.hidden = s.started;
    this.el.combo.textContent = s.chain >= 2 ? `Combo ×${s.chain}` : '';
    this.el.combo.classList.toggle('on', s.chain >= 2);
    if (this.clock > this.speechUntil) this.el.speech.classList.remove('on');
  }

  board(stopName: string, meters: number, gettingOff: number): void {
    this.el.stop.textContent = stopName;
    this.el.dist.textContent = `${Math.round(meters / 10) * 10} m`;
    this.el.off.textContent = gettingOff ? `Se bajan ${gettingOff}` : 'Solo suben';
    this.el.board.classList.toggle('dropoff', gettingOff > 0);
  }

  /** Short floating line: "+$0.40 Derrape ×2", "+8 s Volando". */
  popup(text: string, tone: 'money' | 'time' | 'bad' = 'money'): void {
    const p = document.createElement('div');
    p.className = `gh-pop ${tone}`;
    p.textContent = text;
    this.el.feed.prepend(p);
    while (this.el.feed.children.length > 4) this.el.feed.lastElementChild!.remove();
    setTimeout(() => p.remove(), 1800);
  }

  say(speaker: string, line: string, seconds = 2.6): boolean {
    if (this.clock < this.speechUntil - 1) return false; // don't talk over a fresh line
    this.el.speaker.textContent = speaker;
    this.el.line.textContent = line;
    this.el.speech.classList.add('on');
    this.speechUntil = this.clock + seconds;
    return true;
  }

  showResults(r: Results | null): void {
    this.el.results.hidden = !r;
    if (!r) return;
    this.el.speech.classList.remove('on');
    this.speechUntil = 0;
    this.el.rTotal.textContent = money(r.cents);
    this.el.rDelivered.textContent = String(r.delivered);
    this.el.rCombo.textContent = r.bestCombo >= 2 ? `×${r.bestCombo}` : '—';
    this.el.rAir.textContent = r.longestAir > 0 ? `${r.longestAir.toFixed(1)} s` : '—';
    this.el.results.querySelector<HTMLElement>('button')?.focus();
  }
}
