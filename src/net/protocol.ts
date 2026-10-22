/** Wire protocol of the online races, pure: shared by the game and the room server (relative import). */
export const PROTO = 1;
export const MAX_SEATS = 4;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
const NAME_MAX = 16;
const ID_MAX = 24;
const NAME_FALLBACK = 'Ñaño';

/** A fresh room code. */
export function makeCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.min(CODE_ALPHABET.length - 1, Math.floor(rand() * CODE_ALPHABET.length))];
  return s;
}

/** Whether `s` is a code exactly as made (uppercase). */
export function isCode(s: string): boolean {
  if (typeof s !== 'string' || s.length !== CODE_LENGTH) return false;
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return false;
  return true;
}

/** What a player typed, trimmed and uppercased: the code, or null when it can't be one. */
export function normalizeCode(s: string): string | null {
  if (typeof s !== 'string') return null;
  const c = s.trim().toUpperCase();
  return isCode(c) ? c : null;
}

/** A player name: control characters out, spaces collapsed, 16 characters at most, 'Ñaño' when nothing is left. */
export function cleanName(s: string): string {
  const t = String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return t || NAME_FALLBACK;
}

export type RaceSkillId = 'easy' | 'normal' | 'hard';

export interface Seat {
  id: number;
  name: string;
  vehicle: string;
  ready: boolean;
  host: boolean;
  online: boolean;
}

export interface RoomSettings {
  track: string;
  /** AI rivals, 0..3 (humans + AI fit in MAX_SEATS). */
  ai: number;
  skill: RaceSkillId;
  /** `mixed`, `same` or a vehicle id: what the AI drive. */
  rivalBus: string;
}

export const DEFAULT_ROOM_SETTINGS: RoomSettings = { track: 'papallacta', ai: 2, skill: 'normal', rivalBus: 'mixed' };

export type GridEntry = { kind: 'human'; seat: number; vehicle: string } | { kind: 'ai'; idx: number; vehicle: string; crew: number };

export type RoomPhase = 'lobby' | 'loading' | 'racing' | 'results';

/** Who a car or a result belongs to: a human seat or an AI rival (its grid index). */
export type Racer = { seat: number } | { ai: number };

export interface CarState {
  who: Racer;
  /** Meters along the track. */
  s: number;
  /** Position, quaternion, velocity. */
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  /** Rear sections of an articulated vehicle: position + quaternion each. */
  rears?: [number, number, number, number, number, number, number][];
  steer: number;
  speed: number;
  thr: number;
  boost: 0 | 1;
  /** 1 while the vehicle is a ghost after a respawn (see-through, nothing to hit); absent otherwise. */
  g?: 1;
}

export interface ResultRow {
  who: Racer;
  /** Seconds, null when it hasn't finished (retired). */
  time: number | null;
}

export type C2S =
  | { t: 'hello'; v: number; name: string; vehicle: string; token?: string }
  | { t: 'set'; settings: RoomSettings }
  | { t: 'me'; vehicle?: string; ready?: boolean }
  | { t: 'start'; grid: GridEntry[]; seed: number }
  | { t: 'loaded' }
  | { t: 'st'; at: number; cars: CarState[] }
  | { t: 'fin'; who: Racer; time: number }
  | { t: 'ping'; c: number }
  | { t: 'leave' };

export type ErrorCode = 'full' | 'racing' | 'version' | 'nohost' | 'unknown' | 'notready' | 'bad';

export type S2C =
  | { t: 'welcome'; v: number; you: number; token: string; code: string }
  | { t: 'room'; phase: RoomPhase; seats: Seat[]; settings: RoomSettings }
  | { t: 'go'; grid: GridEntry[]; seed: number; goAt: number }
  | { t: 'st'; from: number; at: number; cars: CarState[] }
  | { t: 'result'; rows: ResultRow[]; final: boolean }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; code: ErrorCode };

export function racerKey(r: Racer): string {
  return 'seat' in r ? `s${r.seat}` : `a${r.ai}`;
}

export function sameRacer(a: Racer, b: Racer): boolean {
  return racerKey(a) === racerKey(b);
}

const C2S_TAGS = ['hello', 'set', 'me', 'start', 'loaded', 'st', 'fin', 'ping', 'leave'];
const S2C_TAGS = ['welcome', 'room', 'go', 'st', 'result', 'pong', 'error'];
const ERRORS = ['full', 'racing', 'version', 'nohost', 'unknown', 'notready', 'bad'];
const PHASES = ['lobby', 'loading', 'racing', 'results'];
const SKILLS = ['easy', 'normal', 'hard'];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => isNum(x) && Number.isInteger(x);
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= ID_MAX;

export function isRacer(x: unknown): x is Racer {
  return isObj(x) && (isInt(x.seat) || isInt(x.ai)) && x.seat !== x.ai;
}

/** A valid RoomSettings (copied), or null. */
export function validSettings(x: unknown): RoomSettings | null {
  if (!isObj(x) || !isId(x.track) || !isInt(x.ai) || x.ai < 0 || x.ai > MAX_SEATS - 1 || !SKILLS.includes(x.skill as string) || !isId(x.rivalBus)) return null;
  return { track: x.track, ai: x.ai, skill: x.skill as RaceSkillId, rivalBus: x.rivalBus };
}

