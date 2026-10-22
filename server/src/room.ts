import {
  DEFAULT_ROOM_SETTINGS,
  MAX_SEATS,
  PROTO,
  cleanName,
  racerKey,
  validSettings,
  type C2S,
  type GridEntry,
  type Racer,
  type ResultRow,
  type RoomPhase,
  type RoomSettings,
  type S2C,
  type Seat,
} from '../../src/net/protocol';

/** Milliseconds a dropped seat keeps its place in the lobby. */
export const LOBBY_GRACE = 30_000;
/** ... and once the room has started loading or racing. */
export const RACE_GRACE = 20_000;
/** Longest wait for every `loaded`; laggards are dropped. */
export const LOAD_TIMEOUT = 30_000;
/** From the last `loaded` to the green light (goAt). */
export const GO_DELAY = 4500;
/** From the first human finish to the final results. */
export const FINISH_TIMEOUT = 90_000;
/** An empty room (no online seat) is forgotten this long after its last activity. */
export const EXPIRE_AFTER = 600_000;
/** `Out.to` of the reply to a rejected `hello` (that socket has no seat). */
export const REJECT = -1;

/** A seat id, every seat, or every seat except `Out.from`. */
export type Target = number | 'all' | 'others';
export interface Out {
  to: Target;
  from?: number;
  msg: S2C;
}

export interface SeatState extends Seat {
  token: string;
  /** When the socket closed (null: online). */
  droppedAt: number | null;
  /** Has sent `loaded` for this start. */
  loaded: boolean;
}

/** Plain JSON, so a Durable Object can store it as is. */
export interface RoomState {
  code: string;
  phase: RoomPhase;
  seats: SeatState[];
  settings: RoomSettings;
  grid: GridEntry[];
  seed: number;
  goAt: number;
  loadStart: number;
  /** When the first human finished (null: nobody yet). */
  firstFin: number | null;
  /** racerKey -> seconds, first report only. */
  times: Record<string, number>;
  lastActivity: number;
}

type Hello = Extract<C2S, { t: 'hello' }>;
const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * One room's rules, pure (no sockets, no clock of its own): every input is a message with the
 * time it arrived, every answer a list of `Out`. Phases: lobby -> loading (everyone loads the
 * track) -> racing (from `go`) -> results; from results the host's `set` or anyone's `me {ready}`
 * returns the room to the lobby (ready flags cleared, offline seats gone).
 */
export class RoomLogic {
  private s: RoomState;

  constructor(code: string, state?: RoomState, private rand: () => number = Math.random) {
    this.s =
      state ??
      {
        code,
        phase: 'lobby',
        seats: [],
        settings: { ...DEFAULT_ROOM_SETTINGS },
        grid: [],
        seed: 0,
        goAt: 0,
        loadStart: 0,
        firstFin: null,
        times: {},
        lastActivity: 0,
      };
  }

  get state(): RoomState {
    return this.s;
  }
  get phase(): RoomPhase {
    return this.s.phase;
  }
  get empty(): boolean {
    return !this.s.seats.some((x) => x.online);
  }
  expired(now: number): boolean {
    return this.empty && now >= this.s.lastActivity + EXPIRE_AFTER;
  }

  /** A new socket's first message. `seat` is null when rejected (the error goes to REJECT). */
  join(msg: Hello, now: number): { seat: number | null; out: Out[] } {
    const s = this.s;
    s.lastActivity = now;
    const reject = (code: 'version' | 'racing' | 'full') => ({ seat: null, out: [{ to: REJECT, msg: { t: 'error', code } } as Out] });
    if (msg.v !== PROTO) return reject('version');
    let seat = msg.token ? s.seats.find((x) => x.token === msg.token) : undefined;
    const back = !!seat;
    if (seat) {
      seat.online = true;
      seat.droppedAt = null;
    } else {
      if (s.phase !== 'lobby') return reject('racing');
      if (s.seats.length >= MAX_SEATS) return reject('full');
      let id = 0;
      while (s.seats.some((x) => x.id === id)) id++;
      seat = { id, name: cleanName(msg.name), vehicle: msg.vehicle.slice(0, 24), ready: false, host: false, online: true, token: this.makeToken(), droppedAt: null, loaded: false };
      s.seats.push(seat);
      s.seats.sort((a, b) => a.id - b.id);
    }
    this.ensureHost();
    const out: Out[] = [{ to: seat.id, msg: { t: 'welcome', v: PROTO, you: seat.id, token: seat.token, code: s.code } }, this.roomMsg()];
    // A seat back mid-race gets the start again; the client skips what it already has.
    if (back && s.phase === 'racing') out.push({ to: seat.id, msg: { t: 'go', grid: s.grid, seed: s.seed, goAt: s.goAt } });
    return { seat: seat.id, out };
  }

