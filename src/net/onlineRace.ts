import type { RAPIER } from '../physics/world';
import type { BusPhysics } from '../vehicle/bus';
import type { BusPreset } from '../vehicle/busPreset';
import { busById } from '../vehicle/buses';
import type { RoadPose } from '../world/roadSnap';
import { type TrackData, locateOnTrack } from '../world/track';
import { CREWS, gridSlots } from '../gameplay/raceField';
import type { RaceSession, RemoteEntry } from '../gameplay/raceSession';
import { RoomConnection, clearSession } from './connection';
import { type CarState, type GridEntry, type Racer, type S2C, type Seat, racerKey } from './protocol';
import { RemoteBus } from './remoteBus';
import { carState } from './snapshots';
import { gridKeys, mySlot, racerOf } from './onlineGrid';
import { AI_COLOR, seatColor } from './colors';
import { type Life, remoteLife } from './live';

/** Snapshots sent per second (the player's bus, and the host's AI). */
export const SNAP_HZ = 15;

type Go = Extract<S2C, { t: 'go' }>;

export interface Joined {
  conn: RoomConnection;
  go: Go;
  /** The room's seats when the race started (names, who is host). */
  seats: Seat[];
}

const FAILED: Record<string, string> = {
  rejected: 'No se pudo volver a la sala',
  closed: 'Se perdió la conexión con la sala',
};

/**
 * The game page's way into an online race: reconnects to the room with the seat's token (the
 * menu's socket closed with the page), says the track is loaded, and waits for the server's
 * `go` (everyone loaded) behind a "waiting for the others" card. A dead connection shows why,
 * with a way back to the menu.
 */
export function joinOnline(code: string, hello: { name: string; vehicle: string; token: string }, root: HTMLElement): Promise<Joined> {
  const card = document.createElement('div');
  card.className = 'ol-wait';
  card.innerHTML = `<p data-k="text">Esperando a los panas…</p><button class="gh-btn" data-act="menu" hidden>Volver al menú</button>`;
  root.appendChild(card);
  const text = card.querySelector<HTMLElement>('[data-k="text"]')!;
  const back = card.querySelector<HTMLElement>('[data-act="menu"]')!;
  back.addEventListener('click', () => {
    clearSession();
    location.search = '';
  });
  const conn = new RoomConnection(code, hello);
  let seats: Seat[] = [];
  let done = false;
  return new Promise((resolve) => {
    conn.on('welcome', () => conn.send({ t: 'loaded' }));
    conn.on('room', (m) => (seats = m.seats));
    conn.on('go', (go) => {
      // The server sends `go` again when a seat is reclaimed mid-race: the first one is the one.
      if (done) return;
      done = true;
      card.remove();
      conn.onState = null;
      resolve({ conn, go, seats });
    });
    conn.onState = (st) => {
      if (st === 'connecting') text.textContent = 'Reconectando…';
      if (st === 'open') text.textContent = 'Esperando a los panas…';
      if (FAILED[st]) {
        text.textContent = FAILED[st];
        back.hidden = false;
      }
    };
  });
}

/** One grid entry's racer, out of a key ('s0', 'a1'). */
function racerFromKey(key: string): Racer {
  const n = Number(key.slice(1));
  return key[0] === 's' ? { seat: n } : { ai: n };
}

/**
 * An online race from the client's side, owned by main: the grid's slots, which racers run here
 * (the player, and the AI when this client is the host) and which are remote buses (the other
 * players, and the AI elsewhere), snapshots out at SNAP_HZ and in to the remotes, the shared
 * clock's GO, finish times out and the server's results in.
 */
export class OnlineRace {
  readonly grid: GridEntry[];
  readonly slots: RoadPose[];
  /** The player's index in the grid. */
  readonly me: number;
  readonly host: boolean;
  /** The AI simulated here: vehicle and slot each, in crew order (the host's only). */
  readonly localAi: { vehicle: string; slot: RoadPose }[] = [];
  readonly remotes: RemoteEntry[] = [];
  /** Racer keys in the race's order: the player, the local AI, the remotes. */
  readonly keys: string[];
  private byKey = new Map<string, RemoteBus>();
  /** Per remote (in `remotes` order): whose seat it hangs on and when its last snapshot came (ms). */
  private live: { key: string; seat: number; human: boolean; lastAt: number; life: Life }[] = [];
  private seats: Seat[];
  private linkAt = performance.now();
  private linkState: string = 'open';
  /** The connection is gone for good (closed or rejected): racing alone. */
  offline = false;
  private race: RaceSession | null = null;
  private clockAcc = 0;
  private mine: CarState | undefined;
  private ai: (CarState | undefined)[] = [];
  private cars: CarState[] = [];
  /** GO on the server's clock (ms). */
  private goAt: number;

