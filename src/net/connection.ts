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

export function saveSession(s: OnlineSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function loadSession(): OnlineSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j && typeof j.code === 'string' && typeof j.token === 'string' && typeof j.name === 'string' && j.code && j.token) return { code: j.code, token: j.token, name: j.name };
  } catch {
    /* corrupt or unavailable */
  }
  return null;
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}

export type ConnState = 'connecting' | 'open' | 'closed' | 'rejected';

export interface ConnOptions {
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

const QUICK_PINGS = 5;
const QUICK_MS = 150;
const PING_MS = 2000;
const BACKOFF = [500, 1000, 2000, 4000];
const GIVE_UP_MS = 30_000;
const FATAL = ['version', 'full', 'racing', 'unknown'];
const OPEN = 1;

export class RoomConnection {
  readonly clock = new ClockSync();
  seat: number | null = null;
  token: string | null = null;
  state: ConnState = 'connecting';
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
    ws.onclose = () => {
      if (ws !== this.ws) return;
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

  /** The socket went away on its own: retry with backoff, give up after 30 s offline. */
  private dropped(): void {
    if (this.stopped) return;
    this.stopPings();
    this.ws = null;
    this.welcomed = false;
    const t = this.now();
    if (this.offlineSince < 0) this.offlineSince = t;
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt++;
    if (t + delay - this.offlineSince > GIVE_UP_MS) {
      this.stopped = true;
      this.setState('closed');
      return;
    }
    this.setState('connecting');
    this.retryTimer = this.setTimer(() => this.connect(), delay);
  }
}
