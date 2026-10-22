import type { CameraMode } from '../camera/cameraRig';
import { DEFAULT_HILLS } from '../world/loadCity';
import { type TimeOfDay, parseTimeOfDay } from '../world/sky';
import { type RadioSetting, parseRadio } from '../core/radioStations';
import { aliasRouteId } from '../world/osm/operators';
import { type RainSetting, parseRainSetting } from '../gameplay/weather';
import { cleanName } from '../net/protocol';

/** How a race is set up: the track, how many rivals, what they drive, how well, and traffic. */
export interface RaceSetup {
  /** Track zone id. */
  track: string;
  /** 1..3 */
  rivals: number;
  /** 'mixed' (each a different vehicle), 'same' (the player's) or a vehicle id. */
  rivalBus: string;
  skill: 'easy' | 'normal' | 'hard';
  traffic: boolean;
  /** Landslides on the tracks that have them. */
  slides: boolean;
}

/** What the player picked last time, and their preferences. Saved in localStorage. */
export interface Settings {
  /** A shift on a route, free roam, or a race on a mountain road. */
  mode: 'route' | 'free' | 'race';
  /** Vehicle id (in route mode always a bus). */
  bus: string;
  zone: string;
  /** Route id within the zone ('circuito' always exists). */
  route: string;
  camera: CameraMode;
  /** 0..1 */
  volume: number;
  /** Elevation exaggeration for real zones. */
  hills: number;
  /** Light the city is played in. */
  timeOfDay: TimeOfDay;
  /** Radio music, 0..1 (under the general volume). */
  musicVolume: number;
  /** Station the bus radio is on when a game starts (the last one tuned in). */
  radio: RadioSetting;
  /** Show the how-to-play card when a shift or free roam starts. */
  tutorial: boolean;
  /** Rain: showers at random moments, never, or raining from the start. */
  rain: RainSetting;
  race: RaceSetup;
  /** Online races: the name shown to the others ('' until the player types one). */
  online: { name: string };
}

export const RACE_DEFAULTS: RaceSetup = { track: 'papallacta', rivals: 3, rivalBus: 'mixed', skill: 'normal', traffic: false, slides: true };
export const ONLINE_DEFAULTS: Settings['online'] = { name: '' };

export const DEFAULTS: Settings = { mode: 'route', bus: 'popular', zone: 'mariscal', route: 'circuito', camera: 'chase', volume: 0.8, hills: DEFAULT_HILLS, timeOfDay: 'day', musicVolume: 0.5, radio: 'sanjuanito', tutorial: true, rain: 'random', race: RACE_DEFAULTS, online: ONLINE_DEFAULTS };
export const HILLS_OPTIONS = [
  { value: 1, label: 'Reales' },
  { value: 1.3, label: 'Un poquito más' },
  { value: 2, label: 'Quito extremo' },
];
export const TIME_OPTIONS: { value: TimeOfDay; label: string }[] = [
  { value: 'day', label: 'Día' },
  { value: 'sunset', label: 'Atardecer' },
  { value: 'night', label: 'Noche' },
];

export const RAIN_OPTIONS: { value: RainSetting; label: string }[] = [
  { value: 'random', label: 'Cuando le dé la gana' },
  { value: 'always', label: 'Siempre' },
  { value: 'off', label: 'Nunca' },
];

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'qbus';
/**
 * Bumped when a default changes in a way saved settings must follow. Version 2: hills default
 * to "Reales" (1). Before, every save stored the old default (1.3) whether or not the player
 * picked it, so a 1.3 saved under version 1 is taken as "never chosen".
 * Version 3: `online` (nothing to migrate; the hills rule above still applies to saves older than 2).
 */
const VERSION = 3;

export function loadSettings(store: KeyValueStore = localStorage): Settings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(store.getItem(KEY) ?? '{}');
    if (parsed && typeof parsed === 'object') raw = parsed;
  } catch {
    // Corrupt entry: start over from defaults.
  }
  const str = (k: keyof Settings) => (typeof raw[k] === 'string' && raw[k] ? (raw[k] as string) : (DEFAULTS[k] as string));
  const num = (k: 'volume' | 'hills' | 'musicVolume', lo: number, hi: number) => {
    const v = raw[k];
    if (typeof v !== 'number' || !isFinite(v)) return DEFAULTS[k];
    return v < lo ? DEFAULTS[k] : Math.min(hi, v);
  };
  return {
    mode: raw.mode === 'free' || raw.mode === 'race' ? raw.mode : 'route',
    bus: str('bus'),
    zone: str('zone'),
    route: aliasRouteId(str('route')),
    camera: raw.camera === 'cockpit' || raw.camera === 'chase' ? raw.camera : DEFAULTS.camera,
    volume: num('volume', 0, 1),
    hills: (typeof raw.v !== 'number' || raw.v < 2) && raw.hills === 1.3 ? DEFAULTS.hills : num('hills', 0.5, 3),
    timeOfDay: parseTimeOfDay(raw.timeOfDay) ?? DEFAULTS.timeOfDay,
    musicVolume: num('musicVolume', 0, 1),
    radio: parseRadio(raw.radio) ?? DEFAULTS.radio,
    tutorial: raw.tutorial !== false,
    rain: parseRainSetting(raw.rain) ?? DEFAULTS.rain,
    race: parseRace(raw.race),
    online: parseOnline(raw.online),
  };
}

function parseOnline(v: unknown): Settings['online'] {
  const name = v && typeof v === 'object' ? (v as Record<string, unknown>).name : undefined;
  return { name: typeof name === 'string' && name.trim() ? cleanName(name) : ONLINE_DEFAULTS.name };
}

function parseRace(v: unknown): RaceSetup {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const d = RACE_DEFAULTS;
  return {
    track: typeof r.track === 'string' && r.track ? r.track : d.track,
    rivals: typeof r.rivals === 'number' && r.rivals >= 1 && r.rivals <= 3 ? Math.round(r.rivals) : d.rivals,
    rivalBus: typeof r.rivalBus === 'string' && r.rivalBus ? r.rivalBus : d.rivalBus,
    skill: r.skill === 'easy' || r.skill === 'hard' || r.skill === 'normal' ? r.skill : d.skill,
    traffic: typeof r.traffic === 'boolean' ? r.traffic : d.traffic,
    // Added later, no settings version bump: a save without it reads as the default.
    slides: typeof r.slides === 'boolean' ? r.slides : d.slides,
  };
}

export function saveSettings(s: Settings, store: KeyValueStore = localStorage): void {
  store.setItem(KEY, JSON.stringify({ ...s, v: VERSION }));
}
