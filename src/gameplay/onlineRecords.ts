/**
 * This player's best finish per track in online races, in localStorage `qbus.onlineRecords`
 * (apart from the solo `qbus.raceRecords`: the field and the rules differ). Versioned; anything
 * unreadable is dropped, never thrown. Only a finished race with a real time counts.
 */
const KEY = 'qbus.onlineRecords';
const VERSION = 1;

export interface OnlineRecord {
  /** Seconds. */
  time: number;
  /** The vehicle's name. */
  bus: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Place at the line (updated when the room's final results arrive). */
  place: number;
  /** Racers on the grid. */
  racers: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const valid = (r: any): r is OnlineRecord =>
  !!r && Number.isFinite(r.time) && r.time > 0 && typeof r.bus === 'string' && typeof r.date === 'string' && Number.isInteger(r.place) && r.place >= 1 && Number.isInteger(r.racers) && r.racers >= r.place;

/** Best lap per circuit (s), apart from the race records: a save without it has none. */
function loadLaps(s: Store | null): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const v = JSON.parse(s?.getItem(KEY) ?? 'null');
    if (v && v.version === VERSION && v.laps && typeof v.laps === 'object') for (const [k, l] of Object.entries(v.laps)) if (typeof l === 'number' && Number.isFinite(l) && l > 0) out[k] = l;
  } catch {
    // dropped
  }
  return out;
}

function load(s: Store | null): Record<string, OnlineRecord> {
  const out: Record<string, OnlineRecord> = {};
  try {
    const v = JSON.parse(s?.getItem(KEY) ?? 'null');
    if (v && v.version === VERSION && v.tracks && typeof v.tracks === 'object') for (const [k, r] of Object.entries(v.tracks)) if (valid(r)) out[k] = r;
  } catch {
    // dropped
  }
  return out;
}

function save(s: Store | null, tracks: Record<string, OnlineRecord>, laps: Record<string, number> = loadLaps(s)): void {
  try {
    s?.setItem(KEY, JSON.stringify({ version: VERSION, tracks, laps }));
  } catch {
    // full or blocked: the record just isn't kept
  }
}

/** The best online time on a track, if any. */
export function bestOnline(track: string, s: Store | null = store()): OnlineRecord | null {
  return load(s)[track] ?? null;
}

/** The best online lap (s) on a circuit, if any. */
export function bestOnlineLap(track: string, s: Store | null = store()): number | null {
  return loadLaps(s)[track] ?? null;
}

/** Saves a lap time; true if it's the new best online lap of the track. */
export function recordOnlineLap(track: string, time: number, s: Store | null = store()): boolean {
  if (!Number.isFinite(time) || time <= 0) return false;
  const laps = loadLaps(s);
  if (laps[track] !== undefined && laps[track] <= time) return false;
  laps[track] = time;
  save(s, load(s), laps);
  return true;
}

/** Saves a finish; true if it's the new best. Not a real time (NaN, zero, negative) or a place out of the grid: nothing kept. */
export function recordOnline(track: string, r: Omit<OnlineRecord, 'date'>, s: Store | null = store(), date: string = new Date().toISOString().slice(0, 10)): boolean {
  const rec = { ...r, date };
  if (!valid(rec)) return false;
  const all = load(s);
  const old = all[track];
  if (old && old.time <= r.time) return false;
  all[track] = rec;
  save(s, all);
  return true;
}

/** The room's final results settled the place of the record just made (same time): keep that. */
export function settleOnlinePlace(track: string, time: number, place: number, s: Store | null = store()): void {
  const all = load(s);
  const r = all[track];
  if (!r || r.time !== time || place < 1 || place > r.racers || r.place === place) return;
  r.place = place;
  save(s, all);
}
