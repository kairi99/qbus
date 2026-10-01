import type { KeyValueStore } from '../menu/settings';

/** One finished shift, as kept in the high-score table. */
export interface ShiftRecord {
  cents: number;
  delivered: number;
  bestCombo: number;
  stars: number;
  /** Bus driven (records are per route, whatever the bus). */
  bus: string;
  /** When it was driven, ms since the epoch. */
  date: number;
}

export interface RouteRecords {
  /** Best shifts first, at most TOP_N. */
  top: ShiftRecord[];
  /** Most stars ever earned on the route. */
  stars: number;
}

export interface Records {
  /** Keyed by routeKey(zone, route). */
  routes: Record<string, RouteRecords>;
  /** Missions completed, by mission id (how many times). */
  missions: Record<string, number>;
}

/** Where a shift landed in its route's table. */
export interface Placing {
  /** 0-based place in the top list, or -1 if it didn't make it. */
  rank: number;
  /** Best money ever on the route (and there was a best to beat, or it's the first shift). */
  newRecord: boolean;
  /** More stars than ever before on the route. */
  newStars: boolean;
  route: RouteRecords;
}

export const TOP_N = 5;
const KEY = 'qbus.records';
/** Bumped if the stored shape changes; an unknown version starts over. */
const VERSION = 1;

export const routeKey = (zone: string, route: string) => `${zone}/${route}`;

const empty = (): Records => ({ routes: {}, missions: {} });
const count = (v: unknown, max = 1e7) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : null);

function cleanShift(v: unknown): ShiftRecord | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const cents = count(o.cents);
  if (cents === null) return null;
  return {
    cents,
    delivered: count(o.delivered) ?? 0,
    bestCombo: count(o.bestCombo) ?? 0,
    stars: count(o.stars, 3) ?? 0,
    bus: typeof o.bus === 'string' ? o.bus : '',
    date: count(o.date, 1e14) ?? 0,
  };
}

/** Saved records; anything missing, corrupt or from another version is dropped, never thrown. */
export function loadRecords(store: KeyValueStore = localStorage): Records {
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(KEY) ?? 'null');
  } catch {
    return empty();
  }
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== VERSION) return empty();
  const out = empty();
  const { routes, missions } = raw as Record<string, unknown>;
  if (routes && typeof routes === 'object') {
    for (const [k, r] of Object.entries(routes as Record<string, unknown>)) {
      if (!r || typeof r !== 'object') continue;
      const list = (r as { top?: unknown }).top;
      const top = (Array.isArray(list) ? list : [])
        .map(cleanShift)
        .filter((s): s is ShiftRecord => !!s)
        .sort((a, b) => b.cents - a.cents)
        .slice(0, TOP_N);
      const stars = Math.max(count((r as { stars?: unknown }).stars, 3) ?? 0, ...top.map((s) => s.stars));
      if (top.length || stars) out.routes[k] = { top, stars };
    }
  }
  if (missions && typeof missions === 'object') {
    for (const [id, n] of Object.entries(missions as Record<string, unknown>)) {
      const c = count(n);
      if (c) out.missions[id] = c;
    }
  }
  return out;
}

function save(r: Records, store: KeyValueStore): void {
  try {
    store.setItem(KEY, JSON.stringify({ ...r, v: VERSION }));
  } catch {
    // Storage full or blocked (private mode): records just don't persist.
  }
}

/** Best results on a route, or null if it was never finished. */
export function routeRecords(zone: string, route: string, store: KeyValueStore = localStorage): RouteRecords | null {
  return loadRecords(store).routes[routeKey(zone, route)] ?? null;
}

/** Saves a finished shift to its route's table; says where it placed. */
export function recordShift(zone: string, route: string, shift: ShiftRecord, store: KeyValueStore = localStorage): Placing {
  const all = loadRecords(store);
  const key = routeKey(zone, route);
  const before = all.routes[key] ?? { top: [], stars: 0 };
  // Ties keep the older shift ahead.
  const top = [...before.top, shift].sort((a, b) => b.cents - a.cents).slice(0, TOP_N);
  const rank = top.indexOf(shift);
  const after = { top, stars: Math.max(before.stars, shift.stars) };
  all.routes[key] = after;
  save(all, store);
  return {
    rank,
    newRecord: rank === 0 && shift.cents > 0 && (before.top.length === 0 || shift.cents > before.top[0].cents),
    newStars: shift.stars > before.stars,
    route: after,
  };
}

/** Counts completed missions (by id). */
export function recordMissions(ids: string[], store: KeyValueStore = localStorage): Records['missions'] {
  const all = loadRecords(store);
  for (const id of ids) all.missions[id] = (all.missions[id] ?? 0) + 1;
  if (ids.length) save(all, store);
  return all.missions;
}
