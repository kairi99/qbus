/**
 * Synthesized placeholder sounds (no asset files): a two-tone horn and an engine drone
 * whose pitch follows speed. Browsers only allow audio after a user gesture, so the
 * context is created lazily on the first key press.
 */
export class BusAudio {
  private ctx: AudioContext | null = null;
  private hornGain!: GainNode;
  private engineOsc!: OscillatorNode;
  private engineGain!: GainNode;
  private master!: GainNode;
  private volume = 1;

  constructor(target: Window = window) {
    const start = () => {
      this.init();
      target.removeEventListener('keydown', start);
      target.removeEventListener('pointerdown', start);
    };
    target.addEventListener('keydown', start);
    target.addEventListener('pointerdown', start);
  }

  private init(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.35 * this.volume;
    master.connect(ctx.destination);
    this.master = master;

    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    this.hornGain.connect(master);
    for (const f of [311, 392]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(this.hornGain);
      o.start();
    }

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    filter.connect(master);
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.15;
    this.engineGain.connect(filter);
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.connect(this.engineGain);
    this.engineOsc.start();
  }

  /** 0..1, applied now or when audio starts. */
  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = 0.35 * v;
  }

  /** Short synthesized cue: coin for money, chime for bonus time, thud for crashes. */
  cue(kind: 'coin' | 'time' | 'crash' | 'carHorn', volume = 1): void {
    if (!this.ctx || volume <= 0.01) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes: [number, number][] =
      kind === 'coin' ? [[988, 0], [1319, 0.07]]
      : kind === 'time' ? [[660, 0], [880, 0.09], [1175, 0.18]]
      : kind === 'carHorn' ? [[520, 0], [620, 0], [520, 0.22], [620, 0.22]] // "pi-piii"
      : [[70, 0]];
    for (const [freq, at] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = kind === 'crash' ? 'triangle' : 'square';
      o.frequency.setValueAtTime(freq, now + at);
      if (kind === 'crash') o.frequency.exponentialRampToValueAtTime(35, now + 0.25);
      g.gain.setValueAtTime(0, now + at);
      const peak = (kind === 'crash' ? 0.6 : kind === 'carHorn' ? 0.08 : 0.12) * volume;
      const len = kind === 'crash' ? 0.3 : kind === 'carHorn' ? (at > 0 ? 0.35 : 0.14) : 0.16;
      g.gain.linearRampToValueAtTime(peak, now + at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, now + at + len);
      o.connect(g).connect(this.master);
      o.start(now + at);
      o.stop(now + at + 0.5);
    }
  }

  update(hornHeld: boolean, speedFrac: number, throttle: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.hornGain.gain.setTargetAtTime(hornHeld ? 0.25 : 0, now, 0.02);
    // Fake gearbox: pitch climbs then drops at three "shift points".
    const gear = Math.min(3, Math.floor(speedFrac * 4));
    const inGear = speedFrac * 4 - gear;
    this.engineOsc.frequency.setTargetAtTime(38 + inGear * 45 + gear * 6 + Math.abs(throttle) * 8, now, 0.08);
    this.engineGain.gain.setTargetAtTime(0.1 + Math.abs(throttle) * 0.12, now, 0.1);
  }
}
