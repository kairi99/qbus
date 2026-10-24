import { describe, expect, it } from 'vitest';
import { bestLapRecord, bestRace, recordLap, recordRace } from '../src/gameplay/raceRecords';

function stub(initial?: string) {
  const m = new Map<string, string>();
  if (initial !== undefined) m.set('qbus.raceRecords', initial);
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('solo race records: laps', () => {
  it('the best lap is kept apart from the best time', () => {
    const s = stub();
    expect(bestLapRecord('zonarosa', s)).toBeNull();
    expect(recordLap('zonarosa', 45, s)).toBe(true);
    expect(bestRace('zonarosa', s)).toBeNull();
    expect(recordRace('zonarosa', 140, 'Popular', s)).toBe(true);
    expect(bestLapRecord('zonarosa', s)).toBe(45);
    expect(recordLap('zonarosa', 46, s)).toBe(false);
    expect(recordLap('zonarosa', 44.2, s)).toBe(true);
    expect(recordRace('zonarosa', 150, 'Popular', s)).toBe(false);
    expect(bestRace('zonarosa', s)?.time).toBe(140);
    expect(bestLapRecord('zonarosa', s)).toBe(44.2);
    expect(bestLapRecord('papallacta', s)).toBeNull();
  });
  it('old saves without laps load fine and keep their time', () => {
    const s = stub(JSON.stringify({ version: 1, tracks: { papallacta: { time: 230, bus: 'Popular', date: '2026-01-01' } } }));
    expect(bestLapRecord('papallacta', s)).toBeNull();
    expect(bestRace('papallacta', s)?.time).toBe(230);
    expect(recordLap('papallacta', 50, s)).toBe(true);
    expect(bestRace('papallacta', s)?.time).toBe(230);
  });
  it('not a real lap time: nothing kept', () => {
    const s = stub();
    expect(recordLap('x', NaN, s)).toBe(false);
    expect(recordLap('x', 0, s)).toBe(false);
    expect(bestLapRecord('x', s)).toBeNull();
  });
});
