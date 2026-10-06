import { AirBrakes, DIESEL, PETROL, engineMix, engineRpm, makeLoop, type EngineVoice } from './soundModel';

/** Recorded sounds in public/sounds/ (sources and licenses in public/sounds/CREDITS.md). */
const FILES = ['engine-idle', 'engine-load', 'car-idle', 'air-brake', 'horn-bus', 'horn-car', 'door-open', 'door-close', 'chime'] as const;
type SoundName = (typeof FILES)[number];
/** Recordings that loop, and their crossfade length in seconds. */
const LOOPS: Partial<Record<SoundName, number>> = { 'engine-idle': 0.3, 'engine-load': 0.3, 'car-idle': 0.3, 'horn-bus': 0.12, 'horn-car': 0.08 };

export type AudioCue = 'coin' | 'time' | 'crash' | 'carHorn' | 'nitro';

export interface AudioFrame {
  hornHeld: boolean;
  /** |speed| over top speed (past 1 with nitro). */
  speedFrac: number;
  /** |speed| in m/s. */
  speed: number;
  /** Engine load 0..1 (`engineLoad`). */
  load: number;
  braking: boolean;
}

/**
 * Vehicle and game sounds. Buses get a recorded diesel (an idle and an on-load loop pitched
 * by a fake gearbox and crossfaded by RPM), air brakes, a truck horn and doors; the car gets a
 * petrol engine and a car horn. Recordings load after the first user gesture (browsers only
 * allow audio then); until they arrive, or if one fails, synthesized stand-ins play instead.
 */
