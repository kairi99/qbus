import type { CameraMode } from '../camera/cameraRig';

/** What the player picked last time, and their preferences. Saved in localStorage. */
export interface Settings {
  bus: string;
  zone: string;
  /** Route id within the zone ('circuito' always exists). */
  route: string;
  camera: CameraMode;
  /** 0..1 */
  volume: number;
  /** Elevation exaggeration for real zones. */
  hills: number;
}

export const DEFAULTS: Settings = { bus: 'popular', zone: 'mariscal', route: 'circuito', camera: 'chase', volume: 0.8, hills: 1.3 };
export const HILLS_OPTIONS = [
  { value: 1, label: 'Reales' },
  { value: 1.3, label: 'Un poquito más' },
  { value: 2, label: 'Quito extremo' },
];

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'qbus';

export function loadSettings(store: KeyValueStore = localStorage): Settings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(store.getItem(KEY) ?? '{}');
    if (parsed && typeof parsed === 'object') raw = parsed;
  } catch {
    // Corrupt entry: start over from defaults.
  }
  const str = (k: keyof Settings) => (typeof raw[k] === 'string' && raw[k] ? (raw[k] as string) : (DEFAULTS[k] as string));
  const num = (k: 'volume' | 'hills', lo: number, hi: number) => {
    const v = raw[k];
    if (typeof v !== 'number' || !isFinite(v)) return DEFAULTS[k];
    return v < lo ? DEFAULTS[k] : Math.min(hi, v);
  };
  return {
    bus: str('bus'),
    zone: str('zone'),
    route: str('route'),
    camera: raw.camera === 'cockpit' || raw.camera === 'chase' ? raw.camera : DEFAULTS.camera,
    volume: num('volume', 0, 1),
    hills: num('hills', 0.5, 3),
  };
}

export function saveSettings(s: Settings, store: KeyValueStore = localStorage): void {
  store.setItem(KEY, JSON.stringify(s));
}
