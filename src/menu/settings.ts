import type { CameraMode } from '../camera/cameraRig';
import { DEFAULT_HILLS } from '../world/loadCity';
import { type TimeOfDay, parseTimeOfDay } from '../world/sky';
import { type RadioSetting, parseRadio } from '../core/radioStations';

/** What the player picked last time, and their preferences. Saved in localStorage. */
export interface Settings {
  /** A shift on a route, or free roam. */
  mode: 'route' | 'free';
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
}

export const DEFAULTS: Settings = { mode: 'route', bus: 'popular', zone: 'mariscal', route: 'circuito', camera: 'chase', volume: 0.8, hills: DEFAULT_HILLS, timeOfDay: 'day', musicVolume: 0.5, radio: 'sanjuanito' };
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

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'qbus';
/**
 * Bumped when a default changes in a way saved settings must follow. Version 2: hills default
 * to "Reales" (1). Before, every save stored the old default (1.3) whether or not the player
 * picked it, so a 1.3 saved under version 1 is taken as "never chosen".
 */
const VERSION = 2;

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
    mode: raw.mode === 'free' ? 'free' : 'route',
    bus: str('bus'),
    zone: str('zone'),
    route: str('route'),
    camera: raw.camera === 'cockpit' || raw.camera === 'chase' ? raw.camera : DEFAULTS.camera,
    volume: num('volume', 0, 1),
    hills: raw.v !== VERSION && raw.hills === 1.3 ? DEFAULTS.hills : num('hills', 0.5, 3),
    timeOfDay: parseTimeOfDay(raw.timeOfDay) ?? DEFAULTS.timeOfDay,
    musicVolume: num('musicVolume', 0, 1),
    radio: parseRadio(raw.radio) ?? DEFAULTS.radio,
  };
}

export function saveSettings(s: Settings, store: KeyValueStore = localStorage): void {
  store.setItem(KEY, JSON.stringify({ ...s, v: VERSION }));
}