  handle(seat: number, msg: C2S, now: number): Out[] {
    const s = this.s;
    const me = s.seats.find((x) => x.id === seat);
    if (!me) return [];
    s.lastActivity = now;
    const err = (code: 'nohost' | 'notready' | 'bad'): Out[] => [{ to: seat, msg: { t: 'error', code } }];
    switch (msg.t) {
      case 'set': {
        if (!me.host) return err('nohost');
        const settings = validSettings(msg.settings);
        if (!settings) return err('bad');
        if (s.phase === 'results') this.toLobby();
        else if (s.phase !== 'lobby') return [];
        s.settings = settings;
        return [this.roomMsg()];
      }
      case 'me': {
        if (s.phase === 'results' && msg.ready !== undefined) this.toLobby();
        if (s.phase !== 'lobby') return [];
        if (msg.vehicle !== undefined) me.vehicle = msg.vehicle.slice(0, 24);
        if (msg.ready !== undefined) me.ready = msg.ready;
        return [this.roomMsg()];
      }
      case 'start':
        return this.start(me, msg, now);
      case 'loaded': {
        if (s.phase !== 'loading') return [];
        me.loaded = true;
        return this.checkGo(now);
      }
      case 'st':
        if (s.phase !== 'racing' || msg.cars.length > 8) return [];
        return [{ to: 'others', from: seat, msg: { t: 'st', from: seat, at: msg.at, cars: msg.cars } }];
      case 'fin':
        return this.fin(me, msg.who, msg.time, now);
      case 'ping':
        return [{ to: seat, msg: { t: 'pong', c: msg.c, s: now } }];
      case 'leave':
        return this.remove([seat], now);
      default:
        return [];
    }
  }

  /** The socket closed: the seat stays (offline) until its grace runs out or it comes back. */
  drop(seat: number, now: number): Out[] {
    const me = this.s.seats.find((x) => x.id === seat);
    if (!me || !me.online) return [];
    this.s.lastActivity = now;
    me.online = false;
    me.droppedAt = now;
    this.ensureHost();
    return [this.roomMsg(), ...this.afterChange(now)];
  }

  /** Timers: grace expiries, the load timeout, the finish timeout. */
  tick(now: number): Out[] {
    const s = this.s;
    const out: Out[] = [];
    const gone = s.seats.filter((x) => x.droppedAt !== null && now >= x.droppedAt + this.grace()).map((x) => x.id);
    if (gone.length) out.push(...this.remove(gone, now));
    if (s.phase === 'loading' && now >= s.loadStart + LOAD_TIMEOUT) {
      const late = s.seats.filter((x) => x.online && !x.loaded).map((x) => x.id);
      if (late.length) out.push(...this.remove(late, now));
      if (s.phase === 'loading') out.push(...this.goNow(now));
    }
    if (s.phase === 'racing' && s.firstFin !== null && now >= s.firstFin + FINISH_TIMEOUT) out.push(...this.finish());
    return out;
  }

  /** When the next timer fires (the Durable Object's alarm), null when there is none. */
  nextWake(_now: number): number | null {
    const s = this.s;
    const w: number[] = [];
    for (const x of s.seats) if (x.droppedAt !== null) w.push(x.droppedAt + this.grace());
    if (s.phase === 'loading') w.push(s.loadStart + LOAD_TIMEOUT);
    if (s.phase === 'racing' && s.firstFin !== null) w.push(s.firstFin + FINISH_TIMEOUT);
    if (this.empty) w.push(s.lastActivity + EXPIRE_AFTER);
    return w.length ? Math.min(...w) : null;
  }

  private grace(): number {
    return this.s.phase === 'lobby' ? LOBBY_GRACE : RACE_GRACE;
  }

  private makeToken(): string {
    let t = '';
    for (let i = 0; i < 16; i++) t += TOKEN_CHARS[Math.min(TOKEN_CHARS.length - 1, Math.floor(this.rand() * TOKEN_CHARS.length))];
    return t;
  }

  private roomMsg(): Out {
    const seats: Seat[] = this.s.seats.map((x) => ({ id: x.id, name: x.name, vehicle: x.vehicle, ready: x.ready, host: x.host, online: x.online }));
    return { to: 'all', msg: { t: 'room', phase: this.s.phase, seats, settings: this.s.settings } };
  }

  /** Exactly one host while any seat is online: the current one if online, else the lowest online seat. */
  private ensureHost(): void {
    const seats = this.s.seats;
    const online = seats.filter((x) => x.online);
    if (!online.length) return;
    const host = online.find((x) => x.host) ?? online[0];
    for (const x of seats) x.host = x === host;
  }

