import { type RadioSetting, type Station, livePosition, nextStation, stationById } from './radioStations';

/** Music level under the engine and effects (the songs are mastered to -16 LUFS). */
const MUSIC_GAIN = 0.32;
/** The radio as heard from the driver's seat: a small speaker, no airy top. */
const CABIN_CUTOFF = 7500;
/** Paused: quieter and muffled, as if the menu were in front of the speaker. */
const PAUSED = { gain: 0.35, cutoff: 1200 };

/**
 * The bus radio. Each station loops one song and is "live": tune in and it's wherever it would
 * be had it kept playing (the session clock plus the station's offset). A song is downloaded the
 * first time its station is tuned (never on the menu), and only the station on air is kept
 * decoded. Switching plays a short burst of tuning static. It needs the game's AudioContext,
 * which only exists after the first gesture: until `update` gets one, it just keeps time.
 */
export class Radio {
  private ctx: AudioContext | null = null;
  private gain!: GainNode;
  private filter!: BiquadFilterNode;
  private staticBuf!: AudioBuffer;
  private source: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private onAir: { id: string; buffer: AudioBuffer } | null = null;
  private readonly files = new Map<string, Promise<ArrayBuffer>>();
  /** Bumped on every switch, so a song that finishes decoding late doesn't start over another. */
  private tuning = 0;
  private readonly startedAt = performance.now();
  private volume = 1;
  private paused = false;
  /** Songs downloaded and decoded at least once (e2e checks them). */
  readonly loaded = new Set<string>();
  /** Called when a station starts playing (or the radio goes off). */
  onTune: (station: Station | null) => void = () => {};

  constructor(
    public station: RadioSetting,
    volume: number,
  ) {
    this.volume = volume;
  }

  /** Session seconds: every station's songs keep "playing" by this clock. */
  get clock(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  get playing(): boolean {
    return !!this.source;
  }

  /** Per frame: picks up the AudioContext once there is one, and follows pause. */
  update(ctx: AudioContext | null, paused: boolean): void {
    if (ctx && !this.ctx) this.init(ctx);
    if (paused !== this.paused) {
      this.paused = paused;
      this.applyLevel(0.25);
    }
  }

  /** Tunes the next station on the dial (off is one of them); returns what's on now. */
  next(step: 1 | -1 = 1): RadioSetting {
    this.tune(nextStation(this.station, step));
    return this.station;
  }

  tune(id: RadioSetting): void {
    this.station = id;
    if (!this.ctx) return;
    this.tuning++;
    this.stopSource();
    this.onAir = null;
    this.crackle();
    if (id === 'off') this.onTune(null);
    // Music turned all the way down: nothing to download.
    else if (this.volume > 0) void this.play(stationById(id)!, this.tuning);
  }

  setVolume(v: number): void {
    this.volume = v;
    this.applyLevel(0.05);
  }

  private init(ctx: AudioContext): void {
    this.ctx = ctx;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.5;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.filter).connect(ctx.destination);
    // Tuning static: crackly noise (sparse pops over hiss), made once.
    const len = Math.round(ctx.sampleRate * 0.5);
    this.staticBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.staticBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.02 ? 1 : 0.35);
    this.applyLevel(0);
    if (this.station !== 'off') this.tune(this.station);
  }

  private applyLevel(timeConstant: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const level = MUSIC_GAIN * this.volume * (this.paused ? PAUSED.gain : 1);
    const cutoff = this.paused ? PAUSED.cutoff : CABIN_CUTOFF;
    if (timeConstant > 0) {
      this.gain.gain.setTargetAtTime(level, now, timeConstant);
      this.filter.frequency.setTargetAtTime(cutoff, now, timeConstant);
    } else {
      this.gain.gain.value = level;
      this.filter.frequency.value = cutoff;
    }
  }

  private fetchSong(st: Station): Promise<ArrayBuffer> {
    let p = this.files.get(st.id);
    if (!p) {
      p = fetch(`${import.meta.env.BASE_URL}music/${st.file}`).then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.arrayBuffer();
      });
      // A failed download may be retried on the next visit to the station.
      p.catch(() => this.files.delete(st.id));
      this.files.set(st.id, p);
    }
    return p;
  }

  private async play(st: Station, token: number): Promise<void> {
    const ctx = this.ctx!;
    let buffer: AudioBuffer;
    try {
      // decodeAudioData takes the bytes over: decode a copy, keep the download for next time.
      buffer = await ctx.decodeAudioData((await this.fetchSong(st)).slice(0));
    } catch (e) {
      console.warn(`radio: ${st.file} failed to load`, e);
      return;
    }
    this.loaded.add(st.id);
    if (token !== this.tuning) return;
    this.onAir = { id: st.id, buffer };
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + 0.25);
    src.connect(gain).connect(this.gain);
    src.start(now, livePosition(this.clock, st, buffer.duration));
    this.source = { src, gain };
    this.onTune(st);
  }

  private stopSource(): void {
    if (!this.source || !this.ctx) return;
    const { src, gain } = this.source;
    const now = this.ctx.currentTime;
    gain.gain.setTargetAtTime(0, now, 0.03);
    src.stop(now + 0.2);
    this.source = null;
  }

  /** A short burst of between-stations static. */
  private crackle(): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.staticBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.8;
    band.frequency.setValueAtTime(900 + Math.random() * 1500, now);
    band.frequency.exponentialRampToValueAtTime(2500 + Math.random() * 2000, now + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.setTargetAtTime(0, now + 0.22, 0.05);
    src.connect(band).connect(g).connect(this.gain);
    src.start(now);
    src.stop(now + 0.5);
  }
}
