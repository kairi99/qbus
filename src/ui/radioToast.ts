import type { RadioSetting } from '../core/radioStations';
import { RADIO_OFF, stationById } from '../core/radioStations';

/** A brief "now playing" card when the radio changes station. */
export class RadioToast {
  private readonly el: HTMLElement;
  private timer = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'radio-toast';
    this.el.setAttribute('role', 'status');
    root.appendChild(this.el);
  }

  show(id: RadioSetting): void {
    const st = stationById(id);
    this.el.innerHTML = st
      ? `<b>📻 ${st.name}</b><small>${st.tagline}</small><span>«${st.song}» · ${st.artist}</span>`
      : `<b>📻 ${RADIO_OFF}</b>`;
    this.el.classList.add('on');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('on'), 3200);
  }
}