function validGrid(x: unknown): x is GridEntry[] {
  if (!Array.isArray(x) || x.length < 1 || x.length > 2 * MAX_SEATS) return false;
  return x.every((e) => isObj(e) && isId(e.vehicle) && (e.kind === 'human' ? isInt(e.seat) : e.kind === 'ai' && isInt(e.idx) && isInt(e.crew)));
}

const nums = (x: unknown, n: number): boolean => Array.isArray(x) && x.length === n && x.every(isNum);

/** Every field a remote bus is driven from is finite (a NaN would reach the physics), and no more than a train's sections. */
function validCar(c: unknown): c is CarState {
  if (!isObj(c) || !isRacer(c.who) || !isNum(c.s) || !nums(c.p, 3) || !nums(c.q, 4) || !nums(c.v, 3)) return false;
  if (!isNum(c.steer) || !isNum(c.speed) || !isNum(c.thr) || (c.boost !== 0 && c.boost !== 1)) return false;
  if (c.g !== undefined && c.g !== 0 && c.g !== 1) return false;
  return c.rears === undefined || (Array.isArray(c.rears) && c.rears.length <= 6 && c.rears.every((r) => nums(r, 7)));
}

const validCars = (x: unknown): boolean => Array.isArray(x) && x.length <= 8 && x.every(validCar);

/** A car with only the protocol's fields (a client can't smuggle extra data through the relay). */
export function cleanCar(c: CarState): CarState {
  const out: CarState = { who: 'seat' in c.who ? { seat: c.who.seat } : { ai: c.who.ai }, s: c.s, p: c.p, q: c.q, v: c.v, steer: c.steer, speed: c.speed, thr: c.thr, boost: c.boost };
  if (c.rears) out.rears = c.rears;
  if (c.g) out.g = 1;
  return out;
}

/** Parses a client message; null when it isn't one (bad JSON, unknown tag, wrong field types, oversize strings). */
export function parseC2S(raw: string): C2S | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || typeof m.t !== 'string' || !C2S_TAGS.includes(m.t)) return null;
  switch (m.t) {
    case 'hello': {
      if (!isInt(m.v) || typeof m.name !== 'string' || m.name.trim().length > NAME_MAX || m.name.length > 4 * NAME_MAX || !isId(m.vehicle)) return null;
      if (m.token !== undefined && (typeof m.token !== 'string' || m.token.length > 64)) return null;
      const out: C2S = { t: 'hello', v: m.v, name: cleanName(m.name), vehicle: m.vehicle };
      if (m.token) out.token = m.token;
      return out;
    }
    case 'set': {
      const settings = validSettings(m.settings);
      return settings ? { t: 'set', settings } : null;
    }
    case 'me':
      if ((m.vehicle !== undefined && !isId(m.vehicle)) || (m.ready !== undefined && typeof m.ready !== 'boolean')) return null;
      return { t: 'me', ...(m.vehicle !== undefined ? { vehicle: m.vehicle as string } : {}), ...(m.ready !== undefined ? { ready: m.ready as boolean } : {}) };
    case 'start':
      return validGrid(m.grid) && isInt(m.seed) ? { t: 'start', grid: m.grid, seed: m.seed } : null;
    case 'loaded':
      return { t: 'loaded' };
    case 'st':
      return isNum(m.at) && validCars(m.cars) ? { t: 'st', at: m.at, cars: (m.cars as CarState[]).map(cleanCar) } : null;
    case 'fin':
      return isRacer(m.who) && isNum(m.time) && m.time >= 0 ? { t: 'fin', who: m.who, time: m.time } : null;
    case 'ping':
      return isNum(m.c) ? { t: 'ping', c: m.c } : null;
    default:
      return { t: 'leave' };
  }
}

/** Parses a server message with the same cheap structural checks; null when it isn't one. */
export function parseS2C(raw: string): S2C | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || typeof m.t !== 'string' || !S2C_TAGS.includes(m.t)) return null;
  switch (m.t) {
    case 'welcome':
      return isInt(m.v) && isInt(m.you) && typeof m.token === 'string' && typeof m.code === 'string' ? (m as unknown as S2C) : null;
    case 'room':
      return PHASES.includes(m.phase as string) && Array.isArray(m.seats) && m.seats.length <= MAX_SEATS && m.seats.every(isObj) && validSettings(m.settings) ? (m as unknown as S2C) : null;
    case 'go':
      return validGrid(m.grid) && isInt(m.seed) && isNum(m.goAt) ? (m as unknown as S2C) : null;
    case 'st':
      return isInt(m.from) && isNum(m.at) && validCars(m.cars) ? (m as unknown as S2C) : null;
    case 'result':
      return Array.isArray(m.rows) && m.rows.every((r) => isObj(r) && isRacer(r.who) && (r.time === null || isNum(r.time))) && typeof m.final === 'boolean' ? (m as unknown as S2C) : null;
    case 'pong':
      return isNum(m.c) && isNum(m.s) ? (m as unknown as S2C) : null;
    default:
      return ERRORS.includes(m.code as string) ? (m as unknown as S2C) : null;
  }
}
