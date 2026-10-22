/** Browser side of an online race room: one WebSocket with hello/welcome, clock pings and reconnect. */
import { ClockSync } from './clock';
import { PROTO, parseS2C, type C2S, type S2C } from './protocol';

/** The room server: the build's VITE_QBUS_ROOMS_URL, or the local `wrangler dev` while developing. */
export const ROOMS_URL: string = import.meta.env.VITE_QBUS_ROOMS_URL || (import.meta.env.DEV ? 'ws://localhost:8787' : '');
/** A build with no room server has no online races (the menu hides them). */
export const ONLINE = ROOMS_URL !== '';

/** http(s) base of a ws(s) URL. */
export function httpBase(url: string): string {
  return url.replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, '');
}

/** POST /rooms: a new room's code. */
export async function createRoom(base: string = httpBase(ROOMS_URL), fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${base}/rooms`, { method: 'POST' });
  if (!res.ok) throw new Error(`rooms ${res.status}`);
  const j = (await res.json()) as { code?: unknown };
  if (typeof j.code !== 'string') throw new Error('rooms: no code');
  return j.code;
}

/** What a join can expect: the room's phase and how many seats are taken, or null when there is no such room. */
export async function roomInfo(code: string, base: string = httpBase(ROOMS_URL), fetchImpl: typeof fetch = fetch): Promise<{ phase: string; seats: number } | null> {
  const res = await fetchImpl(`${base}/rooms/${encodeURIComponent(code)}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`rooms ${res.status}`);
  const j = (await res.json()) as { phase?: unknown; seats?: unknown };
  return typeof j.phase === 'string' && typeof j.seats === 'number' ? { phase: j.phase, seats: j.seats } : null;
}

export interface OnlineSession {
  code: string;
  token: string;
  name: string;
}
const SESSION_KEY = 'qbus.online';
/** Seats by room code, kept past the tab (localStorage): a closed tab's link still gets its seat back. */
const SEATS_KEY = 'qbus.online.seats';
/** A saved seat is forgotten after this long (ms): the rooms themselves are gone long before. */
export const SEAT_TTL = 3 * 3600_000;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const okSession = (j: any): boolean => j && typeof j.code === 'string' && typeof j.token === 'string' && typeof j.name === 'string' && !!j.code && !!j.token;

function loadSeats(s: Store | null, now: number): Record<string, OnlineSession & { at: number }> {
  const out: Record<string, OnlineSession & { at: number }> = {};
  try {
    const j = JSON.parse(s?.getItem(SEATS_KEY) ?? 'null');
    if (j && typeof j === 'object') for (const v of Object.values<any>(j)) if (okSession(v) && typeof v.at === 'number' && now - v.at < SEAT_TTL) out[v.code] = { code: v.code, token: v.token, name: v.name, at: v.at };
  } catch {
    /* corrupt or unavailable */
  }
  return out;
}

