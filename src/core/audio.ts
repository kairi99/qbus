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
    master.gain.value = 0.35;
    master.connect(ctx.destination);

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
