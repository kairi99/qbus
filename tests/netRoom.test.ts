import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  MAX_SEATS,
  PROTO,
  cleanName,
  isCode,
  makeCode,
  normalizeCode,
  parseC2S,
  parseS2C,
  racerKey,
  sameRacer,
  type C2S,
  type CarState,
  type GridEntry,
  type S2C,
} from '../src/net/protocol';
import { EXPIRE_AFTER, FINISH_TIMEOUT, GO_DELAY, LOAD_GRACE, LOAD_TIMEOUT, LOBBY_GRACE, RACE_GRACE, RoomLogic, type Out, type RoomState } from '../server/src/room';

const hello = (name = 'A', token?: string): Extract<C2S, { t: 'hello' }> => ({ t: 'hello', v: PROTO, name, vehicle: 'bus', ...(token ? { token } : {}) });
const SET = { track: 'papallacta', ai: 3, skill: 'hard', rivalBus: 'same', rain: 'always', tod: 'night', slides: true } as const;
const msgs = (out: Out[], t: string) => out.filter((o) => o.msg.t === t);
const last = <T extends S2C['t']>(out: Out[], t: T) => msgs(out, t).at(-1)?.msg as Extract<S2C, { t: T }>;
const humans = (...ids: number[]): GridEntry[] => ids.map((seat) => ({ kind: 'human', seat, vehicle: 'bus' }));
const ais = (n: number): GridEntry[] => Array.from({ length: n }, (_, idx) => ({ kind: 'ai', idx, vehicle: 'bus', crew: 0 }));

function room(n: number) {
  const r = new RoomLogic('ABCD');
  for (let i = 0; i < n; i++) r.join(hello('P' + i), 0);
  return r;
}
/** n seats ready and started with `grid`, all loaded: racing, goAt = 1000 + GO_DELAY. */
function racing(n: number, ai = 1) {
  const r = room(n);
  for (let i = 1; i < n; i++) r.handle(i, { t: 'me', ready: true }, 0);
  r.handle(0, { t: 'start', grid: [...humans(...Array.from({ length: n }, (_, i) => i)), ...ais(ai)], seed: 7 }, 0);
  for (let i = 0; i < n; i++) r.handle(i, { t: 'loaded' }, 1000);
  return r;
}

describe('protocol', () => {
  it('codes', () => {
    for (let i = 0; i < 50; i++) expect(isCode(makeCode())).toBe(true);
    expect(makeCode(() => 0)).toBe('AAAA');
    expect(makeCode(() => 0.999999)).toBe(CODE_ALPHABET[CODE_ALPHABET.length - 1].repeat(4));
    expect(normalizeCode(' abcd ')).toBe('ABCD');
    expect(normalizeCode('ABC0')).toBeNull();
    expect(normalizeCode('ABCDE')).toBeNull();
    expect(isCode('abcd')).toBe(false);
  });
  it('names', () => {
    expect(cleanName('  a\u0000   b  ')).toBe('a b');
    expect(cleanName('   ')).toBe('Ñaño');
    expect(cleanName('x'.repeat(40))).toHaveLength(16);
  });
  it('racers', () => {
    expect(racerKey({ seat: 0 })).toBe('s0');
    expect(racerKey({ ai: 1 })).toBe('a1');
    expect(sameRacer({ seat: 1 }, { seat: 1 })).toBe(true);
    expect(sameRacer({ seat: 1 }, { ai: 1 })).toBe(false);
  });
  it('parseC2S accepts good and rejects garbage', () => {
    expect(parseC2S(JSON.stringify(hello(' Ana ')))).toMatchObject({ t: 'hello', name: 'Ana' });
    expect(parseC2S('{"t":"loaded"}')).toEqual({ t: 'loaded' });
    for (const bad of ['', 'nope', '[]', '5', 'null', '{}', '{"t":"zzz"}', '{"t":"ping"}', '{"t":"st","at":1,"cars":5}', '{"t":"fin","who":{},"time":3}']) expect(parseC2S(bad)).toBeNull();
    expect(parseC2S(JSON.stringify({ ...hello(), vehicle: 'v'.repeat(25) }))).toBeNull();
    expect(parseC2S(JSON.stringify({ ...hello(), name: 'n'.repeat(17) }))).toBeNull();
    expect(parseC2S(JSON.stringify({ t: 'set', settings: { ...SET, ai: 9 } }))).toBeNull();
    expect(parseC2S(JSON.stringify({ t: 'set', settings: { ...SET, ai: 5 } }))).not.toBeNull();
    expect(parseC2S(JSON.stringify({ t: 'set', settings: { ...SET, ai: 6 } }))).toBeNull();
    expect(parseC2S(JSON.stringify({ t: 'st', at: 1, cars: Array(9).fill({ who: { seat: 0 } }) }))).toBeNull();
    const car = { who: { seat: 0 }, s: 10, p: [1, 2, 3], q: [0, 0, 0, 1], v: [0, 0, 0], steer: 0, speed: 5, thr: 1, boost: 0 };
    expect(parseC2S(JSON.stringify({ t: 'st', at: 1, cars: [car] }))).toEqual({ t: 'st', at: 1, cars: [car] });
    // Anything a remote bus is driven from must be a finite number: no NaN into the physics.
    expect(parseC2S(JSON.stringify({ t: 'st', at: 1, cars: [{ ...car, p: [1, 'x', 3] }] }))).toBeNull();
    expect(parseC2S(JSON.stringify({ t: 'st', at: 1, cars: [{ ...car, q: [0, 0, 1] }] }))).toBeNull();
    expect(parseC2S(JSON.stringify({ t: 'st', at: 1, cars: [{ ...car, rears: [[1, 2, 3]] }] }))).toBeNull();
    // Extra fields don't ride the relay.
    expect(parseC2S(JSON.stringify({ t: 'st', at: 1, cars: [{ ...car, junk: 'x'.repeat(1000) }] }))).toEqual({ t: 'st', at: 1, cars: [car] });
  });
  it('parseS2C', () => {
    expect(parseS2C('{"t":"pong","c":1,"s":2}')).toEqual({ t: 'pong', c: 1, s: 2 });
    expect(parseS2C('{"t":"error","code":"full"}')).not.toBeNull();
    expect(parseS2C('{"t":"error","code":"x"}')).toBeNull();
    expect(parseS2C('junk')).toBeNull();
  });
});

