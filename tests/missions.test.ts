import { describe, expect, it } from 'vitest';
import { MISSIONS, Missions, pickMissions, progressText, type MissionEvent } from '../src/gameplay/missions';

const byId = (id: string) => MISSIONS.find((m) => m.id === id)!;
const trick = (kind: 'drift' | 'air' | 'nearMiss' | 'knock' | 'speed' | 'redLight', extra: Partial<{ cents: number; duration: number; chain: number }> = {}): MissionEvent => ({
  type: 'trick',
  kind,
  cents: 10,
  chain: 1,
  ...extra,
});

describe('missions', () => {
  it('has distinct ids and reachable goals', () => {
    expect(new Set(MISSIONS.map((m) => m.id)).size).toBe(MISSIONS.length);
    for (const m of MISSIONS) {
      expect(m.goal, m.id).toBeGreaterThan(0);
      expect(m.reward, m.id).toBeGreaterThan(0);
    }
  });

  it('picks 3 different missions, the same for the same seed', () => {
    const a = pickMissions(7);
    expect(a).toHaveLength(3);
    expect(new Set(a.map((m) => m.id)).size).toBe(3);
    expect(pickMissions(7).map((m) => m.id)).toEqual(a.map((m) => m.id));
    // Over many shifts every mission comes up.
    const seen = new Set(Array.from({ length: 200 }, (_, s) => pickMissions(s).map((m) => m.id)).flat());
    expect(seen.size).toBe(MISSIONS.length);
  });

  it('counts events and completes once', () => {
    const ms = new Missions([byId('nitro')]);
    for (let i = 0; i < 3; i++) expect(ms.feed({ type: 'nitro' })).toEqual([]);
    expect(progressText(ms.list[0])).toBe('3/4');
    expect(ms.feed({ type: 'nitro' }).map((m) => m.def.id)).toEqual(['nitro']);
    expect(ms.feed({ type: 'nitro' })).toEqual([]);
    expect(ms.completed).toHaveLength(1);
    expect(progressText(ms.list[0])).toBe('4/4');
  });

  it('a crash breaks the clean-delivery streak', () => {
    const ms = new Missions([byId('limpio')]);
    for (let i = 0; i < 5; i++) ms.feed({ type: 'fare', rating: 'ok' });
    ms.feed({ type: 'crash' });
    expect(ms.list[0].progress).toBe(0);
    for (let i = 0; i < 5; i++) ms.feed({ type: 'fare', rating: 'slow' });
    expect(ms.feed({ type: 'fare', rating: 'fast' })).toHaveLength(1);
  });

  it('a late arrival breaks the on-time streak; only fast ones count as "volando"', () => {
    const ms = new Missions([byId('puntual'), byId('volando')]);
    ms.feed({ type: 'arrive', rating: 'fast' });
    ms.feed({ type: 'arrive', rating: 'ok' });
    ms.feed({ type: 'arrive', rating: 'slow' });
    expect(ms.list.map((m) => m.progress)).toEqual([0, 1]);
  });

  it('a drift counts by its longest single slide, not the total', () => {
    const ms = new Missions([byId('derrape')]);
    ms.feed(trick('drift', { duration: 1.2 }));
    ms.feed(trick('drift', { duration: 1.5 }));
    expect(ms.list[0].done).toBe(false);
    expect(progressText(ms.list[0])).toBe('1.5/2 s');
    expect(ms.feed(trick('drift', { duration: 2.1 }))).toHaveLength(1);
  });

  it('tracks combos, close calls, knocks, top speed, red lights and trick money', () => {
    const ms = new Missions([byId('combo'), byId('justas'), byId('piruetas')]);
    for (let i = 1; i <= 5; i++) ms.feed(trick('nearMiss', { chain: i, cents: 15 * i }));
    expect(ms.list.every((m) => m.done)).toBe(true);
    expect(new Missions([byId('chuta')]).feed(trick('knock')).length).toBe(0);
    const fast = new Missions([byId('rapidazo')]);
    fast.feed(trick('speed'));
    fast.feed(trick('drift'));
    expect(fast.list[0].progress).toBe(1);
    const reds = new Missions([byId('rojos')]);
    for (let i = 0; i < 2; i++) reds.feed(trick('redLight'));
    expect(reds.feed(trick('nearMiss'))).toEqual([]);
    expect(reds.feed(trick('redLight')).map((m) => m.def.id)).toEqual(['rojos']);
    const money = new Missions([byId('piruetas')]);
    money.feed(trick('air', { cents: 40 }));
    expect(progressText(money.list[0])).toBe('$0.40/$1.00');
  });

  it('every mission in the pool can be completed from game events', () => {
    const events: MissionEvent[] = [
      { type: 'nitro' },
      { type: 'fare', rating: 'fast' },
      { type: 'arrive', rating: 'fast' },
      trick('drift', { duration: 3, chain: 5, cents: 100 }),
      trick('nearMiss'),
      trick('knock'),
      trick('speed'),
      trick('redLight'),
    ];
    const ms = new Missions(MISSIONS);
    for (let i = 0; i < 10; i++) for (const e of events) ms.feed(e);
    expect(ms.list.filter((m) => !m.done).map((m) => m.def.id)).toEqual([]);
  });
});
