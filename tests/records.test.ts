import { describe, expect, it } from 'vitest';
import { TOP_N, loadRecords, recordMissions, recordShift, routeRecords, type ShiftRecord } from '../src/gameplay/records';
import type { KeyValueStore } from '../src/menu/settings';

const memory = (init: Record<string, string> = {}): KeyValueStore & { raw: Map<string, string> } => {
  const raw = new Map(Object.entries(init));
  return { raw, getItem: (k) => raw.get(k) ?? null, setItem: (k, v) => void raw.set(k, v) };
};

const shift = (cents: number, extra: Partial<ShiftRecord> = {}): ShiftRecord => ({ cents, delivered: 3, bestCombo: 2, stars: 1, bus: 'popular', date: 1000, ...extra });

describe('records', () => {
  it('starts empty', () => {
    expect(loadRecords(memory())).toEqual({ routes: {}, missions: {} });
    expect(routeRecords('mariscal', 'circuito', memory())).toBeNull();
  });

  it('the first shift is a record; a better one beats it, a worse one places below', () => {
    const store = memory();
    const first = recordShift('mariscal', 'circuito', shift(200), store);
    expect(first).toMatchObject({ rank: 0, newRecord: true, newStars: true });
    const worse = recordShift('mariscal', 'circuito', shift(150, { stars: 0 }), store);
    expect(worse).toMatchObject({ rank: 1, newRecord: false, newStars: false });
    const tie = recordShift('mariscal', 'circuito', shift(200), store);
    expect(tie).toMatchObject({ rank: 1, newRecord: false });
    const better = recordShift('mariscal', 'circuito', shift(300, { stars: 3 }), store);
    expect(better).toMatchObject({ rank: 0, newRecord: true, newStars: true });
    expect(routeRecords('mariscal', 'circuito', store)!.top.map((s) => s.cents)).toEqual([300, 200, 200, 150]);
    expect(routeRecords('mariscal', 'circuito', store)!.stars).toBe(3);
  });

  it('keeps only the top 5 per route, and routes apart', () => {
    const store = memory();
    for (const c of [10, 50, 30, 70, 20, 60, 40]) recordShift('mariscal', 'circuito', shift(c), store);
    const off = recordShift('mariscal', 'circuito', shift(5), store);
    expect(off.rank).toBe(-1);
    expect(routeRecords('mariscal', 'circuito', store)!.top.map((s) => s.cents)).toEqual([70, 60, 50, 40, 30]);
    expect(routeRecords('mariscal', 'circuito', store)!.top).toHaveLength(TOP_N);
    expect(routeRecords('grid', 'circuito', store)).toBeNull();
    expect(recordShift('grid', 'circuito', shift(1), store).newRecord).toBe(true);
  });

  it('remembers the best stars even after that shift drops off the table', () => {
    const store = memory();
    recordShift('grid', 'circuito', shift(10, { stars: 2 }), store);
    for (let i = 0; i < TOP_N; i++) recordShift('grid', 'circuito', shift(100 + i, { stars: 1 }), store);
    const r = routeRecords('grid', 'circuito', store)!;
    expect(r.top.every((s) => s.stars === 1)).toBe(true);
    expect(r.stars).toBe(2);
  });

  it('a shift with no money is never a record', () => {
    expect(recordShift('grid', 'circuito', shift(0), memory()).newRecord).toBe(false);
  });

  it('counts completed missions', () => {
    const store = memory();
    recordMissions(['nitro', 'combo'], store);
    expect(recordMissions(['nitro'], store)).toEqual({ nitro: 2, combo: 1 });
    expect(loadRecords(store).missions).toEqual({ nitro: 2, combo: 1 });
  });

  it('survives corrupt or foreign data', () => {
    for (const bad of ['{not json', 'null', '42', '"x"', '[]', JSON.stringify({ v: 99, routes: { 'a/b': { top: [shift(5)], stars: 1 } } })]) {
      const store = memory({ 'qbus.records': bad });
      expect(loadRecords(store), bad).toEqual({ routes: {}, missions: {} });
      // And can be written over.
      expect(recordShift('a', 'b', shift(5), store).newRecord).toBe(true);
    }
    const messy = memory({
      'qbus.records': JSON.stringify({
        v: 2,
        routes: {
          'a/b': { top: [shift(5), { cents: 'lots' }, null, { ...shift(9), stars: 7, delivered: -3 }, shift(NaN)], stars: 'many' },
          'a/c': 'nope',
        },
        missions: { nitro: 2, combo: -1, x: 'y' },
      }),
    });
    const r = loadRecords(messy);
    expect(r.routes['a/b'].top.map((s) => s.cents)).toEqual([9, 5]);
    expect(r.routes['a/b'].top[0]).toMatchObject({ stars: 3, delivered: 0 });
    expect(r.routes['a/b'].stars).toBe(3);
    expect(r.routes['a/c']).toBeUndefined();
    expect(r.missions).toEqual({ nitro: 2 });
  });

  it('keeps version 1 shifts and missions, but forgets the stars won against the old, easy targets', () => {
    const store = memory({
      'qbus.records': JSON.stringify({ v: 1, routes: { 'a/b': { top: [shift(400, { stars: 3 }), shift(90, { stars: 1 })], stars: 3 } }, missions: { nitro: 2 } }),
    });
    const r = loadRecords(store);
    expect(r.routes['a/b'].top.map((s) => [s.cents, s.stars])).toEqual([
      [400, 0],
      [90, 0],
    ]);
    expect(r.routes['a/b'].stars).toBe(0);
    expect(r.missions).toEqual({ nitro: 2 });
    // The next shift saves as version 2: earned stars count again.
    expect(recordShift('a', 'b', shift(100, { stars: 1 }), store).newStars).toBe(true);
    expect(loadRecords(store).routes['a/b'].stars).toBe(1);
  });

  it('a store that refuses writes loses nothing but the save', () => {
    const store: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(recordShift('a', 'b', shift(5), store).rank).toBe(0);
    expect(() => recordMissions(['nitro'], store)).not.toThrow();
  });
});
