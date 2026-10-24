import { describe, expect, it } from 'vitest';
import { bestOnline, bestOnlineLap, recordOnline, recordOnlineLap, settleOnlinePlace } from '../src/gameplay/onlineRecords';

function stub(initial?: string) {
  const m = new Map<string, string>();
  if (initial !== undefined) m.set('qbus.onlineRecords', initial);
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const rec = (time: number, over: object = {}) => ({ time, bus: 'Popular', place: 2, racers: 4, ...over });

describe('online records', () => {
  it('keeps the best time per track, with bus, date, place and field', () => {
    const s = stub();
    expect(bestOnline('papallacta', s)).toBeNull();
    expect(recordOnline('papallacta', rec(200), s, '2026-10-22')).toBe(true);
    expect(bestOnline('papallacta', s)).toEqual({ time: 200, bus: 'Popular', date: '2026-10-22', place: 2, racers: 4 });
    expect(recordOnline('papallacta', rec(210), s)).toBe(false);
    expect(recordOnline('papallacta', rec(200), s)).toBe(false);
    expect(recordOnline('papallacta', rec(190, { place: 1, bus: 'Gusanito' }), s, '2026-10-23')).toBe(true);
    expect(bestOnline('papallacta', s)).toMatchObject({ time: 190, place: 1, bus: 'Gusanito', date: '2026-10-23' });
    expect(recordOnline('silante', rec(300), s)).toBe(true);
    expect(bestOnline('papallacta', s)?.time).toBe(190);
  });
  it('only a real time counts', () => {
    const s = stub();
    for (const bad of [rec(NaN), rec(0), rec(-3), rec(Infinity), rec(100, { place: 0 }), rec(100, { place: 5 }), rec(100, { racers: 1.5 }), rec(100, { bus: 3 })]) expect(recordOnline('papallacta', bad as any, s)).toBe(false);
    expect(bestOnline('papallacta', s)).toBeNull();
  });
  it('corrupt or other-version data is dropped, never thrown', () => {
    for (const j of ['{', 'null', '[]', '{"version":2,"tracks":{}}', '{"version":1}', '{"version":1,"tracks":{"p":{"time":"x"}}}', '{"version":1,"tracks":5}']) {
      const s = stub(j);
      expect(bestOnline('p', s)).toBeNull();
      expect(recordOnline('p', rec(100), s)).toBe(true);
      expect(bestOnline('p', s)?.time).toBe(100);
    }
    expect(bestOnline('p', null)).toBeNull();
    expect(recordOnline('p', rec(100), null)).toBe(true);
    const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    expect(() => recordOnline('p', rec(100), full)).not.toThrow();
  });
  it('one bad track entry does not take the others with it', () => {
    const s = stub(JSON.stringify({ version: 1, tracks: { a: { time: 'x' }, b: { time: 90, bus: 'B', date: 'd', place: 1, racers: 2 } } }));
    expect(bestOnline('a', s)).toBeNull();
    expect(bestOnline('b', s)?.time).toBe(90);
  });
  it('the final results settle the place of the record just made', () => {
    const s = stub();
    recordOnline('p', rec(100, { place: 2, racers: 4 }), s);
    settleOnlinePlace('p', 99, 1, s); // another time: ignored
    expect(bestOnline('p', s)?.place).toBe(2);
    settleOnlinePlace('p', 100, 3, s);
    expect(bestOnline('p', s)?.place).toBe(3);
    settleOnlinePlace('p', 100, 9, s);
    expect(bestOnline('p', s)?.place).toBe(3);
  });
  it('keeps the best lap apart from the best time; old saves have none', () => {
    const s = stub(JSON.stringify({ version: 1, tracks: { zonarosa: { time: 150, bus: 'Popular', date: '2026-01-01', place: 1, racers: 2 } } }));
    expect(bestOnlineLap('zonarosa', s)).toBeNull();
    expect(recordOnlineLap('zonarosa', 48, s)).toBe(true);
    expect(recordOnlineLap('zonarosa', 49, s)).toBe(false);
    expect(bestOnline('zonarosa', s)?.time).toBe(150);
    expect(recordOnline('zonarosa', rec(140), s)).toBe(true);
    expect(bestOnlineLap('zonarosa', s)).toBe(48);
    settleOnlinePlace('zonarosa', 140, 1, s);
    expect(bestOnlineLap('zonarosa', s)).toBe(48);
    expect(recordOnlineLap('zonarosa', NaN, s)).toBe(false);
  });
});