describe('room join', () => {
  it('first seat is host; welcome then room', () => {
    const r = new RoomLogic('ABCD');
    const j = r.join(hello(), 0);
    expect(j.seat).toBe(0);
    expect(j.out[0]).toMatchObject({ to: 0, msg: { t: 'welcome', you: 0, code: 'ABCD' } });
    const room = last(j.out, 'room');
    expect(room.seats[0]).toMatchObject({ host: true, online: true });
    expect(r.join(hello('B'), 0).seat).toBe(1);
    expect(r.empty).toBe(false);
  });
  it('rejects version, full, racing', () => {
    const r = room(MAX_SEATS);
    expect(MAX_SEATS).toBe(6);
    expect(r.join({ ...hello(), v: 99 }, 0)).toMatchObject({ seat: null, out: [{ msg: { t: 'error', code: 'version' } }] });
    expect(r.join(hello(), 0)).toMatchObject({ seat: null, out: [{ msg: { t: 'error', code: 'full' } }] });
    const q = racing(2);
    expect(q.join(hello(), 0)).toMatchObject({ seat: null, out: [{ msg: { t: 'error', code: 'racing' } }] });
  });
  it('lowest free seat id is reused', () => {
    const r = room(3);
    r.handle(1, { t: 'leave' }, 0);
    expect(r.join(hello(), 0).seat).toBe(1);
  });
  it('token reclaims a seat, online or not, even mid-race', () => {
    const r = racing(2);
    const token = r.state.seats[1].token;
    expect(token).toHaveLength(16);
    r.drop(1, 2000);
    const j = r.join(hello('X', token), 3000);
    expect(j.seat).toBe(1);
    expect(last(j.out, 'welcome').token).toBe(token);
    expect(msgs(j.out, 'go')[0].to).toBe(1);
    expect(r.state.seats[1].online).toBe(true);
    // reclaim of a still-online seat takes it over
    expect(r.join(hello('X', token), 3100).seat).toBe(1);
  });
  it('host stays while offline, passes to the oldest connected seat only when gone', () => {
    const r = room(3);
    const token = r.state.seats[0].token;
    // dropped: still the host (its seat is kept), nobody else is
    r.drop(0, 0);
    expect(r.state.seats.map((x) => x.host)).toEqual([true, false, false]);
    expect(last(r.handle(1, { t: 'me', ready: true }, 1), 'room').seats.find((x) => x.host)?.id).toBe(0);
    expect(r.handle(1, { t: 'set', settings: { ...SET } }, 1)[0].msg).toEqual({ t: 'error', code: 'nohost' });
    // it comes back: nothing changed
    r.join(hello('P0', token), 2);
    expect(r.state.seats.find((x) => x.host)?.id).toBe(0);
    // grace over: the oldest connected seat (not the lowest id) takes over
    r.state.seats[2].since = 1;
    r.state.seats[1].since = 5;
    r.drop(0, 10);
    const out = r.tick(10 + LOBBY_GRACE);
    expect(last(out, 'room').seats.find((x) => x.host)?.id).toBe(2);
    // a seat that leaves gives the host up at once
    const out2 = r.handle(2, { t: 'leave' }, 11 + LOBBY_GRACE);
    expect(last(out2, 'room').seats.find((x) => x.host)?.id).toBe(1);
  });
  it('a host gone with nobody connected: the next seat to come back is host', () => {
    const r = room(2);
    const t1 = r.state.seats[1].token;
    r.drop(0, 0);
    r.drop(1, 0);
    r.tick(LOBBY_GRACE);
    expect(r.state.seats).toHaveLength(0);
    const j = r.join(hello('N'), LOBBY_GRACE + 1);
    expect(j.seat).toBe(0);
    expect(r.state.seats[0].host).toBe(true);
    expect(t1).toBeTruthy();
  });
});

