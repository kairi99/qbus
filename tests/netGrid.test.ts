import { describe, expect, it } from 'vitest';
import { buildGrid, gridKeys, mySlot, racerOf } from '../src/net/onlineGrid';
import type { RoomSettings, Seat } from '../src/net/protocol';

const seat = (id: number, vehicle = 'popular', host = false): Seat => ({ id, name: `P${id}`, vehicle, ready: true, host, online: true });
const IDS = ['popular', 'interparroquial', 'buseta', 'articulado', 'gusanito', 'ae86'];
const settings = (ai: number, rivalBus = 'mixed'): RoomSettings => ({ track: 'papallacta', ai, skill: 'normal', rivalBus, rain: 'random', tod: 'day', slides: true });

describe('online grid', () => {
  it('AI in front, then every player, the same for the same seed', () => {
    const seats = [seat(0, 'ae86', true), seat(1), seat(2, 'buseta')];
    const g = buildGrid(seats, settings(1), IDS, 99);
    expect(g.map((e) => e.kind)).toEqual(['ai', 'human', 'human', 'human']);
    expect(g.filter((e) => e.kind === 'human').map((e) => (e.kind === 'human' ? e.seat : -1)).sort()).toEqual([0, 1, 2]);
    expect(buildGrid(seats, settings(1), IDS, 99)).toEqual(g);
    // Each player drives what they picked.
    for (const e of g) if (e.kind === 'human') expect(e.vehicle).toBe(seats[e.seat].vehicle);
  });

  it('the seed shuffles the players', () => {
    const seats = [seat(0, 'popular', true), seat(1), seat(2), seat(3)];
    const orders = new Set(Array.from({ length: 12 }, (_, s) => gridKeys(buildGrid(seats, settings(0), IDS, s)).join()));
    expect(orders.size).toBeGreaterThan(3);
  });

  it('no more AI than free places; crews in order; offline seats left out', () => {
    const seats = [seat(0, 'popular', true), seat(1), { ...seat(2), online: false }];
    const g = buildGrid(seats, settings(5), IDS, 5);
    expect(g.filter((e) => e.kind === 'ai')).toHaveLength(4);
    expect(g.filter((e) => e.kind === 'human')).toHaveLength(2);
    expect(g.slice(0, 4).map((e) => (e.kind === 'ai' ? [e.idx, e.crew] : null))).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    // "Lo mismo que los panas": the host's vehicle.
    const same = buildGrid([seat(0, 'gusanito', true), seat(1)], settings(2, 'same'), IDS, 5);
    expect(same.filter((e) => e.kind === 'ai').map((e) => e.vehicle)).toEqual(['gusanito', 'gusanito']);
  });

  it('six seats: five AI in front of one player, or two players and four AI, crews in order', () => {
    const solo = buildGrid([seat(0, 'popular', true)], settings(5), IDS, 8);
    expect(solo).toHaveLength(6);
    expect(solo.slice(0, 5).map((e) => (e.kind === 'ai' ? e.crew : -1))).toEqual([0, 1, 2, 3, 4]);
    // Mixed: each AI a different vehicle, none the host's.
    const vs = solo.slice(0, 5).map((e) => e.vehicle);
    expect(new Set(vs).size).toBe(5);
    expect(vs).not.toContain('popular');
    const two = buildGrid([seat(0, 'popular', true), seat(1)], settings(5), IDS, 8);
    expect(two.filter((e) => e.kind === 'ai')).toHaveLength(4);
    const full = buildGrid([0, 1, 2, 3, 4, 5].map((i) => seat(i, 'popular', i === 0)), settings(5), IDS, 8);
    expect(full.filter((e) => e.kind === 'ai')).toHaveLength(0);
    expect(full).toHaveLength(6);
  });

  it('keys, racers and a seat\'s slot', () => {
    const g = buildGrid([seat(0, 'popular', true), seat(1)], settings(1), IDS, 3);
    expect(gridKeys(g)[0]).toBe('a0');
    expect(racerOf(g[0])).toEqual({ ai: 0 });
    const i = mySlot(g, 1);
    expect(g[i]).toMatchObject({ kind: 'human', seat: 1 });
    expect(mySlot(g, 7)).toBe(-1);
  });
});
