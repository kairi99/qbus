import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClockSync, MAX_SLEW, WINDOW } from '../src/net/clock';
import { RoomConnection, SEAT_TTL, clearSession, createRoom, lastSavedSeat, loadSession, saveSession, savedSeat } from '../src/net/connection';
import { PROTO } from '../src/net/protocol';

describe('ClockSync', () => {
  it('converges to the true offset under jittery rtt', () => {
    const TRUE = 1_700_000_000_000 - 5000;
    const c = new ClockSync();
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let t = 1000;
    for (let i = 0; i < 60; i++) {
      const out = 20 + rnd() * 80;
      const back = 20 + rnd() * 80;
      const send = t;
      const recv = t + out + back;
      c.sample(send, TRUE + send + out, recv);
      t += 500;
    }
    expect(c.ready).toBe(true);
    expect(Math.abs(c.serverNow(t) - (TRUE + t))).toBeLessThan(60);
    expect(c.rtt).toBeGreaterThanOrEqual(40);
  });

  it('first sample sets the offset, later ones slew', () => {
    const c = new ClockSync();
    expect(c.ready).toBe(false);
    c.sample(100, 10_000 + 110, 120); // rtt 20, offset = 10110+10-120 = 10000
    expect(c.serverNow(0)).toBeCloseTo(10_000);
    c.sample(200, 10_300 + 205, 210); // rtt 10 wins, target 10300 -> moves by MAX_SLEW only
    expect(c.serverNow(0)).toBeCloseTo(10_000 + MAX_SLEW);
  });

  it('jumps on a big resync', () => {
    const c = new ClockSync();
    c.sample(0, 5010, 20);
    for (let i = 1; i <= WINDOW; i++) c.sample(i * 100, 50_000 + i * 100 + 10, i * 100 + 20);
    expect(c.serverNow(0)).toBeCloseTo(50_000, 0);
  });

  it('ignores bad rtt', () => {
    const c = new ClockSync();
    c.sample(100, 0, 50);
    c.sample(0, 0, 6000);
    expect(c.ready).toBe(false);
    c.sample(0, 100, 10);
    expect(c.ready).toBe(true);
  });

  it('serverNow and toLocal are inverse', () => {
    const c = new ClockSync();
    c.sample(0, 123_456, 40);
    expect(c.toLocal(c.serverNow(777))).toBeCloseTo(777);
  });
});

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  closed = false;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  recv(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

class Timers {
  t = 0;
  q: { at: number; fn: () => void; id: number }[] = [];
  n = 0;
  set = (fn: () => void, ms: number) => {
    const id = ++this.n;
    this.q.push({ at: this.t + ms, fn, id });
    return id;
  };
  clear = (id: unknown) => {
    this.q = this.q.filter((x) => x.id !== id);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

const WELCOME = { t: 'welcome', v: PROTO, you: 2, token: 'tok', code: 'ABCD' };

describe('RoomConnection', () => {
  let tm: Timers;
  const make = (token?: string) =>
    new RoomConnection('ABCD', { name: 'Ana', vehicle: 'bus', token }, { url: 'ws://x', WebSocketImpl: FakeWS as any, now: () => tm.t, setTimer: tm.set, clearTimer: tm.clear });
  const last = () => FakeWS.all[FakeWS.all.length - 1];

  beforeEach(() => {
    tm = new Timers();
    FakeWS.all = [];
    (globalThis as any).sessionStorage = stubStorage();
  });
  afterEach(() => {
    delete (globalThis as any).sessionStorage;
  });

  it('sends hello on open, welcome sets seat and token', () => {
    const c = make();
    expect(last().url).toBe('ws://x/rooms/ABCD/ws');
    last().open();
    expect(last().sent[0]).toEqual({ t: 'hello', v: PROTO, name: 'Ana', vehicle: 'bus' });
    last().recv(WELCOME);
    expect(c.seat).toBe(2);
    expect(c.token).toBe('tok');
    expect(c.state).toBe('open');
    expect(loadSession()).toEqual({ code: 'ABCD', token: 'tok', name: 'Ana' });
  });

  it('drops send before welcome', () => {
    const c = make();
    last().open();
    c.send({ t: 'loaded' });
    expect(last().sent).toHaveLength(1);
    last().recv(WELCOME);
    c.send({ t: 'loaded' });
    expect(last().sent.at(-1)).toEqual({ t: 'loaded' });
  });

  it('pings quick then slow, pong feeds the clock', () => {
    const c = make();
    last().open();
    last().recv(WELCOME);
    const pings = () => last().sent.filter((m) => m.t === 'ping');
    expect(pings()).toHaveLength(1);
    tm.advance(600);
    expect(pings()).toHaveLength(5);
    tm.advance(1999);
    expect(pings()).toHaveLength(5);
    tm.advance(1);
    expect(pings()).toHaveLength(6);
    const p = pings()[0];
    tm.t = p.c + 40;
    last().recv({ t: 'pong', c: p.c, s: 90_000 });
    expect(c.clock.ready).toBe(true);
    expect(c.clock.serverNow(tm.t)).toBeCloseTo(90_000 + 20 - 40 + 40, 0);
  });

  it('dispatches typed messages and unsubscribes', () => {
    const c = make();
    const got: number[] = [];
    const off = c.on('welcome', (m) => got.push(m.you));
    last().open();
    last().recv(WELCOME);
    off();
    last().recv(WELCOME);
    expect(got).toEqual([2]);
  });

  it('ignores invalid messages', () => {
    const c = make();
    last().open();
    last().onmessage({ data: 'garbage' });
    last().recv({ t: 'nope' });
    expect(c.seat).toBeNull();
  });

  it('reconnects with backoff and the token, gives up after 30 s', () => {
    const c = make();
    last().open();
    last().recv(WELCOME);
    const states: string[] = [];
    c.onState = (s) => states.push(s);
    last().drop();
    expect(c.state).toBe('connecting');
    expect(FakeWS.all).toHaveLength(1);
    tm.advance(499);
    expect(FakeWS.all).toHaveLength(1);
    tm.advance(1);
    expect(FakeWS.all).toHaveLength(2);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'hello', token: 'tok' });
    last().drop(); // never welcomed: backoff continues 1 s
    tm.advance(999);
    expect(FakeWS.all).toHaveLength(2);
    tm.advance(1);
    expect(FakeWS.all).toHaveLength(3);
    last().drop();
    tm.advance(2000);
    expect(FakeWS.all).toHaveLength(4);
    last().drop();
    tm.advance(4000);
    expect(FakeWS.all).toHaveLength(5);
    // keep failing until 30 s offline
    for (let i = 0; i < 20 && c.state !== 'closed'; i++) {
      last().drop();
      tm.advance(4000);
    }
    expect(c.state).toBe('closed');
    const n = FakeWS.all.length;
    tm.advance(60_000);
    expect(FakeWS.all).toHaveLength(n);
  });

  it('keeps retrying forever when asked, and "Reconectar" tries at once, backoff starting over', () => {
    const c = new RoomConnection('ABCD', { name: 'Ana', vehicle: 'bus', token: 'tok' }, { url: 'ws://x', WebSocketImpl: FakeWS as any, now: () => tm.t, setTimer: tm.set, clearTimer: tm.clear, giveUpMs: Infinity });
    last().open();
    last().recv(WELCOME);
    last().drop();
    for (let i = 0; i < 200; i++) {
      tm.advance(4000);
      last().drop();
    }
    expect(c.state).toBe('connecting');
    const n = FakeWS.all.length;
    expect(n).toBeGreaterThan(100);
    c.retry();
    expect(FakeWS.all).toHaveLength(n + 1);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'hello', token: 'tok' });
    last().recv(WELCOME);
    expect(c.state).toBe('open');
    // already welcomed: a retry does nothing
    c.retry();
    expect(FakeWS.all).toHaveLength(n + 1);
  });

  it('after it gave up, retry() starts again; after a rejection it does not', () => {
    const c = make('tok');
    for (let i = 0; i < 20 && c.state !== 'closed'; i++) {
      last().drop();
      tm.advance(4000);
    }
    expect(c.state).toBe('closed');
    const n = FakeWS.all.length;
    c.retry();
    expect(c.state).toBe('connecting');
    expect(FakeWS.all).toHaveLength(n + 1);
    last().open();
    last().recv({ t: 'error', code: 'racing' });
    expect(c.state).toBe('rejected');
    c.retry();
    expect(FakeWS.all).toHaveLength(n + 1);
  });

  it('a socket the room closed as replaced (another page took the seat) is not retried', () => {
    const c = make('tok');
    last().open();
    last().recv(WELCOME);
    last().readyState = 3;
    last().onclose({ code: 4001 });
    expect(c.state).toBe('rejected');
    expect(c.replaced).toBe(true);
    tm.advance(60_000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('rejects on fatal error without reconnecting', () => {
    const c = make();
    last().open();
    last().recv({ t: 'error', code: 'version' });
    expect(c.state).toBe('rejected');
    tm.advance(10_000);
    expect(FakeWS.all).toHaveLength(1);
  });

  it('close sends leave and does not reconnect', () => {
    const c = make();
    const ws = last();
    ws.open();
    ws.recv(WELCOME);
    c.close();
    expect(ws.sent.at(-1)).toEqual({ t: 'leave' });
    expect(c.state).toBe('closed');
    tm.advance(10_000);
    expect(FakeWS.all).toHaveLength(1);
    expect(ws.sent.filter((m) => m.t === 'ping')).toHaveLength(1);
  });
});

describe('createRoom', () => {
  it('POSTs /rooms and returns the code', async () => {
    let seen: any[] = [];
    const f = (async (u: string, init: any) => {
      seen = [u, init];
      return { ok: true, status: 200, json: async () => ({ code: 'WXYZ' }) };
    }) as any;
    expect(await createRoom('http://h:1', f)).toBe('WXYZ');
    expect(seen[0]).toBe('http://h:1/rooms');
    expect(seen[1].method).toBe('POST');
  });
  it('throws on failure', async () => {
    const f = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    await expect(createRoom('http://h', f)).rejects.toThrow();
  });
});

function stubStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('session helpers', () => {
  beforeEach(() => {
    (globalThis as any).sessionStorage = stubStorage();
  });
  afterEach(() => {
    delete (globalThis as any).sessionStorage;
  });
  it('round-trips and clears', () => {
    expect(loadSession()).toBeNull();
    saveSession({ code: 'ABCD', token: 't', name: 'n' });
    expect(loadSession()).toEqual({ code: 'ABCD', token: 't', name: 'n' });
    clearSession();
    expect(loadSession()).toBeNull();
  });
  it('rejects junk', () => {
    for (const j of ['{', '[]', '{"code":1}', '{"code":"A","token":"","name":"x"}', 'null']) {
      sessionStorage.setItem('qbus.online', j);
      expect(loadSession()).toBeNull();
    }
  });
  it('survives missing storage', () => {
    delete (globalThis as any).sessionStorage;
    expect(() => saveSession({ code: 'A', token: 't', name: 'n' })).not.toThrow();
    expect(loadSession()).toBeNull();
    expect(() => clearSession()).not.toThrow();
  });
});

describe('saved seats (a reopened tab)', () => {
  beforeEach(() => {
    (globalThis as any).sessionStorage = stubStorage();
    (globalThis as any).localStorage = stubStorage();
  });
  afterEach(() => {
    delete (globalThis as any).sessionStorage;
    delete (globalThis as any).localStorage;
  });
  it('outlives the tab, per room, and is forgotten with the room', () => {
    const real = Date.now;
    saveSession({ code: 'AAAA', token: 'a', name: 'Ana' });
    Date.now = () => real() + 5;
    saveSession({ code: 'BBBB', token: 'b', name: 'Ana' });
    Date.now = real;
    (globalThis as any).sessionStorage = stubStorage(); // the tab was closed
    expect(loadSession()).toBeNull();
    expect(savedSeat('AAAA')).toEqual({ code: 'AAAA', token: 'a', name: 'Ana' });
    expect(savedSeat('CCCC')).toBeNull();
    expect(lastSavedSeat()?.code).toBe('BBBB');
    clearSession('BBBB');
    expect(savedSeat('BBBB')).toBeNull();
    expect(lastSavedSeat()?.code).toBe('AAAA');
  });
  it('clearing the tab seat clears its saved one too', () => {
    saveSession({ code: 'AAAA', token: 'a', name: 'Ana' });
    clearSession();
    expect(savedSeat('AAAA')).toBeNull();
  });
  it('expires, and junk is dropped', () => {
    saveSession({ code: 'AAAA', token: 'a', name: 'Ana' });
    const real = Date.now;
    Date.now = () => real() + SEAT_TTL + 1;
    try {
      (globalThis as any).sessionStorage = stubStorage();
      expect(savedSeat('AAAA')).toBeNull();
    } finally {
      Date.now = real;
    }
    for (const j of ['{', '[]', '{"AAAA":{"code":"AAAA"}}', 'null', '{"AAAA":5}']) {
      localStorage.setItem('qbus.online.seats', j);
      expect(savedSeat('AAAA')).toBeNull();
    }
  });
  it('survives missing or throwing storage', () => {
    delete (globalThis as any).localStorage;
    expect(() => saveSession({ code: 'A', token: 't', name: 'n' })).not.toThrow();
    expect(savedSeat('A')).toEqual({ code: 'A', token: 't', name: 'n' }); // this tab's
    (globalThis as any).localStorage = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
    expect(() => saveSession({ code: 'A', token: 't', name: 'n' })).not.toThrow();
    expect(() => clearSession('A')).not.toThrow();
    expect(lastSavedSeat()).toBeNull();
  });
});
