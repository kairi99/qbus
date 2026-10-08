import { HOVERABLE, MENU_LEVELS, type MenuSound, SLIDER_GAP, START_DELAY_MS, TickLimiter, clickSound, inputSound, jitter } from './menuSoundModel';

/**
 * UI sounds for the title/setup menu, all synthesized (no files, so nothing to fetch): ticks
 * on hover/focus, bus-flavored confirms (stop bell, ticket punch, horn and air brake), a back
 * blip and setting clicks. Listens on the menu's root (delegated, so screens re-rendered with
 * innerHTML need no wiring). The AudioContext starts on the first gesture and dies with the
 * page when a shift starts (the game makes its own). Without Web Audio it stays silent.
 */
export class MenuSounds {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly ticks = new TickLimiter();
  private lastSlider = -Infinity;
  /** Sounds played so far (dev builds expose it for e2e). */
  readonly played: MenuSound[] = [];

  constructor(
    root: HTMLElement,
    /** The volume setting 0..1, read at every sound (so a slider preview plays at the new level). */
    private readonly volume: () => number,
  ) {
    const unlock = () => {
      try {
        if (!this.ctx && typeof AudioContext !== 'undefined') this.init();
        if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
      } catch {
        this.ctx = null; // no audio here: stay silent
      }
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true });

    root.addEventListener('pointerover', (e) => {
      const el = (e.target as Element).closest?.(HOVERABLE);
      if (el) this.hover(el);
      else this.ticks.leave();
    });
    // Keyboard focus moves (Tab); pointer focus is silenced by the click's own sound.
    root.addEventListener('focusin', (e) => {
      const el = (e.target as Element).closest?.(HOVERABLE);
      if (el) this.hover(el);
    });
    root.addEventListener('click', (e) => {
      const el = (e.target as Element).closest?.('button');
      const s = el && !(el as HTMLButtonElement).disabled ? clickSound(el) : null;
      if (s) this.play(s);
    });
    root.addEventListener('change', (e) => {
      const s = inputSound(e.target as Element);
      if (s === 'toggle') this.play(s);
    });
    root.addEventListener('input', (e) => {
      if (inputSound(e.target as Element) !== 'slider') return;
      const t = performance.now() / 1000;
      if (t - this.lastSlider < SLIDER_GAP) return;
      this.lastSlider = t;
      this.play('slider');
    });
  }

  /** Milliseconds to wait before leaving the page so the start sound is heard (0 if silent). */
  get leaveDelay(): number {
    return this.ctx?.state === 'running' && this.volume() > 0.01 ? START_DELAY_MS : 0;
  }

  private init(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    // Same master level as the game's mix (BusAudio), so the menu is never louder than a shift.
    this.master.connect(ctx.destination);
    const len = Math.ceil(ctx.sampleRate * 0.6);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  private hover(el: Element): void {
    if (this.ticks.tick(el, performance.now() / 1000)) this.play('hover');
  }

  play(s: MenuSound): void {
    this.played.push(s);
    if (s !== 'hover') this.ticks.loud(performance.now() / 1000);
    const ctx = this.ctx;
    const vol = this.volume();
    if (!ctx || !this.master || ctx.state !== 'running' || vol <= 0.01) return;
    try {
      this.master.gain.value = 0.35 * vol;
      this.voice(ctx, s, MENU_LEVELS[s], jitter(s, Math.random()));
    } catch {
      // A sound that fails to build is just skipped.
    }
  }

  private voice(ctx: AudioContext, s: MenuSound, peak: number, rate: number): void {
    const now = ctx.currentTime;
    switch (s) {
      case 'hover':
        return this.tone(now, 'triangle', 1900 * rate, peak, 0.035);
      case 'slider':
        return this.tone(now, 'triangle', 1400 * rate, peak, 0.05);
      case 'toggle':
        // A switch: a dry click with a little body.
        this.burst(now, 3200 * rate, 4, peak * 0.8, 0.02);
        return this.tone(now, 'square', 620 * rate, peak * 0.5, 0.04);
      case 'confirm':
        // The rear-door stop buzzer ("timbre"), one short ring: a buzzy square at mains-ish hum.
        return this.tone(now, 'square', 220 * rate, peak, 0.11, 1800, 30 * rate);
      case 'select':
        // "Ding-dong" of a newer bus's stop-request bell.
        this.tone(now, 'sine', 1175 * rate, peak, 0.25);
        return this.tone(now + 0.11, 'sine', 932 * rate, peak, 0.35);
      case 'route':
        // The conductor punching a ticket, then a coin dropping in the box.
        this.burst(now, 1500 * rate, 2, peak, 0.03);
        this.tone(now + 0.06, 'sine', 2637 * rate, peak * 0.7, 0.18);
        return this.tone(now + 0.06, 'sine', 3951 * rate, peak * 0.35, 0.12);
      case 'back':
        return this.tone(now, 'triangle', 520 * rate, peak, 0.12, 0, 0, 330 * rate);
      case 'start':
        // "Pi-pííí" on a two-note truck horn, then the air brake letting go.
        this.horn(now, rate, peak, 0.09);
        this.horn(now + 0.14, rate, peak, 0.2);
        return this.burst(now + 0.2, 2600, 0.7, peak * 0.9, 0.35, 0.12);
    }
  }

  /**
   * One enveloped oscillator: `len` s of decay; optional lowpass (`cutoff`), a buzz (`am` Hz
   * tremolo) and a glide to `to` Hz.
   */
  private tone(at: number, type: OscillatorType, freq: number, peak: number, len: number, cutoff = 0, am = 0, to = 0): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (to) o.frequency.exponentialRampToValueAtTime(to, at + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, at + len);
    let out: AudioNode = o;
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoff;
      out = out.connect(f);
    }
    if (am) {
      // The buzzer's armature rattling: a fast tremolo.
      const trem = ctx.createGain();
      trem.gain.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = am;
      const depth = ctx.createGain();
      depth.gain.value = 0.4;
      lfo.connect(depth).connect(trem.gain);
      lfo.start(at);
      lfo.stop(at + len + 0.05);
      out = out.connect(trem);
    }
    out.connect(g).connect(this.master!);
    o.start(at);
    o.stop(at + len + 0.05);
  }

  /** Filtered noise: clicks and punches (short, narrow) or the air brake's hiss (`attack` > 0, wide). */
  private burst(at: number, freq: number, q: number, peak: number, len: number, attack = 0.002): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, at + attack + len);
    src.connect(f).connect(g).connect(this.master!);
    src.start(at);
    src.stop(at + attack + len + 0.05);
  }

  /** The bus horn's two notes (the same pair as the game's synth horn), held `len` s, muffled a little. */
  private horn(at: number, rate: number, peak: number, len: number): void {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak * 0.5, at + 0.01);
    g.gain.setValueAtTime(peak * 0.5, at + len);
    g.gain.linearRampToValueAtTime(0, at + len + 0.04);
    f.connect(g).connect(this.master!);
    for (const hz of [311, 392]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = hz * rate;
      o.connect(f);
      o.start(at);
      o.stop(at + len + 0.06);
    }
  }
}