describe('lobby', () => {
  it('set is host only and sets the room', () => {
    const r = room(2);
    expect(r.handle(1, { t: 'set', settings: { ...SET } }, 0)[0].msg).toEqual({ t: 'error', code: 'nohost' });
    expect(last(r.handle(0, { t: 'set', settings: { ...SET } }, 0), 'room').settings.skill).toBe('hard');
    expect(r.handle(0, { t: 'set', settings: { ...SET, ai: 7 } }, 0)[0].msg).toEqual({ t: 'error', code: 'bad' });
  });
  it('set carries the room rain and light: the same for everyone, defaults from an older client', () => {
    const r = room(2);
    expect(last(r.handle(0, { t: 'set', settings: { ...SET } }, 0), 'room').settings).toMatchObject({ rain: 'always', tod: 'night' });
    const { rain: _r, tod: _t, ...old } = SET;
    expect(last(r.handle(0, { t: 'set', settings: old as any }, 0), 'room').settings).toMatchObject({ rain: 'random', tod: 'day' });
    expect(r.handle(0, { t: 'set', settings: { ...SET, rain: 'hail' as any } }, 0)[0].msg).toEqual({ t: 'error', code: 'bad' });
  });

  it('set carries the landslides switch: on for an older client, junk rejected', () => {
    const r = room(2);
    expect(last(r.handle(0, { t: 'set', settings: { ...SET, slides: false } }, 0), 'room').settings.slides).toBe(false);
    const { slides: _o, ...old } = SET;
    expect(last(r.handle(0, { t: 'set', settings: old as any }, 0), 'room').settings.slides).toBe(true);
    expect(r.handle(0, { t: 'set', settings: { ...SET, slides: 'si' as any } }, 0)[0].msg).toEqual({ t: 'error', code: 'bad' });
  });
  it('me updates vehicle and ready', () => {
    const r = room(2);
    const room1 = last(r.handle(1, { t: 'me', vehicle: 'car', ready: true }, 0), 'room');
    expect(room1.seats[1]).toMatchObject({ vehicle: 'car', ready: true });
  });
  it('start gating', () => {
    const r = room(3);
    const start = (grid: GridEntry[]): Out[] => r.handle(0, { t: 'start', grid, seed: 1 }, 0);
    expect(r.handle(1, { t: 'start', grid: humans(0, 1, 2), seed: 1 }, 0)[0].msg).toEqual({ t: 'error', code: 'nohost' });
    expect(start(humans(0, 1, 2))[0].msg).toEqual({ t: 'error', code: 'notready' });
    r.handle(1, { t: 'me', ready: true }, 0);
    r.handle(2, { t: 'me', ready: true }, 0);
    expect(start(humans(0, 1))[0].msg).toEqual({ t: 'error', code: 'bad' }); // missing seat
    expect(start([...humans(0, 1, 2), ...humans(2)])[0].msg).toEqual({ t: 'error', code: 'bad' }); // dup
    expect(start(humans(0, 1, 5))[0].msg).toEqual({ t: 'error', code: 'bad' }); // unknown
    expect(r.phase).toBe('lobby');
    // 3 humans leave room for 3 AI: extras are clamped
    start([...humans(0, 1, 2), ...ais(5)]);
    expect(r.phase).toBe('loading');
    expect(r.state.grid.filter((g) => g.kind === 'ai')).toHaveLength(MAX_SEATS - 3);
    expect(r.state.settings.ai).toBeLessThanOrEqual(MAX_SEATS - 3);
  });
  it('offline seats are removed at start', () => {
    const r = room(3);
    r.handle(1, { t: 'me', ready: true }, 0);
    r.drop(2, 0);
    r.handle(0, { t: 'start', grid: humans(0, 1), seed: 1 }, 5);
    expect(r.phase).toBe('loading');
    expect(r.state.seats.map((s) => s.id)).toEqual([0, 1]);
  });
});