function storeSeats(s: Store | null, seats: Record<string, unknown>): void {
  try {
    if (Object.keys(seats).length) s?.setItem(SEATS_KEY, JSON.stringify(seats));
    else s?.removeItem(SEATS_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function saveSession(s: OnlineSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
  const store = local();
  const now = Date.now();
  storeSeats(store, { ...loadSeats(store, now), [s.code]: { ...s, at: now } });
}

/** This tab's seat (survives a reload). */
export function loadSession(): OnlineSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (okSession(j)) return { code: j.code, token: j.token, name: j.name };
  } catch {
    /* corrupt or unavailable */
  }
  return null;
}

/** The seat this browser held in room `code`: this tab's, else the last saved one (a reopened tab), if not expired. */
export function savedSeat(code: string): OnlineSession | null {
  const mine = loadSession();
  if (mine && mine.code === code) return mine;
  const v = loadSeats(local(), Date.now())[code];
  return v ? { code: v.code, token: v.token, name: v.name } : null;
}

/** The most recently saved seat of any room (for "Volver a la sala"), if not expired. */
export function lastSavedSeat(): OnlineSession | null {
  const all = Object.values(loadSeats(local(), Date.now())).sort((a, b) => b.at - a.at);
  return all[0] ? { code: all[0].code, token: all[0].token, name: all[0].name } : null;
}

/** Forgets this tab's seat and the saved one of its room (or of `code`). */
export function clearSession(code?: string): void {
  const mine = loadSession();
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
  const c = code ?? mine?.code;
  if (!c) return;
  const store = local();
  const seats = loadSeats(store, Date.now());
  delete seats[c];
  storeSeats(store, seats);
}

export type ConnState = 'connecting' | 'open' | 'closed' | 'rejected';

export interface ConnOptions {
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Keep retrying a lost link this long (ms) before the state turns `closed` (Infinity: until `close()` or a rejection). */
  giveUpMs?: number;
}

const QUICK_PINGS = 5;
const QUICK_MS = 150;
const PING_MS = 2000;
const BACKOFF = [500, 1000, 2000, 4000];
const GIVE_UP_MS = 30_000;
const FATAL = ['version', 'full', 'racing', 'unknown'];
const OPEN = 1;
/** The room's close code for a socket whose seat another socket took. */
const REPLACED = 4001;

export class RoomConnection {
  readonly clock = new ClockSync();
  seat: number | null = null;
  token: string | null = null;
  state: ConnState = 'connecting';
  /** Rejected because another page took this seat over. */
  replaced = false;
  onState: ((s: ConnState) => void) | null = null;

  private ws: WebSocket | null = null;
  private welcomed = false;
  private stopped = false;
  private attempt = 0;
  private offlineSince = -1;
  private pings = 0;
  private pingTimer: unknown = null;
  private retryTimer: unknown = null;
  private listeners = new Map<string, Set<(m: any) => void>>();
  private readonly giveUpMs: number;
  private readonly url: string;
  private readonly Impl: typeof WebSocket;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(
    private readonly code: string,
    private readonly hello: { name: string; vehicle: string; token?: string },
    opts: ConnOptions = {},
  ) {
    this.url = opts.url ?? ROOMS_URL;
    this.Impl = opts.WebSocketImpl ?? WebSocket;
    this.now = opts.now ?? (() => performance.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.token = hello.token ?? null;
    this.giveUpMs = opts.giveUpMs ?? GIVE_UP_MS;
    this.connect();
  }

  /** Subscribe to one message type; returns the unsubscribe function. */
  on<T extends S2C['t']>(t: T, fn: (m: Extract<S2C, { t: T }>) => void): () => void {
    let set = this.listeners.get(t);
    if (!set) this.listeners.set(t, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Dropped silently unless the socket is open and welcomed (a hello only needs the socket). */
  send(m: C2S): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    if (m.t !== 'hello' && !this.welcomed) return;
    ws.send(JSON.stringify(m));
  }

  /** "Reconectar": try again now (also after the connection gave up), starting the backoff over. */
  retry(): void {
    if (this.stopped && this.state === 'rejected') return;
    if (this.ws && this.welcomed) return;
    this.stopped = false;
    this.attempt = 0;
    this.offlineSince = -1;
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.setState('connecting');
    this.connect();
  }

  /** Leave the room and stop for good. */
  close(): void {
    if (this.stopped) return;
    this.send({ t: 'leave' });
    this.stopped = true;
    this.teardown();
    this.setState('closed');
  }

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.onState?.(s);
  }

  private connect(): void {
    this.retryTimer = null;
    let ws: WebSocket;
    try {
      ws = new this.Impl(`${this.url}/rooms/${this.code}/ws`);
    } catch {
      this.dropped();
      return;
    }
    this.ws = ws;
    this.welcomed = false;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.send({ t: 'hello', v: PROTO, name: this.hello.name, vehicle: this.hello.vehicle, token: this.token ?? undefined });
    };
    ws.onmessage = (e: MessageEvent) => {
      if (ws !== this.ws) return;
      const m = typeof e.data === 'string' ? parseS2C(e.data) : null;
      if (m) this.handle(m);
    };
    ws.onclose = (e: CloseEvent) => {
      if (ws !== this.ws) return;
      // The room gave this seat to another page (a second tab, a reopened one): this page must not take it back.
      if (e?.code === REPLACED) {
        this.replaced = true;
        this.stopped = true;
        this.teardown();
        this.setState('rejected');
        return;
      }
      this.dropped();
    };
    ws.onerror = () => {};
  }

  private handle(m: S2C): void {
    if (m.t === 'welcome') {
      this.welcomed = true;
      this.seat = m.you;
      this.token = m.token;
      this.attempt = 0;
      this.offlineSince = -1;
      saveSession({ code: this.code, token: m.token, name: this.hello.name });
      this.setState('open');
      this.startPings();
    } else if (m.t === 'pong') {
      this.clock.sample(m.c, m.s, this.now());
    } else if (m.t === 'error' && FATAL.includes(m.code)) {
      this.stopped = true;
      this.teardown();
      this.setState('rejected');
    }
    const set = this.listeners.get(m.t);
    if (set) for (const fn of [...set]) fn(m);
  }

  private startPings(): void {
    this.stopPings();
    this.pings = 0;
    const tick = () => {
      this.send({ t: 'ping', c: this.now() });
      this.pings++;
      this.pingTimer = this.setTimer(tick, this.pings < QUICK_PINGS ? QUICK_MS : PING_MS);
    };
    tick();
  }

  private stopPings(): void {
    if (this.pingTimer !== null) this.clearTimer(this.pingTimer);
    this.pingTimer = null;
  }

  private teardown(): void {
    this.stopPings();
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  /** The socket went away on its own: retry with backoff, give up after `giveUpMs` offline. */
  private dropped(): void {
    if (this.stopped) return;
    this.stopPings();
    this.ws = null;
    this.welcomed = false;
    const t = this.now();
    if (this.offlineSince < 0) this.offlineSince = t;
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    if (t + delay - this.offlineSince > this.giveUpMs) {
      this.stopped = true;
      this.setState('closed');
      return;
    }
    this.setState('connecting');
    this.retryTimer = this.setTimer(() => this.connect(), delay);
  }
}