  constructor(
    readonly conn: RoomConnection,
    joined: Joined,
    private world: RAPIER.World,
    track: TrackData,
    readonly code: string,
  ) {
    const { go, seats } = joined;
    this.seats = seats;
    const hostSeat = seats.find((s) => s.host)?.id ?? -1;
    this.grid = go.grid;
    this.goAt = go.goAt;
    this.slots = gridSlots(track, go.grid.map((g) => busById(g.vehicle).body.length));
    this.me = mySlot(go.grid, conn.seat);
    this.host = seats.find((s) => s.host)?.id === conn.seat;
    const keys = gridKeys(go.grid);
    const local: string[] = [keys[this.me]];
    const far: string[] = [];
    go.grid.forEach((g, i) => {
      if (i === this.me) return;
      const slot = this.slots[i];
      if (g.kind === 'ai' && this.host) {
        this.localAi.push({ vehicle: g.vehicle, slot });
        local.push(keys[i]);
        return;
      }
      const base = busById(g.vehicle);
      const crew = g.kind === 'ai' ? CREWS[g.crew % CREWS.length] : null;
      const preset: BusPreset = crew ? { ...base, name: crew.name, body: { ...base.body, color: crew.color, stripe: crew.stripe, roof: crew.roof } } : base;
      const remote = new RemoteBus(world, preset, { x: slot.pos.x, y: slot.y, z: slot.pos.z, heading: slot.heading, pitch: slot.pitch });
      // On the grid until its first snapshot: its front axle's place, as its own client counts it.
      remote.s = locateOnTrack(track, slot.pos).s + base.body.length / 2;
      const name = crew ? crew.name : (seats.find((s) => g.kind === 'human' && s.id === g.seat)?.name ?? 'Pana');
      this.remotes.push({ name, preset, vehicle: base.name, remote, color: g.kind === 'human' ? seatColor(g.seat) : AI_COLOR });
      this.byKey.set(keys[i], remote);
      this.live.push({ key: keys[i], seat: g.kind === 'human' ? g.seat : hostSeat, human: g.kind === 'human', lastAt: performance.now(), life: 'live' });
      far.push(keys[i]);
    });
    this.keys = [...local, ...far];
    conn.on('st', (m) => {
      const now = performance.now();
      for (const car of m.cars) {
        const key = racerKey(car.who);
        this.byKey.get(key)?.push(m.at, car);
        const l = this.live.find((x) => x.key === key);
        if (l) l.lastAt = now;
      }
    });
    conn.on('room', (m) => (this.seats = m.seats));
    conn.on('result', (m) => this.race?.applyResults(m.rows, m.final));
  }

  /** The race this feeds (made after the grid is known). */
  attach(race: RaceSession): void {
    this.race = race;
  }

  /** Seconds to GO on the shared clock (negative after). */
  goIn(): number {
    return (this.goAt - this.conn.clock.serverNow(performance.now())) / 1000;
  }

  /** Before each physics step: the remote buses where their snapshots put them. `lag`: how far (s) this step is behind now. */
  beforeStep(lag: number, dt: number): void {
    const now = performance.now();
    this.watch(now);
    const t = this.conn.clock.serverNow(now) - lag * 1000;
    for (const r of this.byKey.values()) r.apply(t, dt);
  }

  /** Our link to the room and the others' seats and snapshots: banner, ghosts, buses removed. */
  private watch(now: number): void {
    const race = this.race;
    const state = this.conn.state;
    // While we are cut off nobody's snapshots reach us: the silence counts from the link's return.
    if (state !== 'open') this.linkAt = now;
    if (state !== this.linkState) {
      this.linkState = state;
      this.offline = state === 'closed' || state === 'rejected';
      race?.setNet(state);
    }
    if (!race) return;
    this.live.forEach((l, j) => {
      if (l.life === 'gone') return;
      const seat = this.seats.find((s) => s.id === l.seat);
      const life = remoteLife({ seat, byFlag: l.human, silentMs: now - Math.max(l.lastAt, this.linkAt), linkUp: !this.offline });
      if (life === l.life) return;
      l.life = life;
      const bus = this.byKey.get(l.key);
      if (life === 'gone') {
        bus?.dispose(this.world);
        this.byKey.delete(l.key);
      } else if (bus) bus.forceGhost = life === 'ghost';
      race.setRemoteLife(j, life);
    });
  }

  /** Each physics step: snapshots out at SNAP_HZ (the player's bus, the host's AI), finish times out. */
  tick(dt: number, bus: BusPhysics, throttle: number): void {
    const race = this.race;
    if (!race) return;
    for (const f of race.finishes) this.conn.send({ t: 'fin', who: racerFromKey(f.key), time: f.time });
    race.finishes.length = 0;
    this.clockAcc += dt;
    if (this.clockAcc < 1 / SNAP_HZ) return;
    this.clockAcc %= 1 / SNAP_HZ;
    const cars = this.cars;
    cars.length = 0;
    this.mine = carState(bus, racerOf(this.grid[this.me]), race.trackS(0), throttle, this.mine);
    cars.push(this.mine);
    race.rivals.forEach((r, i) => {
      this.ai[i] = carState(r.bus, racerFromKey(this.keys[i + 1]), race.trackS(i + 1), r.throttle, this.ai[i]);
      cars.push(this.ai[i]!);
    });
    this.conn.send({ t: 'st', at: this.conn.clock.serverNow(performance.now()), cars });
  }

  /** Back to the room's lobby in the menu (the seat is kept: the menu reconnects with its token). */
  toLobby(): void {
    if (this.offline) return this.leave();
    location.search = `?lobby=${this.code}`;
  }

  /** Out of the room for good, to the menu. */
  leave(): void {
    this.conn.close();
    clearSession();
    location.search = '';
  }

  dispose(): void {
    for (const r of this.byKey.values()) r.dispose(this.world);
    this.byKey.clear();
  }
}