describe('loading and racing', () => {
  it('go once everyone loaded, with goAt', () => {
    const r = room(2);
    r.handle(1, { t: 'me', ready: true }, 0);
    r.handle(0, { t: 'start', grid: [...humans(0, 1), ...ais(2)], seed: 42 }, 0);
    expect(r.handle(0, { t: 'loaded' }, 100)).toEqual([]);
    const out = r.handle(1, { t: 'loaded' }, 500);
    expect(r.phase).toBe('racing');
    expect(last(out, 'go')).toMatchObject({ seed: 42, goAt: 500 + GO_DELAY });
    expect(msgs(out, 'go')[0].to).toBe('all');
  });
  it('waits for a seat whose page is on its way from the menu to the game', () => {
    const r = room(2);
    r.handle(1, { t: 'me', ready: true }, 0);
    r.handle(0, { t: 'start', grid: humans(0, 1), seed: 3 }, 0);
    // Both menus' sockets close as the pages change; the host's game page is back first.
    r.drop(0, 10);
    r.drop(1, 20);
    const token0 = r.state.seats[0].token;
    const token1 = r.state.seats[1].token;
    r.join({ ...hello('P0'), token: token0 }, 500);
    expect(r.handle(0, { t: 'loaded' }, 900)).toEqual([]);
    expect(r.phase).toBe('loading');
    r.join({ ...hello('P1'), token: token1 }, 1500);
    const out = r.handle(1, { t: 'loaded' }, 2500);
    expect(r.phase).toBe('racing');
    expect(last(out, 'go').grid).toHaveLength(2);
  });
  it('load timeout drops the laggard', () => {
    const r = room(3);
    r.handle(1, { t: 'me', ready: true }, 0);
    r.handle(2, { t: 'me', ready: true }, 0);
    r.handle(0, { t: 'start', grid: humans(0, 1, 2), seed: 1 }, 1000);
    r.handle(0, { t: 'loaded' }, 2000);
    r.handle(1, { t: 'loaded' }, 2000);
    expect(r.nextWake(2000)).toBe(1000 + LOAD_TIMEOUT);
    expect(r.tick(1000 + LOAD_TIMEOUT - 1)).toEqual([]);
    const out = r.tick(1000 + LOAD_TIMEOUT);
    expect(r.phase).toBe('racing');
    expect(r.state.seats.map((s) => s.id)).toEqual([0, 1]);
    expect(last(out, 'go').grid.map((g) => (g.kind === 'human' ? g.seat : -1))).toEqual([0, 1]);
  });
  it('st relays to others with from, only while racing', () => {
    const r = room(2);
    const car = { who: { seat: 0 } } as never;
    expect(r.handle(0, { t: 'st', at: 1, cars: [car] }, 0)).toEqual([]);
    const q = racing(2);
    const out = q.handle(0, { t: 'st', at: 5, cars: [car] }, 2000);
    expect(out).toEqual([{ to: 'others', from: 0, msg: { t: 'st', from: 0, at: 5, cars: [car] } }]);
    expect(q.handle(0, { t: 'st', at: 5, cars: Array(2 * MAX_SEATS + 1).fill(car) }, 2000)).toEqual([]);
  });
  it('fin: partial then final; first time only; AI only from host', () => {
    const r = racing(2, 1);
    let out = r.handle(1, { t: 'fin', who: { seat: 1 }, time: 70 }, 3000);
    expect(last(out, 'result')).toMatchObject({ final: false });
    expect(last(out, 'result').rows).toEqual([
      { who: { seat: 0 }, time: null },
      { who: { seat: 1 }, time: 70 },
      { who: { ai: 0 }, time: null },
    ]);
    expect(r.handle(1, { t: 'fin', who: { seat: 1 }, time: 10 }, 3100)).toEqual([]);
    expect(r.handle(1, { t: 'fin', who: { seat: 0 }, time: 10 }, 3100)).toEqual([]); // not own seat
    expect(r.handle(1, { t: 'fin', who: { ai: 0 }, time: 10 }, 3100)).toEqual([]); // guest
    r.handle(0, { t: 'fin', who: { ai: 0 }, time: 66 }, 3200);
    expect(r.phase).toBe('racing');
    out = r.handle(0, { t: 'fin', who: { seat: 0 }, time: 68 }, 3300);
    expect(last(out, 'result')).toMatchObject({ final: true });
    expect(r.phase).toBe('results');
    expect(last(out, 'room').phase).toBe('results');
  });
  it('finish timeout leaves null', () => {
    const r = racing(2);
    r.handle(0, { t: 'fin', who: { seat: 0 }, time: 60 }, 5000);
    expect(r.nextWake(5000)).toBe(5000 + FINISH_TIMEOUT);
    expect(r.tick(5000 + FINISH_TIMEOUT - 1)).toEqual([]);
    const out = r.tick(5000 + FINISH_TIMEOUT);
    const res = last(out, 'result');
    expect(res.final).toBe(true);
    expect(res.rows.find((x) => 'seat' in x.who && x.who.seat === 1)?.time).toBeNull();
    expect(r.phase).toBe('results');
  });
  it('a retired player ends the race; its result stays null', () => {
    const r = racing(2);
    r.handle(0, { t: 'fin', who: { seat: 0 }, time: 60 }, 5000);
    const out = r.handle(1, { t: 'leave' }, 6000);
    expect(last(out, 'result')).toMatchObject({ final: true });
    expect(last(out, 'result').rows[1].time).toBeNull();
  });
});