export class BusAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private volume = 1;
  private buffers: Partial<Record<SoundName, AudioBuffer>> = {};
  private readonly voice: EngineVoice;
  private readonly brakes = new AirBrakes();
  private engine: EngineLayers | null = null;
  private engineSynth!: { osc: OscillatorNode; gain: GainNode };
  private horn: { gain: GainNode; sample: boolean } | null = null;
  private synthHornGain!: GainNode;

  constructor(
    private readonly kind: 'bus' | 'car' = 'bus',
    target: Window = window,
  ) {
    this.voice = kind === 'car' ? PETROL : DIESEL;
    // iPhone Safari only unlocks audio inside a gesture handler, and suspends it again when
    // the page is hidden or a call comes in: every gesture resumes it if needed.
    const unlock = () => {
      if (!this.ctx) this.init();
      if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume();
    };
    for (const ev of ['keydown', 'pointerdown', 'touchend', 'click']) target.addEventListener(ev, unlock);
  }

  private init(): void {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0.35 * this.volume;
    master.connect(ctx.destination);
    this.master = master;

    // Synth stand-ins, silent once the recordings are in.
    this.synthHornGain = ctx.createGain();
    this.synthHornGain.gain.value = 0;
    this.synthHornGain.connect(master);
    for (const f of this.kind === 'car' ? [415, 494] : [311, 392]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(this.synthHornGain);
      o.start();
    }
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    filter.connect(master);
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    gain.connect(filter);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.connect(gain);
    osc.start();
    this.engineSynth = { osc, gain };

    void this.load(ctx);
  }

  private async load(ctx: AudioContext): Promise<void> {
    await Promise.all(
      FILES.map(async (name) => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}sounds/${name}.mp3`);
          if (!res.ok) throw new Error(`${res.status}`);
          let buf = await ctx.decodeAudioData(await res.arrayBuffer());
          const xfade = LOOPS[name];
          if (xfade) {
            const data = makeLoop(buf.getChannelData(0), Math.round(xfade * buf.sampleRate), Math.round(0.03 * buf.sampleRate));
            buf = ctx.createBuffer(1, data.length, buf.sampleRate);
            buf.getChannelData(0).set(data);
          }
          this.buffers[name] = buf;
        } catch (e) {
          console.warn(`sound ${name} failed to load, using a synthesized one`, e);
        }
      }),
    );
    const b = this.buffers;
    const [idle, load] = this.kind === 'car' ? [b['car-idle'], b['car-idle']] : [b['engine-idle'], b['engine-load']];
    if (idle && load) {
      this.engine = new EngineLayers(ctx, this.master, idle, load, this.kind === 'car');
      this.engineSynth.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
      this.engineSynth.osc.stop(ctx.currentTime + 1);
    }
    const horn = b[this.kind === 'car' ? 'horn-car' : 'horn-bus'];
    if (horn) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      const src = ctx.createBufferSource();
      src.buffer = horn;
      src.loop = true;
      src.connect(gain);
      src.start();
      this.horn = { gain, sample: true };
    }
  }

  /** The audio context once a gesture has started it (the radio plays through it too). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Recordings decoded so far (e2e checks they all load). */
  get loaded(): string[] {
    return Object.keys(this.buffers);
  }

  /** 0..1, applied now or when audio starts. */
  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = 0.35 * v;
  }

  /** Plays a loaded recording once; false if it isn't loaded. */
  private play(name: SoundName, gain: number, at = 0, rate = 1, length?: number): boolean {
    const buf = this.buffers[name];
    if (!this.ctx || !buf) return false;
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (length !== undefined) {
      // Cut short with a quick fade (a beep out of a looping horn).
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.01);
      g.gain.setValueAtTime(gain, t + length);
      g.gain.linearRampToValueAtTime(0, t + length + 0.04);
      src.loop = !!LOOPS[name];
      src.start(t);
      src.stop(t + length + 0.05);
    } else src.start(t);
    src.connect(g).connect(this.master);
    return true;
  }

  /** Short cue: coin for money, chime for bonus time, thud for crashes, a car honking at the bus. */
  cue(kind: AudioCue, volume = 1): void {
    if (!this.ctx || volume <= 0.01) return;
    if (kind === 'nitro') return this.whoosh(volume);
    if (kind === 'carHorn') {
      // "pi-piii", each car a slightly different horn.
      const rate = 0.85 + Math.random() * 0.3;
      if (this.play('horn-car', 0.35 * volume, 0, rate, 0.12) && this.play('horn-car', 0.35 * volume, 0.22, rate, 0.35)) return;
    }
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

  /** Stopped at a stop: chime, the doors open with a hiss, and close again a moment later. */
  doors(): void {
    if (this.kind === 'car') return;
    this.play('chime', 0.5);
    this.play('door-open', 0.7, 0.25);
    this.play('door-close', 0.7, 2.4);
  }

  /** Nitro: a burst of filtered noise sweeping up. */
  private whoosh(volume: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const len = 0.9;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(300, now);
    filter.frequency.exponentialRampToValueAtTime(2400, now + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.5 * volume, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, now + len);
    src.connect(filter).connect(g).connect(this.master);
    src.start(now);
  }

  update(f: AudioFrame, dt: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.horn) this.horn.gain.gain.setTargetAtTime(f.hornHeld ? 0.55 : 0, now, f.hornHeld ? 0.01 : 0.04);
    else this.synthHornGain.gain.setTargetAtTime(f.hornHeld ? 0.25 : 0, now, 0.02);

    const { rpm } = engineRpm(f.speedFrac, f.load, this.voice);
    const mix = engineMix(rpm, f.load, this.voice);
    if (this.engine) this.engine.set(mix, rpm, f.load, now);
    else {
      this.engineSynth.osc.frequency.setTargetAtTime(rpm / (this.kind === 'car' ? 30 : 20), now, 0.08);
      this.engineSynth.gain.gain.setTargetAtTime(0.1 + f.load * 0.12, now, 0.1);
    }

    if (this.kind === 'car') return;
    const air = this.brakes.step(dt, f.speed, f.braking);
    // The long release when pulling up; a quick, higher, quieter burst of it on a hard stab.
    if (air === 'release') this.play('air-brake', 0.75);
    if (air === 'hiss') this.play('air-brake', 0.3, 0, 1.25, 0.35);
  }
}

/** The recorded engine: idle and on-load loops through a shared lowpass. */
class EngineLayers {
  private readonly idle: { src: AudioBufferSourceNode; gain: GainNode };
  private readonly load: { src: AudioBufferSourceNode; gain: GainNode };
  private readonly filter: BiquadFilterNode;
  private readonly out: GainNode;
  /** The car's petrol buzz on top of its recording (it has no on-load recording). */
  private readonly buzz: { osc: OscillatorNode; gain: GainNode } | null = null;

  constructor(ctx: AudioContext, dest: AudioNode, idle: AudioBuffer, load: AudioBuffer, car: boolean) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.7;
    this.filter.connect(this.out);
    const layer = (buf: AudioBuffer, offset: number) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.filter);
      src.start(0, offset % buf.duration);
      return { src, gain };
    };
    this.idle = layer(idle, 0);
    // Same recording for the car's two layers: start them apart so they don't phase.
    this.load = layer(load, car ? load.duration / 2 : 0);
    if (car) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.filter);
      osc.start();
      this.buzz = { osc, gain };
    }
  }

  set(m: ReturnType<typeof engineMix>, rpm: number, load: number, now: number): void {
    // Fast enough to drop at a shift, slow enough to never zipper.
    const k = 0.06;
    this.idle.src.playbackRate.setTargetAtTime(m.idleRate, now, k);
    this.load.src.playbackRate.setTargetAtTime(m.loadRate, now, k);
    this.idle.gain.gain.setTargetAtTime(m.idleGain, now, 0.1);
    this.load.gain.gain.setTargetAtTime(m.loadGain, now, 0.1);
    this.filter.frequency.setTargetAtTime(m.cutoff, now, 0.08);
    this.out.gain.setTargetAtTime(0.45 * m.volume, now, 0.1);
    if (this.buzz) {
      // Four cylinders fire twice a revolution.
      this.buzz.osc.frequency.setTargetAtTime(rpm / 30, now, k);
      this.buzz.gain.gain.setTargetAtTime(0.02 + 0.06 * load, now, 0.1);
    }
  }
}
