/** Server clock estimate for the online races, pure: offset between the server's Date.now and the local performance.now. */

/** Most the offset moves per sample (ms), so the estimate never jerks. */
export const MAX_SLEW = 5;
/** Samples kept; the one with the smallest rtt gives the target. */
export const WINDOW = 8;
/** A target this far off the offset (ms) is a resync (sleep, clock change): jump. */
const JUMP = 1000;
const MAX_RTT = 5000;

export class ClockSync {
  private rtts: number[] = [];
  private offsets: number[] = [];
  private off = 0;
  private n = 0;
  private best = Infinity;

  /** True after the first valid sample. */
  get ready(): boolean {
    return this.n > 0;
  }

  /** Smallest round trip (ms) in the window, Infinity before any sample. */
  get rtt(): number {
    return this.best;
  }

  /** One ping/pong: `c` client send time (performance.now), `s` server Date.now in the pong, `now` receive time. */
  sample(c: number, s: number, now: number): void {
    const rtt = now - c;
    if (!(rtt >= 0 && rtt <= MAX_RTT) || !Number.isFinite(s)) return;
    this.rtts.push(rtt);
    this.offsets.push(s + rtt / 2 - now);
    if (this.rtts.length > WINDOW) {
      this.rtts.shift();
      this.offsets.shift();
    }
    let bi = 0;
    for (let i = 1; i < this.rtts.length; i++) if (this.rtts[i] < this.rtts[bi]) bi = i;
    this.best = this.rtts[bi];
    const target = this.offsets[bi];
    if (this.n === 0) this.off = target;
    else {
      const d = target - this.off;
      if (Math.abs(d) > JUMP) this.off = target;
      else this.off += Math.max(-MAX_SLEW, Math.min(MAX_SLEW, d));
    }
    this.n++;
  }

  /** Server time (Date.now ms) at local performance time `perfNow`. */
  serverNow(perfNow: number): number {
    return perfNow + this.off;
  }

  /** Local performance time of a server time. */
  toLocal(serverMs: number): number {
    return serverMs - this.off;
  }
}
