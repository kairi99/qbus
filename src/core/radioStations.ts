/**
 * The bus radio's stations (pure data and rules, no Web Audio: the menu and tests use it too).
 * Each station plays one original song on a loop (`public/music/`, made by `tools/music/`).
 */
export interface Station {
  id: StationId;
  /** Dial name. */
  name: string;
  /** What the DJ says when you tune in. */
  tagline: string;
  /** File in public/music/. */
  file: string;
  song: string;
  artist: string;
  /**
   * Seconds into the "broadcast" this station was when the session clock started: with the
   * clock, where the song is at any moment, so every station sounds live (and they don't all
   * start their songs together).
   */
  offset: number;
}

export type StationId = 'sanjuanito' | 'chicha' | 'reggaeton';
export type RadioSetting = StationId | 'off';

export const STATIONS: readonly Station[] = [
  {
    id: 'sanjuanito',
    name: 'Radio Sanjuanito 98.5',
    tagline: 'Música nacional, full sentimiento',
    file: 'sanjuanito.mp3',
    song: 'Guambrita del Panecillo',
    artist: 'Los Chullas del Ejido',
    offset: 23,
  },
  {
    id: 'chicha',
    name: 'La Buseta 101.3',
    tagline: 'Chicha y cumbia pa’ la ruta',
    file: 'chicha.mp3',
    song: 'Cumbia del Trole Perdido',
    artist: 'Chichero Andrade y su Combo Interparroquial',
    offset: 71,
  },
  {
    id: 'reggaeton',
    name: 'Perreo FM 94.0',
    tagline: '¡Dale que vamos tarde, mi llave!',
    file: 'reggaeton.mp3',
    song: 'Perreo en la Ecovía',
    artist: 'Lil Ñaño ft. DJ Mitad del Mundo',
    offset: 112,
  },
];

export const RADIO_OFF = 'Apagado';

export function stationById(id: RadioSetting): Station | null {
  return STATIONS.find((s) => s.id === id) ?? null;
}

export function parseRadio(v: unknown): RadioSetting | null {
  return v === 'off' || STATIONS.some((s) => s.id === v) ? (v as RadioSetting) : null;
}

/** The dial order: off, then each station, then back to off. */
export function nextStation(current: RadioSetting, step: 1 | -1 = 1): RadioSetting {
  const dial: RadioSetting[] = ['off', ...STATIONS.map((s) => s.id)];
  const i = Math.max(0, dial.indexOf(current));
  return dial[(i + step + dial.length) % dial.length];
}

/** Where a station's song is at `clock` seconds of the session: it never stopped playing. */
export function livePosition(clock: number, station: Pick<Station, 'offset'>, duration: number): number {
  if (!(duration > 0)) return 0;
  const p = (clock + station.offset) % duration;
  return p < 0 ? p + duration : p;
}
