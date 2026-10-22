/** Pure: the horn over the wire. Snapshots go out at 15 Hz, so a tap is latched and a short blast is stretched. */

/** A remote horn sounds at least this long (s) once heard, so a tap shows up as a honk, not a click. */
export const HORN_MIN = 0.25;

/** Sender: "honked since the last snapshot", so a tap between two snapshots still goes out. */
export class HornLatch {
  private pressed = false;

  /** Every physics step with whether the horn is held. */
  feed(held: boolean): void {
    if (held) this.pressed = true;
  }

  /** At each snapshot: the horn's state for it (and the latch starts over). */
  take(): boolean {
    const was = this.pressed;
    this.pressed = false;
    return was;
  }
}

/** Receiver: the remote horn's sound state from the snapshots' flag, lasting `HORN_MIN` at least. */
export class HornHold {
  private on = false;
  private left = 0;

  step(flag: boolean, dt: number): boolean {
    if (flag && !this.on) this.left = HORN_MIN;
    this.on = flag;
    this.left -= dt;
    return flag || this.left > 0;
  }

  reset(): void {
    this.on = false;
    this.left = 0;
  }
}
