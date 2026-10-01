/** Per-frame driving intent, independent of the device it came from. */
export interface DriveInput {
  /** -1 (full reverse/brake) .. 1 (full throttle) */
  throttle: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  handbrake: boolean;
  /** Nitro held (the tank decides whether it actually fires). */
  boost?: boolean;
}

export type Action = 'camera' | 'reset' | 'horn' | 'restart' | 'pause';

const KEY_ACTIONS: Record<string, Action> = { KeyC: 'camera', KeyR: 'reset', KeyH: 'horn', Enter: 'restart', NumpadEnter: 'restart', Escape: 'pause', KeyP: 'pause' };
// Standard gamepad mapping: Y toggles camera, Back resets, left stick press honks, Start pauses.
const PAD_ACTIONS: Record<number, Action> = { 3: 'camera', 8: 'reset', 10: 'horn', 9: 'pause' };

/** What the on-screen touch controls are holding (written by `ui/touchControls.ts`). */
export interface TouchState {
  gas: boolean;
  brake: boolean;
  /** -1 (left) .. 1 (right) */
  steer: number;
  handbrake: boolean;
  boost: boolean;
  horn: boolean;
  lookBack: boolean;
}

export class Input {
  private keys = new Set<string>();
  private pending: Action[] = [];
  private padPrev: boolean[] = [];
  readonly touch: TouchState = { gas: false, brake: false, steer: 0, handbrake: false, boost: false, horn: false, lookBack: false };

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (!e.repeat && KEY_ACTIONS[e.code]) this.pending.push(KEY_ACTIONS[e.code]);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
  }

  /** True while the look-back key/button is held (Q, or LB on a gamepad). */
  get lookBackHeld(): boolean {
    return this.keys.has('KeyQ') || this.touch.lookBack || !!this.pad()?.buttons[4]?.pressed;
  }

  /** True while the horn key/button is held. */
  get hornHeld(): boolean {
    return this.keys.has('KeyH') || this.touch.horn || !!this.pad()?.buttons[10]?.pressed;
  }

  drive(): DriveInput {
    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    let throttle = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
    let steer = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
    let handbrake = this.keys.has('Space');
    let boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    const t = this.touch;
    if (t.gas || t.brake) throttle = (t.gas ? 1 : 0) - (t.brake ? 1 : 0);
    if (t.steer) steer = t.steer;
    handbrake ||= t.handbrake;
    boost ||= t.boost;

    const pad = this.pad();
    if (pad) {
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const stick = pad.axes[0] ?? 0;
      if (Math.abs(rt - lt) > 0.05) throttle = rt - lt;
      if (Math.abs(stick) > 0.12) steer = stick;
      handbrake ||= !!pad.buttons[0]?.pressed;
      boost ||= !!pad.buttons[5]?.pressed;
    }
    return { throttle: clamp1(throttle), steer: clamp1(steer), handbrake, boost };
  }

  /** A one-shot action from somewhere other than the keyboard or pad (an on-screen button). */
  press(action: Action): void {
    this.pending.push(action);
  }

  /** Returns and clears one-shot actions triggered since the last call. */
  consumeActions(): Action[] {
    const pad = this.pad();
    if (pad) {
      for (const [i, action] of Object.entries(PAD_ACTIONS)) {
        const pressed = !!pad.buttons[+i]?.pressed;
        if (pressed && !this.padPrev[+i]) this.pending.push(action);
        this.padPrev[+i] = pressed;
      }
    }
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private pad(): Gamepad | null {
    return navigator.getGamepads?.().find((p) => p) ?? null;
  }
}

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
