import { afterEach, describe, expect, it } from 'vitest';
import { PROTO, type C2S, type CarState, type S2C } from '../../src/net/protocol';

const HTTP = 'http://127.0.0.1:8787';
const WS = 'ws://127.0.0.1:8787';
const ORIGIN = 'http://localhost:5173';

class Client {
  msgs: S2C[] = [];
  closed: { code: number } | null = null;
  private ws: WebSocket;
  private opened: Promise<void>;
  constructor(code: string) {
    this.ws = new WebSocket(`${WS}/rooms/${code}/ws`);
    this.ws.addEventListener('message', (e) => this.msgs.push(JSON.parse(String(e.data)) as S2C));
    this.ws.addEventListener('close', (e) => (this.closed = { code: e.code }));
    this.opened = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('ws error')));
    });
  }
  async send(m: C2S): Promise<void> {
    await this.opened;
    this.ws.send(JSON.stringify(m));
  }
  /** First message matching, from those already received or still to come. */
  async waitFor<T extends S2C>(pred: (m: S2C) => m is T, timeout?: number): Promise<T>;
  async waitFor(pred: (m: S2C) => boolean, timeout?: number): Promise<S2C>;
  async waitFor(pred: (m: S2C) => boolean, timeout = 5000): Promise<S2C> {
    const t0 = Date.now();
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() - t0 > timeout) throw new Error(`timeout; got ${JSON.stringify(this.msgs).slice(0, 800)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  async waitClosed(timeout = 5000): Promise<number> {
    const t0 = Date.now();
    while (!this.closed) {
      if (Date.now() - t0 > timeout) throw new Error('not closed');
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.closed.code;
  }
  close(): void {
    this.ws.close();
  }
}

const open: Client[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.close();
});
const client = (code: string) => {
  const c = new Client(code);
  open.push(c);
  return c;
};
const hello = (name: string, token?: string): C2S => ({ t: 'hello', v: PROTO, name, vehicle: 'bus', ...(token ? { token } : {}) });
const isRoom = (m: S2C): m is Extract<S2C, { t: 'room' }> => m.t === 'room';
const isWelcome = (m: S2C): m is Extract<S2C, { t: 'welcome' }> => m.t === 'welcome';
const isGo = (m: S2C): m is Extract<S2C, { t: 'go' }> => m.t === 'go';
const isResult = (m: S2C): m is Extract<S2C, { t: 'result' }> => m.t === 'result';
const isSt = (m: S2C): m is Extract<S2C, { t: 'st' }> => m.t === 'st';

async function createRoom(): Promise<string> {
  const r = await fetch(`${HTTP}/rooms`, { method: 'POST', headers: { Origin: ORIGIN } });
  expect(r.status).toBe(201);
  expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  const { code } = (await r.json()) as { code: string };
  expect(code).toMatch(/^[A-Z0-9]{4}$/);
  return code;
}

describe('online rooms (wrangler dev)', () => {
  it('health, origin check and unknown code', async () => {
    expect((await fetch(`${HTTP}/health`)).status).toBe(200);
    const bad = await fetch(`${HTTP}/rooms`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    const pre = await fetch(`${HTTP}/rooms`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
    expect(pre.status).toBe(204);
    // fetch() cannot send an Upgrade header: the handshake of an unknown or malformed code just fails.
    for (const code of ['ZZZZ', '!!']) {
      const outcome = await new Promise<string>((res) => {
        const ws = new WebSocket(`${WS}/rooms/${code}/ws`);
        ws.addEventListener('open', () => res('open'));
        ws.addEventListener('error', () => res('error'));
      });
      expect(outcome).toBe('error');
    }
    // The menu asks first: an unknown code is a clean 404, a real room tells its phase.
    expect((await fetch(`${HTTP}/rooms/ZZZZ`, { headers: { Origin: ORIGIN } })).status).toBe(404);
    expect((await fetch(`${HTTP}/rooms/!!`, { headers: { Origin: ORIGIN } })).status).toBe(400);
    const code = await createRoom();
    const info = await fetch(`${HTTP}/rooms/${code.toLowerCase()}`, { headers: { Origin: ORIGIN } });
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({ exists: true, phase: 'lobby', seats: 0 });
  });

  it('plays a whole race between two humans', async () => {
    const code = await createRoom();
    const a = client(code);
    await a.send(hello('Ana'));
    const wa = await a.waitFor(isWelcome);
    expect(wa.code).toBe(code);
    const b = client(code);
    await b.send(hello('Beto'));
    const wb = await b.waitFor(isWelcome);
    expect(wb.you).not.toBe(wa.you);
    const room = await a.waitFor((m): m is Extract<S2C, { t: 'room' }> => isRoom(m) && m.seats.length === 2);
    expect(room.seats.find((s) => s.id === wa.you)?.host).toBe(true);
    expect(room.seats.find((s) => s.id === wb.you)?.host).toBe(false);

    await b.send({ t: 'me', ready: true });
    await a.waitFor((m) => isRoom(m) && m.seats.some((s) => s.id === wb.you && s.ready));

    const grid = [
      { kind: 'human' as const, seat: wa.you, vehicle: 'bus' },
      { kind: 'human' as const, seat: wb.you, vehicle: 'bus' },
    ];
    await a.send({ t: 'start', grid, seed: 1234 });
    await b.waitFor((m) => isRoom(m) && m.phase === 'loading');
    const t0 = Date.now();
    await a.send({ t: 'loaded' });
    await b.send({ t: 'loaded' });
    const ga = await a.waitFor(isGo);
    const gb = await b.waitFor(isGo);
    expect(ga.seed).toBe(1234);
    expect(gb.goAt).toBe(ga.goAt);
    expect(Math.abs(ga.goAt - (t0 + 4500))).toBeLessThan(1500);

    const car: CarState = { who: { seat: wa.you }, s: 10, p: [1, 2, 3], q: [0, 0, 0, 1], v: [0, 0, 0], steer: 0, speed: 5, thr: 1, boost: 0 };
    await a.send({ t: 'st', at: 1, cars: [car] });
    const st = await b.waitFor(isSt);
    expect(st.from).toBe(wa.you);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.msgs.some(isSt)).toBe(false);

    await a.send({ t: 'fin', who: { seat: wa.you }, time: 100 });
    await b.send({ t: 'fin', who: { seat: wb.you }, time: 101 });
    const ra = await a.waitFor((m): m is Extract<S2C, { t: 'result' }> => isResult(m) && m.final);
    expect(ra.rows).toHaveLength(2);
    await b.waitFor((m) => isResult(m) && m.final);
  });

  it('a seat is reclaimed with its token', async () => {
    const code = await createRoom();
    const a = client(code);
    await a.send(hello('Ana'));
    const wa = await a.waitFor(isWelcome);
    const a2 = client(code);
    await a2.send(hello('Ana', wa.token));
    const w2 = await a2.waitFor(isWelcome);
    expect(w2.you).toBe(wa.you);
    expect(w2.token).toBe(wa.token);
    expect(await a.waitClosed()).toBe(4001);
    const room = await a2.waitFor(isRoom);
    expect(room.seats).toHaveLength(1);
  });

  it('rejects a fifth player', async () => {
    const code = await createRoom();
    for (let i = 0; i < 4; i++) {
      const c = client(code);
      await c.send(hello(`P${i}`));
      await c.waitFor(isWelcome);
    }
    const x = client(code);
    await x.send(hello('Late'));
    const err = await x.waitFor((m) => m.t === 'error');
    expect(err).toEqual({ t: 'error', code: 'full' });
    expect(await x.waitClosed()).toBe(4000);
  });
});
