import { Rng } from '../core/rng';
import { MAX_RIVALS, parseRivalChoice, rivalVehicles } from '../gameplay/raceField';
import { type GridEntry, MAX_SEATS, type Racer, type RoomSettings, type Seat, racerKey } from './protocol';

/**
 * The grid of an online race, built by the host and sent with `start` (pure; the seed makes it
 * repeatable): the AI rivals in front (as many as asked, up to the free places), then the
 * players in an order shuffled by the seed. Every client turns it into the same slots with
 * `gridSlots`, front to back, slot i for entry i.
 */
export function buildGrid(seats: readonly Seat[], settings: RoomSettings, vehicles: readonly string[], seed: number): GridEntry[] {
  const rng = new Rng(seed);
  const humans = seats.filter((s) => s.online).sort((a, b) => a.id - b.id);
  for (let i = humans.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [humans[i], humans[j]] = [humans[j], humans[i]];
  }
  const host = seats.find((s) => s.host) ?? humans[0];
  const n = Math.max(0, Math.min(settings.ai, MAX_SEATS - humans.length, MAX_RIVALS));
  const ai = rivalVehicles(parseRivalChoice(settings.rivalBus, vehicles), host?.vehicle ?? vehicles[0], n, vehicles, () => rng.next());
  return [...ai.map((vehicle, idx): GridEntry => ({ kind: 'ai', idx, vehicle, crew: idx })), ...humans.map((s): GridEntry => ({ kind: 'human', seat: s.id, vehicle: s.vehicle }))];
}

/** Who a grid entry is, as the protocol names racers. */
export function racerOf(g: GridEntry): Racer {
  return g.kind === 'human' ? { seat: g.seat } : { ai: g.idx };
}

/** The grid index of `seat`'s entry, -1 when it isn't on the grid. */
export function mySlot(grid: readonly GridEntry[], seat: number | null): number {
  return grid.findIndex((g) => g.kind === 'human' && g.seat === seat);
}

/** The racer keys of a grid, for matching the server's results to racers. */
export function gridKeys(grid: readonly GridEntry[]): string[] {
  return grid.map((g) => racerKey(racerOf(g)));
}
