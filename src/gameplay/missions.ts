import { Rng } from '../core/rng';
import type { Rating } from './routeGame';
import type { TrickKind } from './scoring';

/** What the shift reports to its missions (from RouteGame, TrickScorer and the nitro tank). */
export type MissionEvent =
  | { type: 'crash' }
  /** A scored trick; `chain` is the combo length after it. */
  | { type: 'trick'; kind: Exclude<TrickKind, 'crash'>; cents: number; duration?: number; chain: number }
  | { type: 'fare'; rating: Rating }
  | { type: 'arrive'; rating: Rating }
  /** A nitro burst started. */
  | { type: 'nitro' };

export interface MissionDef {
  id: string;
  /** Shown in the HUD and on the results screen. */
  text: string;
  goal: number;
  /** Bonus cents when it's done. */
  reward: number;
  /** How progress reads: a count, seconds, or money (cents). */
  unit?: 's' | '$';
  /** Progress after an event (may drop back, e.g. a crash breaks a streak). */
  next(progress: number, e: MissionEvent): number;
}

const counting = (test: (e: MissionEvent) => boolean) => (p: number, e: MissionEvent) => (test(e) ? p + 1 : p);
const isTrick = (kind: TrickKind) => (e: MissionEvent) => e.type === 'trick' && e.kind === kind;

/** Every mission is built on events the game reliably detects. */
export const MISSIONS: MissionDef[] = [
  {
    id: 'limpio',
    text: 'Entrega 6 pasajeros sin chocar',
    goal: 6,
    reward: 75,
    next: (p, e) => (e.type === 'crash' ? 0 : e.type === 'fare' ? p + 1 : p),
  },
  { id: 'volando', text: 'Llega volando a 3 paradas', goal: 3, reward: 60, next: counting((e) => e.type === 'arrive' && e.rating === 'fast') },
  {
    id: 'puntual',
    text: '4 paradas seguidas sin atrasarte',
    goal: 4,
    reward: 50,
    next: (p, e) => (e.type !== 'arrive' ? p : e.rating === 'slow' ? 0 : p + 1),
  },
  { id: 'contentos', text: 'Deja 4 pasajeros volando', goal: 4, reward: 60, next: counting((e) => e.type === 'fare' && e.rating === 'fast') },
  {
    id: 'derrape',
    text: 'Haz un derrape de 2 s',
    goal: 2,
    reward: 50,
    unit: 's',
    next: (p, e) => (e.type === 'trick' && e.kind === 'drift' ? Math.max(p, e.duration ?? 0) : p),
  },
  { id: 'nitro', text: 'Usa el nitro 4 veces', goal: 4, reward: 40, next: counting((e) => e.type === 'nitro') },
  { id: 'justas', text: '5 pasadas con las justas', goal: 5, reward: 60, next: counting(isTrick('nearMiss')) },
  { id: 'combo', text: 'Arma un combo ×4', goal: 4, reward: 60, next: (p, e) => (e.type === 'trick' ? Math.max(p, e.chain) : p) },
  { id: 'chuta', text: 'Tumba 5 conos o tachos', goal: 5, reward: 30, next: counting(isTrick('knock')) },
  // A "Rapidazo" is scored every 2 s above 80 km/h.
  { id: 'rapidazo', text: 'Anda 6 s a más de 80 km/h', goal: 3, reward: 50, next: counting(isTrick('speed')) },
  {
    id: 'piruetas',
    text: 'Gana $1.00 en acrobacias',
    goal: 100,
    reward: 50,
    unit: '$',
    next: (p, e) => (e.type === 'trick' ? p + e.cents : p),
  },
];

export const MISSIONS_PER_SHIFT = 3;

/** `count` different missions for a shift, drawn from the pool by `seed`. */
export function pickMissions(seed: number, count = MISSIONS_PER_SHIFT, pool: MissionDef[] = MISSIONS): MissionDef[] {
  const rng = new Rng(seed);
  const left = [...pool];
  const out: MissionDef[] = [];
  while (out.length < count && left.length) out.push(left.splice(Math.floor(rng.next() * left.length), 1)[0]);
  return out;
}

export interface MissionState {
  def: MissionDef;
  progress: number;
  done: boolean;
}

/** "3/6", "1.2/2 s", "$0.40/$1.00". */
export function progressText(m: MissionState): string {
  const { goal, unit } = m.def;
  const p = Math.min(m.progress, goal);
  if (unit === 's') return `${p.toFixed(1)}/${goal} s`;
  if (unit === '$') return `$${(p / 100).toFixed(2)}/$${(goal / 100).toFixed(2)}`;
  return `${Math.floor(p)}/${goal}`;
}

/** A shift's missions: fed session events, they say when one is done (once). Engine-agnostic. */
export class Missions {
  readonly list: MissionState[];

  constructor(defs: MissionDef[]) {
    this.list = defs.map((def) => ({ def, progress: 0, done: false }));
  }

  /** Missions completed by this event. */
  feed(e: MissionEvent): MissionState[] {
    const out: MissionState[] = [];
    for (const m of this.list) {
      if (m.done) continue;
      m.progress = m.def.next(m.progress, e);
      if (m.progress >= m.def.goal) {
        m.done = true;
        out.push(m);
      }
    }
    return out;
  }

  get completed(): MissionState[] {
    return this.list.filter((m) => m.done);
  }
}
