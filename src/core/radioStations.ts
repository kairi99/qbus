/**
 * The bus radio's stations (pure data and rules, no Web Audio: the menu and tests use it too).
 * Each station plays a playlist of original songs on a loop (`public/music/`, made by
 * `tools/music/`).
 */
export interface Song {
  /** File in public/music/. */
  file: string;
  title: string;
  artist: string;
  /**
   * Length in seconds (as rendered by tools/music/render.py): the station's schedule is built
   * from these, so every song's place in the broadcast is known without downloading it.
   */
  duration: number;
}

export interface Station {
  id: StationId;
  /** Dial name. */
  name: string;
  /** What the DJ says when you tune in. */
  tagline: string;
  /** Played in order, then from the top again. */
  songs: readonly Song[];
  /**
   * Seconds into the "broadcast" this station was when the session clock started: with the
   * clock, where the playlist is at any moment, so every station sounds live (and they don't all
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
    songs: [
      { file: 'sanjuanito.mp3', title: 'Guambrita del Panecillo', artist: 'Los Chullas del Ejido', duration: 113.8 },
      { file: 'sanjuanito2.mp3', title: 'Neblina en el Pichincha', artist: 'Los Rondadores del Itchimbía', duration: 100.4 },
    ],
    offset: 23,
  },
  {
    id: 'chicha',
    name: 'La Buseta 101.3',
    tagline: 'Chicha y cumbia pa’ la ruta',
    songs: [
      { file: 'chicha.mp3', title: 'Cumbia del Trole Perdido', artist: 'Chichero Andrade y su Combo Interparroquial', duration: 123.0 },
      { file: 'chicha2.mp3', title: 'La Psicodélica del Playón', artist: 'Juanito Guagua y los Ñaños Eléctricos', duration: 109.7 },
    ],
    offset: 31,
  },
  {
    id: 'reggaeton',
    name: 'Perreo FM 94.0',
    tagline: '¡Dale que vamos tarde, mi llave!',
    songs: [
      { file: 'reggaeton.mp3', title: 'Perreo en la Ecovía', artist: 'Lil Ñaño ft. DJ Mitad del Mundo', duration: 135.8 },
      { file: 'reggaeton2.mp3', title: 'Bajo la Lluvia de las Cuatro', artist: 'El Taita Flow ft. La Nena del Sur', duration: 120.8 },
    ],
    offset: 40,
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

/** What a station is playing at a moment: which song, how far into it, and how much is left. */
export interface OnAir {
  index: number;
  song: Song;
  position: number;
  remaining: number;
}

/**
 * Where a station's playlist is at `clock` seconds of the session: it never stopped playing.
 * The broadcast is the playlist's songs back to back, looped.
 */
export function onAirAt(clock: number, station: Pick<Station, 'offset' | 'songs'>): OnAir | null {
  const total = station.songs.reduce((t, s) => t + Math.max(0, s.duration), 0);
  if (!(total > 0)) return null;
  let p = (clock + station.offset) % total;
  if (p < 0) p += total;
  for (let i = 0; i < station.songs.length; i++) {
    const song = station.songs[i];
    if (p < song.duration || i === station.songs.length - 1) {
      const position = Math.min(p, song.duration);
      return { index: i, song, position, remaining: song.duration - position };
    }
    p -= Math.max(0, song.duration);
  }
  return null;
}