describe('drops and timers', () => {
  it('grace in the lobby, then the seat is gone and wake values are right', () => {
    const r = room(2);
    expect(r.drop(1, 1000)[0].msg.t).toBe('room');
    expect(r.nextWake(1000)).toBe(1000 + LOBBY_GRACE);
    expect(r.tick(1000 + LOBBY_GRACE - 1)).toEqual([]);
    expect(r.state.seats).toHaveLength(2);
    expect(last(r.tick(1000 + LOBBY_GRACE), 'room').seats).toHaveLength(1);
    expect(r.nextWake(0)).toBeNull();
  });
  it('grace while loading is short, while racing it lasts the race', () => {
    const l = room(2);
    l.handle(1, { t: 'me', ready: true }, 0);
    l.handle(0, { t: 'start', grid: humans(0, 1), seed: 1 }, 0);
    l.drop(1, 500);
    expect(l.nextWake(500)).toBe(Math.min(500 + LOAD_GRACE, LOAD_TIMEOUT));
    const r = racing(2);
    r.drop(1, 2000);
    expect(RACE_GRACE).toBeGreaterThanOrEqual(240_000);
    expect(r.nextWake(2000)).toBe(2000 + RACE_GRACE);
    r.tick(2000 + 60_000);
    expect(r.state.seats).toHaveLength(2);
    r.tick(2000 + RACE_GRACE);
    expect(r.state.seats).toHaveLength(1);
  });
  it('a seat back mid-race gets the start with where the room last saw everyone, and the times so far', () => {
    const r = racing(3, 1);
    const car = (who: any, s: number): CarState => ({ who, s, p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0], steer: 0, speed: 0, thr: 0, boost: 0 });
    r.handle(0, { t: 'st', at: 1, cars: [car({ seat: 0 }, 120), car({ ai: 0 }, 90), car({ seat: 1 }, 5)] }, 2000);
    r.handle(1, { t: 'st', at: 1, cars: [car({ seat: 1 }, 77), car({ seat: 0 }, 5000)] }, 2000);
    r.handle(2, { t: 'fin', who: { seat: 2 }, time: 55 }, 2500);
    const token = r.state.seats[1].token;
    r.drop(1, 3000);
    const j = r.join(hello('P1', token), 4000);
    expect(j.seat).toBe(1);
    const go = last(j.out, 'go');
    expect(go.resume).toEqual({ s0: 120, a0: 90, s1: 77 });
    expect(go.goAt).toBe(1000 + GO_DELAY);
    // times first, so a lobby page can tell this seat has finished before it sees `go`
    expect(j.out.findIndex((o) => o.msg.t === 'result')).toBeLessThan(j.out.findIndex((o) => o.msg.t === 'go'));
    expect(last(j.out, 'result').rows.find((x) => 'seat' in x.who && x.who.seat === 2)?.time).toBe(55);
    // a fresh start knows nothing of the old race
    expect(parseS2C(JSON.stringify(go))).toEqual(go);
  });
  it('a seat back after the end gets the final results; an offline seat that never finished still holds the race until the finish timeout', () => {
    const r = racing(2, 0);
    r.handle(0, { t: 'fin', who: { seat: 0 }, time: 60 }, 5000);
    const token = r.state.seats[1].token;
    r.drop(1, 6000);
    expect(r.phase).toBe('racing');
    expect(last(r.tick(5000 + FINISH_TIMEOUT), 'result').final).toBe(true);
    const j = r.join(hello('P1', token), 5000 + FINISH_TIMEOUT + 1);
    expect(j.seat).toBe(1);
    expect(last(j.out, 'result').final).toBe(true);
    expect(msgs(j.out, 'go')).toHaveLength(0);
  });
  it('the host is the one that reports the AI: still true after it dropped and came back', () => {
    const r = racing(2, 1);
    const token = r.state.seats[0].token;
    r.drop(0, 2000);
    expect(r.handle(1, { t: 'fin', who: { ai: 0 }, time: 70 }, 2100)).toEqual([]);
    r.join(hello('P0', token), 2200);
    expect(msgs(r.handle(0, { t: 'fin', who: { ai: 0 }, time: 71 }, 2300), 'result')).toHaveLength(1);
  });
  it('empty room expires', () => {
    const r = room(1);
    r.drop(0, 1000);
    expect(r.empty).toBe(true);
    expect(r.nextWake(1000)).toBe(1000 + LOBBY_GRACE);
    r.tick(1000 + LOBBY_GRACE);
    expect(r.nextWake(0)).toBe(1000 + EXPIRE_AFTER);
    expect(r.expired(1000 + EXPIRE_AFTER - 1)).toBe(false);
    expect(r.expired(1000 + EXPIRE_AFTER)).toBe(true);
  });
  it('ping answers the sender only', () => {
    const r = room(2);
    expect(r.handle(1, { t: 'ping', c: 3 }, 99)).toEqual([{ to: 1, msg: { t: 'pong', c: 3, s: 99 } }]);
  });
});