  /** Seats gone for good: out of the room (and the grid while it is still loading). */
  private remove(ids: number[], now: number): Out[] {
    const s = this.s;
    s.seats = s.seats.filter((x) => !ids.includes(x.id));
    if (s.phase === 'loading') s.grid = s.grid.filter((g) => g.kind !== 'human' || !ids.includes(g.seat));
    this.ensureHost();
    return [this.roomMsg(), ...this.afterChange(now)];
  }

  /** Phase work after seats changed: loading may be done, racing may be over. */
  private afterChange(now: number): Out[] {
    if (this.s.phase === 'loading') return this.checkGo(now);
    if (this.s.phase === 'racing') return this.checkFinish();
    return [];
  }

  private toLobby(): void {
    const s = this.s;
    s.phase = 'lobby';
    s.grid = [];
    s.times = {};
    s.firstFin = null;
    s.seats = s.seats.filter((x) => x.online);
    for (const x of s.seats) x.ready = false;
    this.ensureHost();
  }

  private start(me: SeatState, msg: Extract<C2S, { t: 'start' }>, now: number): Out[] {
    const s = this.s;
    const err = (code: 'nohost' | 'notready' | 'bad'): Out[] => [{ to: me.id, msg: { t: 'error', code } }];
    if (!me.host) return err('nohost');
    if (s.phase !== 'lobby') return [];
    if (s.seats.some((x) => x.online && !x.host && !x.ready)) return err('notready');
    const humans = s.seats.filter((x) => x.online).map((x) => x.id);
    const seen = new Set<number>();
    const ai = new Set<number>();
    const grid: GridEntry[] = [];
    let aiCount = 0;
    for (const g of msg.grid) {
      if (g.kind === 'human') {
        if (!humans.includes(g.seat) || seen.has(g.seat)) return err('bad');
        seen.add(g.seat);
        grid.push({ kind: 'human', seat: g.seat, vehicle: g.vehicle });
      } else {
        if (ai.has(g.idx)) return err('bad');
        ai.add(g.idx);
        // More rivals than free places: the extra ones are left out.
        if (++aiCount <= MAX_SEATS - humans.length) grid.push({ kind: 'ai', idx: g.idx, vehicle: g.vehicle, crew: g.crew });
      }
    }
    if (seen.size !== humans.length) return err('bad');
    s.seats = s.seats.filter((x) => x.online);
    for (const x of s.seats) x.loaded = false;
    s.settings = { ...s.settings, ai: Math.min(s.settings.ai, MAX_SEATS - humans.length) };
    s.grid = grid;
    s.seed = msg.seed;
    s.phase = 'loading';
    s.loadStart = now;
    s.times = {};
    s.firstFin = null;
    return [this.roomMsg()];
  }

  /**
   * Every seat of the grid has loaded: go. A seat offline counts as not loaded (its page is on its
   * way from the menu to the game, reconnecting): it's waited for until its grace or the load
   * timeout drops it.
   */
  private checkGo(now: number): Out[] {
    const seats = this.s.seats;
    return seats.length && seats.every((x) => x.online && x.loaded) ? this.goNow(now) : [];
  }

  private goNow(now: number): Out[] {
    const s = this.s;
    s.phase = 'racing';
    s.goAt = now + GO_DELAY;
    return [{ to: 'all', msg: { t: 'go', grid: s.grid, seed: s.seed, goAt: s.goAt } }, this.roomMsg()];
  }

  private rows(): ResultRow[] {
    return this.s.grid.map((g) => {
      const who: Racer = g.kind === 'human' ? { seat: g.seat } : { ai: g.idx };
      return { who, time: this.s.times[racerKey(who)] ?? null };
    });
  }

  private fin(me: SeatState, who: Racer, time: number, now: number): Out[] {
    const s = this.s;
    if (s.phase !== 'racing') return [];
    const key = racerKey(who);
    const valid = 'seat' in who ? who.seat === me.id && s.grid.some((g) => g.kind === 'human' && g.seat === who.seat) : me.host && s.grid.some((g) => g.kind === 'ai' && g.idx === who.ai);
    if (!valid || key in s.times) return [];
    s.times[key] = time;
    if ('seat' in who && s.firstFin === null) s.firstFin = now;
    const out: Out[] = [{ to: 'all', msg: { t: 'result', rows: this.rows(), final: false } }];
    return [...out, ...this.checkFinish()];
  }

  /** Final results once every human of the grid has finished or left. */
  private checkFinish(): Out[] {
    const s = this.s;
    const waiting = s.grid.some((g) => g.kind === 'human' && s.seats.some((x) => x.id === g.seat) && !(`s${g.seat}` in s.times));
    return waiting ? [] : this.finish();
  }

  private finish(): Out[] {
    this.s.phase = 'results';
    return [{ to: 'all', msg: { t: 'result', rows: this.rows(), final: true } }, this.roomMsg()];
  }
}
