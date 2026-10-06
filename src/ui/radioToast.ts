import type { RadioSetting, Song } from '../core/radioStations';
import { RADIO_OFF, stationById } from '../core/radioStations';

/** A brief "now playing" card when the radio changes station, and a smaller one between songs. */
export class RadioToast {
  private readonly el: HTMLElement;
  private timer = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'radio-toast';
    this.el.setAttribute('role', 'status');
    root.appendChild(this.el);
  }

  /** A station tuned in (with the song it's broadcasting), or the radio off. */
  show(id: RadioSetting, song: Song | null = null): void {
    const st = stationById(id);
    this.el.innerHTML = st
      ? `<b>📻 ${st.name}</b><small>${st.tagline}</small>${song ? `<span>«${song.title}» · ${song.artist}</span>` : ''}`
      : `<b>📻 ${RADIO_OFF}</b>`;
    this.open(false, 3200);
  }

  /** The station moved on to its next song: just the song, small and brief. */
  showSong(song: Song): void {
    this.el.innerHTML = `<span>🎵 «${song.title}» · ${song.artist}</span>`;
    this.open(true, 2600);
  }

  private open(small: boolean, ms: number): void {
    this.el.classList.toggle('song', small);
    this.el.classList.add('on');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('on'), ms);
  }
}
