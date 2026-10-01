import type { Action, Input, TouchState } from '../core/input';

/** Phones and tablets: the main pointer is a finger (a touchscreen laptop still has its mouse). */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}

/** Thumb travel (px) from where it landed to full lock. */
const STEER_RANGE = 70;

type Hold = Exclude<keyof TouchState, 'steer'>;

/**
 * On-screen driving controls for touch screens, feeding `Input.touch`: the left thumb steers
 * (drag sideways from wherever it lands), the right one works the pedals, nitro and handbrake;
 * small buttons up top for the camera, horn, looking back, getting back on the street and pausing.
 * Every control tracks its own finger, so steering, gas and nitro work at the same time.
 */
export class TouchControls {
  constructor(root: HTMLElement, input: Input) {
    document.body.classList.add('touch');
    const el = document.createElement('div');
    el.className = 'tc';
    el.innerHTML = `
      <div class="tc-steer" data-steer><div class="tc-wheel"><div class="tc-knob"></div></div></div>
      <div class="tc-top">
        <button class="tc-small" data-tap="pause" aria-label="Pausa">❚❚</button>
        <button class="tc-small" data-tap="camera" aria-label="Cámara">🎥</button>
        <button class="tc-small" data-hold="lookBack" aria-label="Mirar atrás">👀</button>
        <button class="tc-small" data-hold="horn" data-tap="horn" aria-label="Pito">📯</button>
        <button class="tc-small" data-tap="reset" aria-label="Volver a la calle">↺</button>
      </div>
      <button class="tc-btn tc-hand" data-hold="handbrake">Mano</button>
      <button class="tc-btn tc-nitro" data-hold="boost">Nitro</button>
      <button class="tc-btn tc-brake" data-hold="brake">Freno</button>
      <button class="tc-btn tc-gas" data-hold="gas">Dale</button>
      <div class="tc-rotate">Gira el celular para manejar 📱↻</div>`;
    root.appendChild(el);

    // Full screen on the first touch (browsers only allow it from a gesture), sideways if the
    // phone lets a page lock its orientation.
    const goFull = () => {
      el.removeEventListener('pointerdown', goFull);
      const doc = document.documentElement;
      if (document.fullscreenElement || !doc.requestFullscreen) return;
      doc
        .requestFullscreen({ navigationUI: 'hide' })
        .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
        .catch(() => {});
    };
    el.addEventListener('pointerdown', goFull);

    el.querySelectorAll<HTMLElement>('[data-hold], [data-tap]').forEach((b) => {
      const hold = b.dataset.hold as Hold | undefined;
      const tap = b.dataset.tap as Action | undefined;
      const release = () => {
        b.classList.remove('on');
        if (hold) input.touch[hold] = false;
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.classList.add('on');
        if (hold) input.touch[hold] = true;
        if (tap) input.press(tap);
        capture(b, e.pointerId);
      });
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
      b.addEventListener('lostpointercapture', release);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    const zone = el.querySelector<HTMLElement>('[data-steer]')!;
    const wheel = el.querySelector<HTMLElement>('.tc-wheel')!;
    const knob = el.querySelector<HTMLElement>('.tc-knob')!;
    let finger: number | null = null;
    let startX = 0;
    zone.addEventListener('pointerdown', (e) => {
      if (finger !== null) return;
      e.preventDefault();
      finger = e.pointerId;
      startX = e.clientX;
      capture(zone, e.pointerId);
      const r = zone.getBoundingClientRect();
      // The wheel jumps under the thumb, so steering is relative to where it landed.
      wheel.style.left = `${e.clientX - r.left}px`;
      wheel.style.top = `${e.clientY - r.top}px`;
      wheel.classList.add('on');
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== finger) return;
      const steer = Math.max(-1, Math.min(1, (e.clientX - startX) / STEER_RANGE));
      input.touch.steer = steer;
      knob.style.transform = `translateX(${steer * STEER_RANGE}px)`;
    });
    const letGo = (e: PointerEvent) => {
      if (e.pointerId !== finger) return;
      finger = null;
      input.touch.steer = 0;
      knob.style.transform = '';
      wheel.classList.remove('on');
    };
    zone.addEventListener('pointerup', letGo);
    zone.addEventListener('pointercancel', letGo);
    zone.addEventListener('lostpointercapture', letGo);
  }
}

/** Keep getting a finger's moves and its lift even once it slides off the control. */
function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // The pointer already ended (or was never a live one): nothing to follow.
  }
}
