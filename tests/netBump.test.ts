import { describe, expect, it } from 'vitest';
import { BUMP_MAX_J, PROTO, parseC2S, parseS2C, type C2S, type GridEntry } from '../src/net/protocol';
import { BUMPS_PER_SEC, RoomLogic } from '../server/src/room';

const hello = (name: string): Extract<C2S, { t: 'hello' }> => ({ t: 'hello', v: PROTO, name, vehicle: 'bus' });
const bump = (from: object, to: object, j: [number, number] = [5000, -200]) => ({ t: 'bump', from, to, j, at: [1, 0.5, 2] }) as C2S;

/** Seats 0 (host) and 1 racing with one AI. */
function racing() {
  const r = new RoomLogic('ABCD');
  r.join(hello('A'), 0);
  r.join(hello('B'), 0);
  r.handle(1, { t: 'me', ready: true }, 0);
  const grid: GridEntry[] = [{ kind: 'human', seat: 0, vehicle: 'bus' }, { kind: 'human', seat: 1, vehicle: 'bus' }, { kind: 'ai', idx: 0, vehicle: 'bus', crew: 0 }];
  r.handle(0, { t: 'start', grid, seed: 1 }, 0);
  r.handle(0, { t: 'loaded' }, 100);
  r.handle(1, { t: 'loaded' }, 100);
  return r;
}

describe('bump message', () => {
  it('parses with only its own fields, and refuses nonsense', () => {
    const ok = parseC2S(JSON.stringify({ ...bump({ seat: 0 }, { ai: 1 }), extra: 'x' }));
    expect(ok).toEqual({ t: 'bump', from: { seat: 0 }, to: { ai: 1 }, j: [5000, -200], at: [1, 0.5, 2] });
    expect(parseC2S(JSON.stringify(bump({ seat: 0 }, { seat: 1 }, [BUMP_MAX_J * 2, 0])))).toBeNull();
    expect(parseC2S(JSON.stringify({ t: 'bump', from: { seat: 0 }, to: { seat: 1 }, j: [1], at: [0, 0, 0] }))).toBeNull();
    expect(parseC2S(JSON.stringify({ t: 'bump', from: { seat: 0 }, to: 'x', j: [1, 1], at: [0, 0, 0] }))).toBeNull();
    expect(parseC2S('{"t":"bump","from":{"seat":0},"to":{"seat":1},"j":[1,null],"at":[0,0,0]}')).toBeNull();
    expect(parseS2C(JSON.stringify(bump({ seat: 0 }, { seat: 1 })))).toMatchObject({ t: 'bump', to: { seat: 1 } });
  });

  it('is relayed only to the seat that simulates the target', () => {
    const r = racing();
    const out = r.handle(0, bump({ seat: 0 }, { seat: 1 }), 1000);
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe(1);
    expect(out[0].msg).toMatchObject({ t: 'bump', from: { seat: 0 }, to: { seat: 1 }, j: [5000, -200] });
  });

  it('an AI belongs to the host: a guest hitting it reaches the host, the host\'s AI hitting a guest is allowed, a guest\'s "AI" is not', () => {
    const r = racing();
    expect(r.handle(1, bump({ seat: 1 }, { ai: 0 }), 1000)[0].to).toBe(0);
    expect(r.handle(0, bump({ ai: 0 }, { seat: 1 }), 1000)[0].to).toBe(1);
    expect(r.handle(1, bump({ ai: 0 }, { seat: 0 }), 1000)).toEqual([]);
  });

  it('drops what is not the sender\'s own, to itself, to nobody, outside a race, or too fast', () => {
    const r = racing();
    expect(r.handle(1, bump({ seat: 0 }, { seat: 1 }), 1000)).toEqual([]);
    expect(r.handle(0, bump({ seat: 0 }, { seat: 0 }), 1000)).toEqual([]);
    expect(r.handle(0, bump({ seat: 0 }, { seat: 5 }), 1000)).toEqual([]);
    let relayed = 0;
    for (let i = 0; i < BUMPS_PER_SEC + 10; i++) relayed += r.handle(0, bump({ seat: 0 }, { seat: 1 }), 5000 + i).length;
    expect(relayed).toBe(BUMPS_PER_SEC);
    expect(r.handle(0, bump({ seat: 0 }, { seat: 1 }), 6000)).toHaveLength(1);
    const lobby = new RoomLogic('WXYZ');
    lobby.join(hello('A'), 0);
    lobby.join(hello('B'), 0);
    expect(lobby.handle(0, bump({ seat: 0 }, { seat: 1 }), 0)).toEqual([]);
  });

  it('a seat that is offline gets nothing', () => {
    const r = racing();
    r.drop(1, 2000);
    expect(r.handle(0, bump({ seat: 0 }, { seat: 1 }), 2100)).toEqual([]);
  });
});