describe('results and state', () => {
  it('results go back to the lobby on host set or a ready', () => {
    for (const back of [(r: RoomLogic) => r.handle(0, { t: 'set', settings: { ...SET } }, 9000), (r: RoomLogic) => r.handle(1, { t: 'me', ready: false }, 9000)]) {
      const r = racing(2);
      r.handle(0, { t: 'fin', who: { seat: 0 }, time: 60 }, 5000);
      r.handle(1, { t: 'fin', who: { seat: 1 }, time: 61 }, 5000);
      expect(r.phase).toBe('results');
      const out = back(r);
      expect(r.phase).toBe('lobby');
      expect(last(out, 'room').seats.every((s) => !s.ready)).toBe(true);
      expect(r.state.grid).toEqual([]);
    }
  });
  it('state round-trips through JSON with identical behavior', () => {
    const a = racing(3, 1);
    a.handle(0, { t: 'fin', who: { seat: 0 }, time: 61 }, 4000);
    const b = new RoomLogic('ABCD', JSON.parse(JSON.stringify(a.state)) as RoomState);
    expect(b.state).toEqual(a.state);
    const run = (r: RoomLogic) => [
      r.handle(1, { t: 'fin', who: { seat: 1 }, time: 62 }, 4100),
      r.drop(2, 4200),
      r.tick(4200 + RACE_GRACE),
      r.nextWake(0),
      r.join(hello('Z', a.state.seats[0].token), 5),
    ];
    expect(run(b)).toEqual(run(a));
  });
  it('tokens come from the injected rand', () => {
    const r = new RoomLogic('ABCD', undefined, () => 0);
    r.join(hello(), 0);
    expect(r.state.seats[0].token).toBe('a'.repeat(16));
  });
});
