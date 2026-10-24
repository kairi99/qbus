/**
 * Best race times per track, in localStorage `qbus.raceRecords` (separate from the shifts'
 * money records). Versioned; anything unreadable is dropped, never thrown.
 */
const KEY = 'qbus.raceRecords';
const VERSION = 1;

export interface RaceRecord {
  time: number;
  bus: string;
  date: string;
}

interface Stored {
  version: number;
  tracks: Record<string, RaceRecord>;
  /** Circuits: best single lap (s) per track, kept apart from the race times (absent in older saves = none). */
  laps?: Record<string, number>;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const store = (): Store | null => (typeof localStorage === 'undefined' ? null : localStorage);

function load(s: Store | null): Stored {
  try {
    const v = JSON.parse(s?.getItem(KEY) ?? 'null');
    if (v && v.version === VERSION && typeof v.tracks === 'object' && v.tracks) return v;
  } catch {
    // dropped
  }
  return { version: VERSION, tracks: {} };
}

/** The best time on a track, if any. */
export function bestRace(track: string, s: Store | null = store()): RaceRecord | null {
  const r = load(s).tracks[track];
  return r && Number.isFinite(r.time) ? r : null;
}

/** The best lap (s) on a circuit, if any. */
export function bestLapRecord(track: string, s: Store | null = store()): number | null {
  const l = load(s).laps?.[track];
  return typeof l === 'number' && Number.isFinite(l) && l > 0 ? l : null;
}

/** Saves a lap time; true if it's the new best lap of the track. */
export function recordLap(track: string, time: number, s: Store | null = store()): boolean {
  if (!Number.isFinite(time) || time <= 0) return false;
  const all = load(s);
  const old = all.laps?.[track];
  if (typeof old === 'number' && old <= time) return false;
  all.laps = { ...all.laps, [track]: time };
  try {
    s?.setItem(KEY, JSON.stringify(all));
  } catch {
    // full or blocked: the record just isn't kept
  }
  return true;
}

/** Saves a finish; true if it's the new best. */
export function recordRace(track: string, time: number, bus: string, s: Store | null = store()): boolean {
  const all = load(s);
  const old = all.tracks[track];
  if (old && old.time <= time) return false;
  all.tracks[track] = { time, bus, date: new Date().toISOString().slice(0, 10) };
  try {
    s?.setItem(KEY, JSON.stringify(all));
  } catch {
    // full or blocked: the record just isn't kept
  }
  return true;
}
