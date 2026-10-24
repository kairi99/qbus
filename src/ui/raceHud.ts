import { IDLE, WINDOW } from '../gameplay/launch';
import { type Racer, bestLap, raceClock } from '../gameplay/raceGame';
import { setStyle, setText } from './dom';

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
  /** Circuits: the racer's fastest lap (s), null before its first; absent elsewhere (no column). */
  bestLap?: number | null;
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
  /** An online race: `best` is the player's best online time. */
  online?: boolean;
  /** Circuits: the player's best lap on record (s) and whether this race beat it. */
  bestLap?: number | null;
  newLap?: boolean;
}

export type RaceHudAction = 'again' | 'menu' | 'lobby' | 'watchPrev' | 'watchNext' | 'results' | 'endNow' | 'keep';

/**
 * The race's HUD (Spanish): the route and the player's place and time (top left), the big
 * countdown, the tachometer with its green launch window (big during the countdown, gone a
 * moment after GO), a progress strip with every racer on it, and the results card.
 */
export class RaceHud {
  onAction: ((a: RaceHudAction) => void) | null = null;
  /** Online: the banner's "Reconectar". */
  onRetry: (() => void) | null = null;
  private el: HTMLElement;
  private k: Record<string, HTMLElement> = {};
  private needle: SVGElement;
  private dots: HTMLElement[] = [];
  private tachHideIn = -1;
  private fast = false;
  /** Lap numbers last written: lap, laps, last and best in tenths (-1: none). */
  private readonly lapKey = [0, 0, -2, -2];

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
        <div class="rh-lap" data-k="lap" hidden><b data-k="lapN">Vuelta 1/1</b><small data-k="lapTimes"></small></div>
      </div>
      <div class="rh-count" data-k="count"></div>
      <div class="rh-flash" data-k="flash" hidden></div>
      <div class="rh-photo" data-k="photo" hidden></div>
      <div class="rh-wait" data-k="wait" hidden>De vuelta en la vía… <b data-k="waitN">3</b></div>
      <div class="rh-off" data-k="off" hidden>¡Vuelve a la vía! <b data-k="offN">6</b></div>
      <div class="rh-mud" data-k="mud" hidden>¡Llantas con lodo! Menos agarre<i class="rh-mud-bar"><i data-k="mudBar"></i></i></div>
      <div class="rh-net" data-k="net" hidden><span data-k="netText"></span><button class="gh-btn rh-net-btn" data-act="retry" hidden>Reconectar</button></div>
      <div class="rh-watch" data-k="watch" hidden>
        <button class="gh-btn rh-watch-btn" data-act="watchPrev" aria-label="Anterior">◀</button>
        <span class="rh-watch-text">Viendo: <b data-k="wName"></b> · <span data-k="wPlace"></span> · <span data-k="wGap"></span></span>
        <button class="gh-btn rh-watch-btn" data-act="watchNext" aria-label="Siguiente">▶</button>
      </div>
      <div class="rh-live" data-k="live" hidden>
        <h3>Resultados</h3>
        <ol class="rh-table" data-k="liveTable"></ol>
        <div class="rh-live-btns">
          <button class="gh-btn" data-act="results">Ver resultados <small>Esc</small></button>
          <button class="gh-btn" data-act="endNow" data-k="endNow">Terminar ya</button>
        </div>
      </div>
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
          <p data-k="rLap" hidden></p>
          <div class="gh-actions">
            <button class="gh-btn gh-btn-go" data-act="again">Otra carrera <small>Enter</small></button>
            <button class="gh-btn" data-act="menu">Menú</button>
            <button class="gh-btn" data-act="keep" data-k="keep" hidden>Seguir viendo <small>Esc</small></button>
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
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'retry') this.onRetry?.();
      else if (act) this.onAction?.(act as RaceHudAction);
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
  update(dt: number, f: { rpm: number | null; place: number; racers: number; time: number; progress: readonly number[]; length: number; lap?: { n: number; count: number; length: number; last: number | null; best: number | null }; wait: number; tires: number; offRoad: number }): void {
    setText(this.k.place, `${f.place} / ${f.racers}`);
    const waiting = f.wait > 0;
    if (this.k.wait.hidden === waiting) this.k.wait.hidden = !waiting;
    if (waiting) setText(this.k.waitN, String(Math.ceil(f.wait)));
    const lost = f.offRoad > 0;
    if (this.k.off.hidden === lost) this.k.off.hidden = !lost;
    if (lost) setText(this.k.offN, String(Math.ceil(f.offRoad)));
    const muddy = f.tires > 0;
    if (this.k.mud.hidden === muddy) this.k.mud.hidden = !muddy;
    if (muddy) setStyle(this.k.mudBar, 'width', `${Math.round(f.tires * 20) * 5}%`);
    setText(this.k.time, raceClock(f.time));
    if (f.rpm !== null) this.needle.setAttribute('transform', `rotate(${angle(dial(f.rpm)).toFixed(1)} 100 100)`);
    if (this.tachHideIn > 0 && (this.tachHideIn -= dt) <= 0) {
      this.k.tach.classList.add('rh-tach-off');
      this.k.count.textContent = '';
    }
    const lap = f.lap;
    if (this.k.lap.hidden === !!lap) this.k.lap.hidden = !lap;
    if (lap) {
      // Strings only when a number changes at display resolution (0.1 s).
      const last = lap.last === null ? -1 : Math.round(lap.last * 10);
      const best = lap.best === null ? -1 : Math.round(lap.best * 10);
      if (lap.n !== this.lapKey[0] || lap.count !== this.lapKey[1]) {
        this.lapKey[0] = lap.n;
        this.lapKey[1] = lap.count;
        if (!this.fast) setText(this.k.lapN, `Vuelta ${lap.n}/${lap.count}`);
      }
      if (last !== this.lapKey[2] || best !== this.lapKey[3]) {
        this.lapKey[2] = last;
        this.lapKey[3] = best;
        setText(this.k.lapTimes, lap.last === null ? '' : `Última ${raceClock(lap.last)} · Mejor ${raceClock(lap.best!)}`);
      }
    }
    f.progress.forEach((s, i) => {
      // A circuit's strip is the current lap, each racer on its own.
      const k = lap ? (s >= f.length ? 1 : Math.max(0, Math.min(1, (s % lap.length) / lap.length))) : Math.max(0, Math.min(1, s / f.length));
      this.dots[i].style.left = `${(k * 100).toFixed(1)}%`;
    });
  }

  /** A small banner in place of "Vuelta N/3" ("¡Vuelta rápida!"); null puts the lap back. */
  fastLap(text: string | null): void {
    this.fast = text !== null;
    this.k.lap.classList.toggle('rh-lap-fast', this.fast);
    if (text !== null) setText(this.k.lapN, text);
    else this.lapKey[0] = 0;
  }

  /**
   * The spectator strip: who the camera follows, their place and the gap (s) to the one ahead
   * (null gap: leading); null hides it.
   */
  watch(info: { name: string; place: number; gap: number | null } | null): void {
    const el = this.k.watch;
    if (el.hidden !== !info) el.hidden = !info;
    if (!info) return;
    setText(this.k.wName, info.name);
    setText(this.k.wPlace, `${info.place}º`);
    setText(this.k.wGap, info.gap === null ? 'va primero' : `+${info.gap.toFixed(1)} s`);
  }

  /** The compact results beside the view, rebuilt when its rows change; null hides it. */
  live(r: RaceResults | null): void {
    const el = this.k.live;
    if (el.hidden !== !r) el.hidden = !r;
    if (!r) return;
    const html = r.rows
      .map((row) => `<li class="${row.player ? 'rh-me' : ''}"><span>${row.name}</span>${lapCell(row)}<b>${row.time === null ? 'en carrera' : `${row.estimated ? '≈ ' : ''}${raceClock(row.time)}`}</b></li>`)
      .join('');
    this.k.liveTable.classList.toggle('rh-laps', r.rows.some((row) => row.bestLap !== undefined));
    if (this.k.liveTable.innerHTML !== html) this.k.liveTable.innerHTML = html;
  }

  /** Hides the full card only (the view behind it stays as it is). */
  closeResults(): void {
    this.k.results.hidden = true;
  }

  /** `keep`: others still race, so the card can be put away ("Seguir viendo"). */
  showResults(r: RaceResults | null, keep = false): void {
    const box = this.k.results;
    box.hidden = !r;
    this.k.keep.hidden = !keep;
    if (!r) {
      this.k.tach.classList.remove('rh-tach-off');
      this.k.hint.hidden = false;
      this.k.count.textContent = '';
      this.tachHideIn = -1;
      return;
    }
    this.k.rTitle.textContent = r.solo ? 'Terminaste la carrera' : r.place === 1 ? '¡GANASTE, ÑAÑO!' : `Llegaste ${r.place}º`;
    this.k.rTable.innerHTML = r.rows
      .map((row) => `<li class="${row.player ? 'rh-me' : ''}"><span>${row.name}</span><small>${row.bus}</small>${lapCell(row)}<b>${row.time === null ? (r.final ? 'retirado' : 'en carrera') : `${row.estimated ? '≈ ' : ''}${raceClock(row.time)}`}</b></li>`)
      .join('');
    this.k.rTable.classList.toggle('rh-laps', r.rows.some((row) => row.bestLap !== undefined));
    this.k.rLaunch.textContent = `Salida: ${r.launch}`;
    this.k.rBest.textContent = r.newBest ? `¡Récord${r.online ? ' en línea' : ' de la ruta'}! ${raceClock(r.best!)}` : r.best !== null ? `${r.online ? 'Tu mejor en línea' : 'Récord'}: ${raceClock(r.best)}` : '';
    this.k.rBest.classList.toggle('rh-record', r.newBest);
    const lapLine = r.bestLap !== undefined && r.bestLap !== null;
    this.k.rLap.hidden = !lapLine;
    if (lapLine) this.k.rLap.textContent = r.newLap ? `¡Vuelta récord! ${raceClock(r.bestLap!)}` : `${r.online ? 'Tu mejor vuelta en línea' : 'Mejor vuelta'}: ${raceClock(r.bestLap!)}`;
    this.k.rLap.classList.toggle('rh-record', !!r.newLap);
  }

  /** Online: "Volver a la sala" in place of another race. */
  setOnline(): void {
    const again = this.el.querySelector<HTMLElement>('[data-act="again"]')!;
    again.dataset.act = 'lobby';
    again.innerHTML = 'Volver a la sala <small>Enter</small>';
    // "Terminar ya" guesses times from pace: online they come from the server.
    this.k.endNow.hidden = true;
  }

  /** Online: the connection banner ("Reconectando…", with a button to try again now); null hides it. */
  setNet(text: string | null, retry = false): void {
    const el = this.k.net;
    el.hidden = text === null;
    if (text !== null) setText(this.k.netText, text);
    this.el.querySelector<HTMLElement>('[data-act="retry"]')!.hidden = !retry;
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

/** The best-lap cell of a results row (circuits only: rows without `bestLap` get none). */
function lapCell(row: RaceResultRow): string {
  return row.bestLap === undefined ? '' : `<em>${row.bestLap === null ? '—' : raceClock(row.bestLap)}</em>`;
}

/** Rows for the results card, from the race's racers in finishing order. */
export function resultRows(racers: Racer[], order: number[], buses: string[], laps = false): RaceResultRow[] {
  return order.map((i) => {
    const row: RaceResultRow = { name: racers[i].name, bus: buses[i], time: racers[i].time, estimated: racers[i].estimated, player: i === 0 };
    if (laps) row.bestLap = bestLap(racers[i]);
    return row;
  });
}
