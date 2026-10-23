/**
 * Who the player watches after finishing a race, pure: one racer at a time, stepping through
 * those still out on the road by place.
 */

export interface Watchable {
  racer: number;
  place: number;
  /** Still out: not finished past its photo window, not retired, bus exists. */
  racing: boolean;
}

export class SpectatorCycle {
  private current: number | null = null;
  private list: Watchable[] = [];

  /** Racer being watched, or null (nobody left: open the full results). */
  get target(): number | null {
    return this.current;
  }

  /**
   * Each frame: who may be watched. Keeps the current target while it is still racing, else
   * moves to the next by place (nearest place below first, then above).
   */
  update(list: readonly Watchable[]): void {
    // Plain loops over a reused array (insertion sort by place): no allocation per frame.
    const out = this.list;
    out.length = 0;
    let was: Watchable | null = null;
    let kept = false;
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (w.racer === this.current) was = w;
      if (!w.racing) continue;
      if (w.racer === this.current) kept = true;
      let j = out.length;
      out.push(w);
      while (j > 0 && out[j - 1].place > w.place) (out[j] = out[j - 1]), j--;
      out[j] = w;
    }
    if (kept) return;
    if (out.length === 0) {
      this.current = null;
      return;
    }
    if (!was) {
      this.current = out[0].racer;
      return;
    }
    let next = out[out.length - 1];
    for (let i = 0; i < out.length; i++)
      if (out[i].place > was.place) {
        next = out[i];
        break;
      }
    this.current = next.racer;
  }

  /** ←/→, LB/RB, touch arrows: step through the racing ones ordered by place, wrapping. */
  step(dir: 1 | -1): void {
    const n = this.list.length;
    if (n === 0) return;
    const at = this.list.findIndex((w) => w.racer === this.current);
    this.current = this.list[at < 0 ? (dir > 0 ? 0 : n - 1) : (at + dir + n) % n].racer;
  }

  reset(): void {
    this.current = null;
    this.list = [];
  }
}
