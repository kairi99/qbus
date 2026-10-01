import type { CameraMode } from '../camera/cameraRig';

/** HUD: speedometer, current street, camera mode, control hints and a "flipped" warning. */
export class Hud {
  private speed: HTMLElement;
  private mode: HTMLElement;
  private flipped: HTMLElement;
  private street: HTMLElement;
  private fps: HTMLElement;
  private frameMs = 16;

  constructor(root: HTMLElement, attribution?: string) {
    root.innerHTML = `
      <div class="hud-speed"><span id="hud-kmh">0</span><small>km/h</small></div>
      <div class="hud-street" id="hud-street"></div>
      <div class="hud-mode"><span id="hud-mode"></span><br><span id="hud-fps"></span></div>
      <div class="hud-help">
        <b>W/S</b> acelerar/frenar · <b>A/D</b> girar · <b>Espacio</b> freno de mano · <b>Shift</b> nitro<br>
        <b>C</b> cámara · <b>Q</b> mirar atrás · <b>H</b> pito · <b>R</b> volver a la calle
      </div>
      ${attribution ? `<div class="hud-credit">${attribution}</div>` : ''}
      <div class="hud-flipped" id="hud-flipped">¡Ñaño, te viraste! <span class="keys-only">Presiona <b>R</b></span><span class="touch-only">Toca <b>↺</b></span></div>`;
    this.speed = root.querySelector('#hud-kmh')!;
    this.mode = root.querySelector('#hud-mode')!;
    this.flipped = root.querySelector('#hud-flipped')!;
    this.street = root.querySelector('#hud-street')!;
    this.fps = root.querySelector('#hud-fps')!;
  }

  update(dt: number, speedMs: number, mode: CameraMode, isFlipped: boolean, street: string): void {
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;
    this.fps.textContent = `${Math.round(1000 / this.frameMs)} fps`;
    // Keep the last street while crossing sidewalks/intersections edges.
    if (street) this.street.textContent = street;
    this.speed.textContent = String(Math.round(Math.abs(speedMs) * 3.6));
    this.mode.textContent = mode === 'chase' ? 'Cámara: tercera persona' : 'Cámara: conductor';
    this.flipped.style.display = isFlipped ? 'block' : 'none';
  }
}
