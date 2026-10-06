import { type OnAir, type RadioSetting, type Song, type Station, nextStation, onAirAt, stationById } from './radioStations';

/** Music level under the engine and effects (the songs are mastered to -16 LUFS). */
const MUSIC_GAIN = 0.32;
/** The radio as heard from the driver's seat: a small speaker, no airy top. */
const CABIN_CUTOFF = 7500;
/** Paused: quieter and muffled, as if the menu were in front of the speaker. */
const PAUSED = { gain: 0.35, cutoff: 1200 };
/** Seconds before a song ends that the station's next song is downloaded and decoded. */
const PREFETCH = 12;

interface Playing {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

/**
 * The bus radio. Each station plays its playlist on a loop and is "live": tune in and it's
 * wherever it would be had it kept playing (the session clock plus the station's offset). A song
 * is downloaded the first time it's needed (never on the menu), and only the song on air is kept
 * decoded: a few seconds before it ends, the station's next song is fetched, decoded and queued
 * to start right as it finishes. Switching plays a short burst of tuning static. It needs the
 * game's AudioContext, which only exists after the first gesture: until `update` gets one, it
 * just keeps time.
 */
export class Radio {
  private ctx: AudioContext | null = null;
  private gain!: GainNode;
  private filter!: BiquadFilterNode;
  private staticBuf!: AudioBuffer;
  /** The song on air, plus the next one once it's queued (until the first ends). */
  private sources: Playing[] = [];
  private readonly files = new Map<string, Promise<ArrayBuffer>>();
  /** Bumped on every switch, so a song that finishes decoding late doesn't start over another. */
  private tuning = 0;
  private prefetchTimer = 0;
  private readonly startedAt = performance.now();
  private volume = 1;
  private paused = false;
  /** Seconds added to the session clock (e2e jumps to the end of a song with it). */
  skew = 0;
  /** Songs (files) downloaded and decoded at least once (e2e checks them). */
  readonly loaded = new Set<string>();
  /** The song playing now (null while off, loading or between stations). */
  nowPlaying: Song | null = null;
  /** Called when a station starts playing (or the radio goes off). */
  onTune: (station: Station | null, song: Song | null) => void = () => {};
  /** Called when a station moves on to its next song by itself. */
  onSong: (station: Station, song: Song) => void = () => {};

  constructor(
    public station: RadioSetting,
    volume: number,
  ) {
    this.volume = volume;
  }

  /** Session seconds: every station's songs keep "playing" by this clock. */
  get clock(): number {
    return (performance.now() - this.startedAt) / 1000 + this.skew;
  }

  get playing(): boolean {
    return this.sources.length > 0;
  }

  /** What the tuned station is broadcasting right now (whether or not it has loaded yet). */
  onAir(): OnAir | null {
    const st = stationById(this.station);
    return st && onAirAt(this.clock, st);
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
    this.stopSources();
    this.crackle();
    if (id === 'off') this.onTune(null, null);
    // Music turned all the way down: nothing to download.
    else if (this.volume > 0) void this.play(stationById(id)!, this.tuning, true);
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

  private fetchSong(song: Song): Promise<ArrayBuffer> {
    let p = this.files.get(song.file);
    if (!p) {
      p = fetch(`${import.meta.env.BASE_URL}music/${song.file}`).then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.arrayBuffer();
      });
      // A failed download may be retried the next time the song is needed.
      p.catch(() => this.files.delete(song.file));
      this.files.set(song.file, p);
    }
    return p;
  }

  private async decode(song: Song): Promise<AudioBuffer | null> {
    try {
      // decodeAudioData takes the bytes over: decode a copy, keep the download for next time.
      const buffer = await this.ctx!.decodeAudioData((await this.fetchSong(song)).slice(0));
      this.loaded.add(song.file);
      return buffer;
    } catch (e) {
      console.warn(`radio: ${song.file} failed to load`, e);
      return null;
    }
  }

  /** Starts a station wherever its broadcast is now (`tuned`: just tuned in, else it moved on). */
  private async play(st: Station, token: number, tuned: boolean): Promise<void> {
    const air = onAirAt(this.clock, st);
    if (!air) return;
    const buffer = await this.decode(air.song);
    if (!buffer || token !== this.tuning) return;
    // The download took a while: catch up, and if the song ended meanwhile, load the next one.
    const now = onAirAt(this.clock, st)!;
    if (now.index !== air.index) return this.play(st, token, tuned);
    this.start(st, now.index, buffer, now.position, this.ctx!.currentTime, token, true);
    this.nowPlaying = now.song;
    if (tuned) this.onTune(st, now.song);
    else this.onSong(st, now.song);
  }

  private start(st: Station, index: number, buffer: AudioBuffer, position: number, when: number, token: number, fadeIn: boolean): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    if (fadeIn) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + 0.25);
    }
    src.connect(gain).connect(this.gain);
    const offset = Math.min(Math.max(0, position), Math.max(0, buffer.duration - 0.05));
    src.start(when, offset);
    const playing = { src, gain };
    this.sources.push(playing);
    src.onended = () => {
      this.sources = this.sources.filter((p) => p !== playing);
      // Nothing queued after it (the next song failed to load, or its timer came late): pick
      // the broadcast up again wherever it is.
      if (token === this.tuning && this.sources.length === 0) void this.play(st, token, false);
    };
    const endsAt = when + buffer.duration - offset;
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = window.setTimeout(() => void this.queueNext(st, index, playing, endsAt, token), Math.max(0, endsAt - ctx.currentTime - PREFETCH) * 1000);
  }

  /** Decodes the station's next song and queues it to start the moment `current` ends. */
  private async queueNext(st: Station, index: number, current: Playing, endsAt: number, token: number): Promise<void> {
    const song = st.songs[(index + 1) % st.songs.length];
    const buffer = await this.decode(song);
    const ctx = this.ctx!;
    // Tuned away, or the song already ended and the broadcast was picked up again.
    if (!buffer || token !== this.tuning || !this.sources.includes(current) || ctx.currentTime >= endsAt) return;
    this.start(st, (index + 1) % st.songs.length, buffer, 0, endsAt, token, false);
    window.setTimeout(
      () => {
        if (token !== this.tuning) return;
        this.nowPlaying = song;
        this.onSong(st, song);
      },
      (endsAt - ctx.currentTime) * 1000,
    );
  }

  private stopSources(): void {
    clearTimeout(this.prefetchTimer);
    this.nowPlaying = null;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const { src, gain } of this.sources) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, 0.03);
      // A queued song that hasn't started yet simply never does.
      src.stop(now + 0.2);
    }
    this.sources = [];
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
