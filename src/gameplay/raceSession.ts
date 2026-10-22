import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { BusPhysics } from '../vehicle/bus';
import { BusModel } from '../vehicle/busModel';
import { type BusPreset, isTrain } from '../vehicle/busPreset';
import { busById } from '../vehicle/buses';
import { type TrackData, locateOnTrack, trackPoint, trackPose } from '../world/track';
import type { RoadPose } from '../world/roadSnap';
import type { BusAudio, RivalVoice } from '../core/audio';
import type { DriveInput } from '../core/input';
import { engineLoad } from '../core/soundModel';
import { Rng } from '../core/rng';
import { Nitro } from './nitro';
import { KEEP_RIGHT, RaceDriver, type RoadUser, SKILLS, type TrafficCar, chooseLane, vehicleLimits } from './raceDriver';
import { FALL_BACK, FallWatch } from './fallWatch';
import { GHOST_TIME, Ghost } from './ghost';
import { LAUNCH_EFFECT, type LaunchGrade, LaunchRev, aiGrade } from './launch';
import { PlaceCaller, RaceGame } from './raceGame';
import { bestRace, recordRace } from './raceRecords';
import { CREWS, MAX_RIVALS, RESET_WAIT } from './raceField';
import { PICKUP_FILL, Pickups } from './pickups';
import { PickupView } from './pickupView';
import type { TrafficSim } from './traffic';
import { RaceHud, type RaceResults, resultRows } from '../ui/raceHud';
import { type TireSmoke, dustOf, smokeOf } from '../vehicle/tireSmoke';
import type { Vec2 } from '../world/cityData';
import type { RemoteBus } from '../net/remoteBus';
import type { Life } from '../net/live';
import type { ResultRow } from '../net/protocol';
import { racerKey } from '../net/protocol';
import { AI_COLOR } from '../net/colors';
import { NameTags } from '../ui/nameTags';

export type RaceSkill = keyof typeof SKILLS;

/** The rubber band: a rival this far ahead of the player (m) eases off by RUBBER, behind it pushes. */
const RUBBER_GAP = 350;
const RUBBER = 0.07;
/** After the player crosses the line: the trackside camera at the finish (s) before the results. */
export const FINISH_CAM = 4;
/** Relocating a ghost stuck in another vehicle: search this far (m) along the road in steps, keeping this gap (m) and lane width (m). */
/** How see-through another player's ghost looks. */
const REMOTE_GHOST_OPACITY = 0.4;
const RELOCATE_REACH = 60;
const RELOCATE_STEP = 12;
const RELOCATE_GAP = 2;
const RELOCATE_LANE = 3.2;
/** A rival this close (s) to the player's time at the line makes it a photo finish. */
const PHOTO_GAP = 1;

interface Rival {
  preset: BusPreset;
  /** The vehicle it's a recolored copy of (the results card names it). */
  base: BusPreset;
  bus: BusPhysics;
  model: BusModel;
  driver: RaceDriver;
  nitro: Nitro;
  fall: FallWatch;
  ghost: Ghost;
  slot: RoadPose;
  /** Its own lane (m off the middle). */
  home: number;
  grade: LaunchGrade | null;
  /** Time left on its launch's effect (s). */
  effect: number;
  /** Time left held still after being put back on the road (s). */
  wait: number;
  lastS: number;
  /** Its throttle last step (for the engine's sound). */
  throttle: number;
}

/** Online: a bus on the grid moved from the network (another player, or the host's AI off the host). */
export interface RemoteEntry {
  name: string;
  /** Its livery (an AI's crew colors) for the model. */
  preset: BusPreset;
  /** The vehicle's own name, for the results card. */
  vehicle: string;
  remote: RemoteBus;
  /** Its name tag's and dots' color (a player's seat color, grey for the AI). */
  color: string;
}

interface Remote extends RemoteEntry {
  model: BusModel;
  lastS: number;
  life: Life;
}

export interface RaceOptions {
  /** Vehicle id of each rival (`rivalVehicles`). */
  vehicles: string[];
  /** Grid slots (`gridSlots`): the rivals', then the player's. */
  slots: RoadPose[];
  skill?: RaceSkill;
  /** Traffic on the road (the session's), and its cars' place on the track. */
  traffic?: { sim: TrafficSim; trackS: (edge: number, s: number) => number } | null;
  /** Terrain height (where the finish camera can stand). */
  ground?: (p: Vec2) => number;
  seed?: number;
  /**
   * Online: the racers' keys (`racerKey`: the player, then the AI simulated here, then `remotes`),
   * seconds to GO on the shared clock, and the buses moved from the network. Places come from
   * every racer's progress; no guessed times, no records.
   */
  online?: { keys: string[]; goIn: () => number; remotes: RemoteEntry[] } | null;
}

/**
 * A race on a track (`city.race`): the player's bus and its rivals on a grid behind the start
 * line, the countdown with the launch (the player revs freely: `throttleHeld` each frame; the
 * bus is held on its brakes until GO), each rival driven by a `RaceDriver` (passing other racers
 * and traffic when the other half of the road is clear), nitro pickups on the road, positions,
 * falls off the road for the rivals too, and the results with the track's best time. The
 * player's bus is the session's; its grid slot is the last of `slots` (the session's start).
 */
export class RaceSession {
  game: RaceGame;
  readonly launch = new LaunchRev();
  readonly hud: RaceHud;
  readonly rivals: Rival[] = [];
  readonly pickups: Pickups;
  /** The player's launch grade (null before GO) and time left on its effect. */
  grade: LaunchGrade | null = null;
  private effect = 0;
  /** Time left before the player may drive on after an R reset (s). */
  wait = 0;
  /** The player's ghost after a respawn. */
  private ghost = new Ghost();
  private rng: Rng;
  private skill: RaceSkill;
  private progress: number[];
  /** Each racer on the road (front axle's meters along, offset + right, speed), the player first. */
  private users: RoadUser[];
  private near: RoadUser[] = [];
  private positions: { x: number; z: number }[];
  /** The rivals' engines, for the audio (refreshed every frame). */
  readonly voices: RivalVoice[];
  private view: PickupView;
  private nose = { x: 0, y: 0, z: 0 };
  private playerS = -1;
  private noseS: number[];
  private taken: number[] = [];
  private hold = { throttle: 0, steer: 0, handbrake: false, boost: false, parked: true };
  private traffic: RaceOptions['traffic'];
  /** Traffic on the track this frame (`pool` holds the records, reused frame to frame). */
  private cars: TrafficCar[] = [];
  private pool: TrafficCar[] = [];
  /** Tire grip from the weather (`gripFor(wet)`), for every bus on the road, and how wet it is (0..1: the rivals drive to it). */
  weatherGrip = 1;
  wet = 0;
  /** Tire smoke and dust off the rivals' wheels (the player's is main's). */
  smoke: TireSmoke | null = null;
  /** Popups for the player's feed (launch, pickups, places won and lost): read and cleared by main. */
  readonly notices: { text: string; tone: 'money' | 'bad' }[] = [];
  private caller = new PlaceCaller();
  /** Where the trackside camera stands at the finish, and time left on it (s). */
  private finishSpot: { x: number; y: number; z: number };
  private finishIn = 0;
  private results: RaceResults | null = null;
  private remotes: Remote[] = [];
  /** Online: the other racers' name tags; placed for `camera` each frame. */
  readonly tags: NameTags | null = null;
  camera: THREE.Camera | null = null;
  private online: RaceOptions['online'];
  private final = false;
  /** Online with the room gone for good: the results card holds only the player's own. */
  private offline = false;
  /** Online: finish times to report to the server (the player's, and the AI simulated here). Read and cleared by the caller. */
  readonly finishes: { key: string; time: number }[] = [];

  constructor(
    private world: RAPIER.World,
    private scene: THREE.Scene,
    private track: TrackData,
    private zone: string,
    private player: { bus: BusPhysics; preset: BusPreset; nitro: Nitro },
    private audio: BusAudio,
    hudRoot: HTMLElement,
    opts: RaceOptions,
  ) {
    this.rng = new Rng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.skill = opts.skill ?? 'normal';
    this.traffic = opts.traffic ?? null;
    const n = Math.max(0, Math.min(MAX_RIVALS, opts.vehicles.length));
    const busy = !!this.traffic && this.traffic.sim.cars.length > 0;
    for (let i = 0; i < n; i++) {
      const crew = CREWS[i];
      const base = busById(opts.vehicles[i]);
      const preset: BusPreset = { ...base, name: crew.name, body: { ...base.body, color: crew.color, stripe: crew.stripe, roof: crew.roof } };
      const slot = opts.slots[i];
      const bus = new BusPhysics(world, preset, { x: slot.pos.x, y: slot.y, z: slot.pos.z, heading: slot.heading, pitch: slot.pitch });
      const model = new BusModel(preset);
      scene.add(model.root);
      // The middle of the road, a little to either side; with traffic about, the right half.
      const home = busy ? KEEP_RIGHT - (i % 2) * 0.3 : (i % 2 ? 1 : -1) * 0.6;
      this.rivals.push({ preset, base, bus, model, driver: new RaceDriver(track, SKILLS[this.skill], vehicleLimits(preset), home), nitro: new Nitro(), fall: new FallWatch(), ghost: new Ghost(), slot, home, grade: null, effect: 0, wait: 0, lastS: -1, throttle: 0 });
    }
    this.online = opts.online ?? null;
    for (const e of this.online?.remotes ?? []) {
      const model = new BusModel(e.preset);
      scene.add(model.root);
      this.remotes.push({ ...e, model, lastS: -1, life: 'live' });
    }
    const others = [...this.rivals.map((r) => r.preset), ...this.remotes.map((r) => r.preset)];
    const total = 1 + others.length;
    this.game = new RaceGame(['Tú', ...this.rivals.map((r) => r.preset.name), ...this.remotes.map((r) => r.name)], track.finish - track.start, { estimate: !this.online });
    this.progress = new Array(total).fill(0);
    this.users = Array.from({ length: total }, (_, k) => ({ s: 0, off: 0, v: 0, len: k ? others[k - 1].body.length : player.preset.body.length }));
    this.noseS = new Array(total).fill(-1);
    // Online every racer's dot on the minimap and the strip has its color: the players' seats', grey for the AI.
    const colors = [...this.rivals.map(() => AI_COLOR), ...this.remotes.map((r) => r.color)];
    this.positions = others.map((_, i) => (this.online ? { x: 0, z: 0, color: colors[i] } : { x: 0, z: 0 }));
    this.voices = others.map((p) => ({ x: 0, y: 0, z: 0, speedFrac: 0, load: 0, car: p.kind === 'car' || isTrain(p) }));
    this.pickups = new Pickups(track.pickups);
    this.view = new PickupView(scene, track, this.pickups);
    this.hud = new RaceHud(hudRoot, track.from, track.to, total);
    if (this.online) {
      this.hud.setOnline();
      this.hud.setColors([null, ...colors]);
      // Who is who: names over the other buses.
      this.tags = new NameTags(scene);
      for (const r of this.rivals) this.tags.add(r.bus, r.preset.name, AI_COLOR);
      for (const r of this.remotes) this.tags.add(r.remote.bus, r.name, r.color);
    }
    this.finishSpot = finishCamera(track, opts.ground ?? (() => -Infinity));
  }

  /** While the finish camera rolls: where it stands (it looks at the player's bus). */
  get finishView(): { x: number; y: number; z: number } | null {
    return this.finishIn > 0 ? this.finishSpot : null;
  }

  /** The rivals' vehicles (for the session: traffic sees them). */
  get buses(): BusPhysics[] {
    return this.rivals.map((r) => r.bus);
  }

  /** What the player's bus gets this step: held still until GO (and after an R reset), then the launch's effect on its input. */
  playerInput(drive: { throttle: number; steer: number; handbrake: boolean; boost?: boolean }, nitroBoost: boolean): DriveInput {
    if (!this.game.green || this.wait > 0) return { throttle: 0, steer: drive.steer, handbrake: false, boost: false, parked: true };
    const e = this.grade && this.effect > 0 ? LAUNCH_EFFECT[this.grade] : null;
    return { throttle: drive.throttle * (e?.throttle ?? 1), steer: drive.steer, handbrake: drive.handbrake, boost: nitroBoost || (!!e && e.boost > 0) };
  }

  /** The player was put back on the road (R): it waits RESET_WAIT seconds before it may go on. */
  playerReset(): void {
    this.wait = RESET_WAIT;
    this.playerS = -1;
    this.noseS[0] = -1;
    this.becomeGhost(this.ghost, this.player.bus, RESET_WAIT + GHOST_TIME);
  }

  /** Opacity for the player's model (1 unless it is a ghost). */
  get ghostFade(): number {
    return this.ghost.fade;
  }

  /** The player fell off the road and was put back (no wait): a ghost for a few seconds. */
  playerFell(): void {
    this.playerS = -1;
    this.noseS[0] = -1;
    this.becomeGhost(this.ghost, this.player.bus, GHOST_TIME);
  }

  /** A racer put back on the road: untouchable for `seconds`, so it can't reappear inside another vehicle. */
  private becomeGhost(g: Ghost, bus: BusPhysics, seconds: number): void {
    g.start(seconds);
    bus.setGhost(true);
  }

  /**
   * Each frame: runs a racer's ghost, applying it to its physics and model. Past its time it stays
   * a ghost while it overlaps another vehicle; past the cap it is moved to a free spot (`k`: its place in `users`).
   */
  private tickGhost(k: number, g: Ghost, bus: BusPhysics, model: BusModel | null, dt: number): void {
    if (!g.active) {
      if (bus.ghost) bus.setGhost(false);
      model?.setGhost(1);
      return;
    }
    const e = g.update(dt, () => bus.overlapsOthers(this.world));
    if (e === 'relocate') {
      this.relocate(k, bus);
      this.becomeGhost(g, bus, GHOST_TIME);
    }
    if (e === 'solid') bus.setGhost(false);
    model?.setGhost(g.fade);
  }

  /**
   * Moves racer `k` to the nearest free spot of the road: along the track from where it is (this
   * place, then 12 m behind and ahead, 24 m, ... up to 60 m), its own lane first and then the other,
   * where no other racer or car is within a vehicle's length (or a lane's width) of it.
   */
  private relocate(k: number, bus: BusPhysics): void {
    const t = this.track;
    const me = this.users[k];
    const p = bus.position(this.nose);
    const at = locateOnTrack(t, p, k ? this.rivals[k - 1].lastS : this.playerS, 120);
    const lane = at.off < 0 ? -2.1 : 2.1;
    let pick: { s: number; lane: number } | null = null;
    search: for (let d = 0; d <= RELOCATE_REACH; d += RELOCATE_STEP) {
      for (const sign of d ? [-1, 1] : [1]) {
        const s = Math.min(t.finish, Math.max(t.start, at.s + sign * d));
        for (const l of [lane, -lane]) {
          // Center to center (its users[] entry is the front axle, about half a length ahead).
          const front = s + me.len / 2;
          if (this.spotFree(k, front, l, me.len)) {
            pick = { s, lane: l };
            break search;
          }
        }
      }
    }
    pick ??= { s: at.s, lane };
    const to = trackPose(t, pick.s, pick.lane);
    bus.reset({ x: to.pos.x, y: to.y, z: to.pos.z, heading: to.heading, pitch: to.pitch });
    if (k) {
      const r = this.rivals[k - 1];
      r.driver.rescued();
      r.lastS = -1;
    } else this.playerS = -1;
    this.noseS[k] = -1;
  }

  /** Nobody else (racer or traffic car) overlaps a vehicle of length `len` with its front axle at `s` in lane `off`. */
  private spotFree(k: number, s: number, off: number, len: number): boolean {
    for (let j = 0; j < this.users.length; j++) {
      const u = this.users[j];
      if (j !== k && Math.abs(u.s - s) < (u.len + len) / 2 + RELOCATE_GAP && Math.abs(u.off - off) < RELOCATE_LANE) return false;
    }
    for (const c of this.cars) if (Math.abs(c.s - s) < (c.len + len) / 2 + RELOCATE_GAP && Math.abs(c.off - off) < RELOCATE_LANE) return false;
    return true;
  }

  /** The player may use R: the race is on (on the grid it would only lose the slot). */
  get canReset(): boolean {
    return this.game.phase === 'racing';
  }

  /** Grip the player's tires have from the launch (wheelspin), 1 otherwise. */
  get playerGrip(): number {
    return this.grade && this.effect > 0 ? LAUNCH_EFFECT[this.grade].grip : 1;
  }

  /** Racer `k`'s lane and speed limit (`chooseLane`), against the other racers and the traffic. */
  private laneFor(k: number, home: number): { lane: number; limit: number } {
    const me = this.users[k];
    this.near.length = 0;
    for (let j = 0; j < this.users.length; j++) if (j !== k) this.near.push(this.users[j]);
    return chooseLane(me, this.near, this.cars, home, SKILLS[this.skill].passClear);
  }

  /** Each physics step, before the world steps: the rivals drive. */
  step(dt: number): void {
    const playerS = this.progress[0];
    this.rivals.forEach((r, i) => {
      if (r.wait > 0) r.wait -= dt;
      if (!this.game.green || r.fall.falling || r.wait > 0) {
        r.throttle = 0;
        r.bus.update(this.hold, dt);
        return;
      }
      const ahead = this.progress[i + 1] - playerS;
      const way = this.laneFor(i + 1, r.home);
      r.driver.lane = way.lane;
      // Eases off ahead of the player as much as its skill lets it, pushes when behind.
      const band = Math.max(-1, Math.min(1, ahead / RUBBER_GAP));
      const pace = 1 - RUBBER * (band > 0 ? band * SKILLS[this.skill].ease : band);
      const input = r.driver.drive(r.bus, dt, pace, r.nitro.ready || r.nitro.active, way.limit);
      const e = r.grade && r.effect > 0 ? LAUNCH_EFFECT[r.grade] : null;
      if (r.effect > 0) r.effect -= dt;
      r.bus.grip = this.weatherGrip * (e?.grip ?? 1);
      r.driver.wet = this.wet;
      r.throttle = input.throttle * (e?.throttle ?? 1);
      r.bus.update({ throttle: r.throttle, steer: input.steer, handbrake: input.handbrake, boost: r.nitro.step(!!input.boost, dt) || (!!e && e.boost > 0) }, dt);
    });
    if (this.effect > 0) this.effect -= dt;
  }

  /** Where each car of the traffic is along the track (it drives one lane each way). */
  private locateTraffic(): void {
    this.cars.length = 0;
    const tr = this.traffic;
    if (!tr) return;
    for (const c of tr.sim.cars) {
      if (c.state !== 'driving') continue;
      const s = tr.trackS(c.edge, c.s);
      const dir: 1 | -1 = tr.trackS(c.edge, c.s + 1) > s ? 1 : -1;
      const k = this.cars.length;
      const rec = (this.pool[k] ??= { s: 0, off: 0, v: 0, dir: 1, len: 0 });
      rec.s = s;
      rec.off = dir * Math.abs(c.offset);
      rec.v = c.speed;
      rec.dir = dir;
      rec.len = c.kind.length;
      this.cars.push(rec);
    }
  }

  /** Each frame: the countdown and launch, progress and places, falls, pickups, the rivals' models and the HUD. */
  frame(dt: number, throttleHeld: number, begun: boolean): void {
    const t = this.track;
    const g = this.game;
    if (!g.green) this.launch.update(dt, begun ? throttleHeld : 0);
    if (this.wait > 0 && g.phase === 'racing') this.wait = Math.max(0, this.wait - dt);
    this.locateTraffic();
    // Progress: each front axle's distance past the start line.
    const pn = this.player.bus.nose(this.nose);
    const here = locateOnTrack(t, pn, this.playerS, 120);
    this.playerS = Math.hypot(here.off, here.y - pn.y) > 25 ? locateOnTrack(t, pn).s : here.s;
    this.progress[0] = this.playerS - t.start;
    this.users[0].s = this.playerS;
    this.users[0].off = here.off;
    this.users[0].v = this.player.bus.speed;
    this.rivals.forEach((r, i) => {
      const p = r.bus.position(this.nose);
      const at = locateOnTrack(t, p, r.lastS, 120);
      const s = Math.hypot(at.off, at.y - p.y) > 25 ? locateOnTrack(t, p) : at;
      if (!r.fall.falling) r.lastS = s.s;
      this.progress[i + 1] = Math.max(r.driver.s, 0) - t.start;
      this.users[i + 1].s = Math.max(r.driver.s, 0);
      this.users[i + 1].off = s.off;
      this.users[i + 1].v = r.bus.speed;
      this.positions[i].x = p.x;
      this.positions[i].z = p.z;
      const v = this.voices[i];
      v.x = p.x;
      v.y = p.y;
      v.z = p.z;
      v.speedFrac = Math.abs(r.bus.speed) / (r.preset.topSpeedKmh / 3.6);
      v.load = engineLoad(r.throttle, r.bus.speed, r.bus.boosting);
      const ev = r.fall.update(dt, { roadY: s.y, busY: p.y, off: s.off, halfWidth: t.width / 2, wheelsOnGround: r.bus.wheelsOnGround });
      if (ev === 'respawn') {
        const back = trackPose(t, Math.max(t.start - 12, r.lastS - FALL_BACK), r.driver.lane);
        r.bus.reset({ x: back.pos.x, y: back.y, z: back.pos.z, heading: back.heading, pitch: back.pitch });
        r.driver.rescued();
        this.noseS[i + 1] = -1;
        this.becomeGhost(r.ghost, r.bus, GHOST_TIME);
      }
      // Wedged for good (on a rail, against the player): back on the road where it was, and a wait like the player's R.
      if (r.driver.needsRescue && !r.fall.falling) {
        const at = trackPose(t, r.lastS, r.driver.lane);
        r.bus.reset({ x: at.pos.x, y: at.y, z: at.pos.z, heading: at.heading, pitch: at.pitch });
        r.driver.rescued();
        r.wait = RESET_WAIT;
        this.noseS[i + 1] = -1;
        this.becomeGhost(r.ghost, r.bus, RESET_WAIT + GHOST_TIME);
      }
      this.tickGhost(i + 1, r.ghost, r.bus, r.model, dt);
      r.model.sync(r.bus);
      if (this.smoke && !r.fall.falling) {
        const spin = r.grade === 'spin' && r.effect > 0 ? r.throttle : 0;
        this.smoke.emit(r.bus, smokeOf(r.bus.slipAngle, r.bus.speed, spin), dustOf(Math.abs(s.off) - t.width / 2, r.bus.speed), dt);
      }
    });
    this.tickGhost(0, this.ghost, this.player.bus, null, dt);
    this.syncRemotes();
    if (this.tags && this.camera) this.tags.update(this.camera);
    if (g.green) this.collect(dt);
    this.view.update(dt);
    if (g.phase === 'racing') this.callPlace(dt);
    if (this.finishIn > 0) {
      this.finishIn -= dt;
      if (this.finishIn <= 0) {
        this.hud.photo(null);
        this.hud.showResults(this.results);
      }
    }
    for (const e of g.update(dt, this.progress, begun, this.online?.goIn())) {
      if (e.type === 'count') {
        this.hud.count(String(e.n));
        this.audio.cue('beep');
      }
      if (e.type === 'go') this.go();
      if (e.type === 'over') this.finish();
      // Online: the player's time and the local AI's go to the server (a remote's own client reports it).
      if (e.type === 'finish' && this.online && e.racer <= this.rivals.length) this.finishes.push({ key: this.online.keys[e.racer], time: e.time });
    }
    this.hud.update(dt, {
      rpm: g.green ? null : this.launch.shown,
      place: g.placeOf(0) || this.progress.length,
      racers: this.progress.length,
      time: g.time,
      progress: this.progress,
      length: g.length,
      wait: g.phase === 'racing' ? this.wait : 0,
    });
  }

  /** Pickups: whoever ran over one since the last frame gets half a tank. */
  private collect(dt: number): void {
    this.pickups.step(dt);
    // The player and the AI simulated here (a remote bus takes pickups on its own client).
    for (let k = 0; k <= this.rivals.length; k++) {
      const s = this.progress[k] + this.track.start;
      const prev = this.noseS[k];
      this.noseS[k] = s;
      if (prev < 0 || (k > 0 && this.rivals[k - 1].fall.falling) || (k === 0 && this.wait > 0)) continue;
      const width = k ? this.rivals[k - 1].preset.body.width : this.player.preset.body.width;
      if (!this.pickups.take(prev, s, this.users[k].off, this.users[k].len, width, this.taken).length) continue;
      if (k === 0) {
        this.player.nitro.bonus(PICKUP_FILL * this.taken.length);
        this.audio.cue('pickup');
        this.notices.push({ text: '¡Nitro!', tone: 'money' });
      } else this.rivals[k - 1].nitro.bonus(PICKUP_FILL * this.taken.length);
    }
  }

  /** The buses moved from the network: progress from their snapshots, models, minimap, engines. */
  private syncRemotes(): void {
    const t = this.track;
    const base = 1 + this.rivals.length;
    this.remotes.forEach((m, j) => {
      const k = base + j;
      if (m.life === 'gone') return;
      const bus = m.remote.bus;
      const p = bus.position(this.nose);
      const near = locateOnTrack(t, p, m.lastS, 120);
      const at = Math.hypot(near.off, near.y - p.y) > 25 ? locateOnTrack(t, p) : near;
      m.lastS = at.s;
      // Its own client's progress (the front axle's), as sent.
      this.progress[k] = m.remote.s - t.start;
      this.users[k].s = m.remote.s;
      this.users[k].off = at.off;
      this.users[k].v = m.remote.speed;
      const pos = this.positions[k - 1];
      pos.x = p.x;
      pos.z = p.z;
      const v = this.voices[k - 1];
      v.x = p.x;
      v.y = p.y;
      v.z = p.z;
      // A bus whose player went quiet idles.
      const quiet = m.life !== 'live';
      v.speedFrac = quiet ? 0 : Math.abs(m.remote.speed) / (m.preset.topSpeedKmh / 3.6);
      v.load = quiet ? 0 : engineLoad(m.remote.throttle, m.remote.speed, bus.boosting);
      m.model.setGhost(m.remote.ghost ? REMOTE_GHOST_OPACITY : 1);
      m.model.sync(bus, m.remote.wheels);
    });
  }

  /**
   * Online: remote racer `j` (in `RaceOptions.online.remotes` order) left or went quiet: a ghost
   * (nobody crashes into a frozen bus, its tag says so), or out of the race for good (bus, model,
   * tag and dots removed; it stays in the standings, "retirado" once the results are final).
   */
  setRemoteLife(j: number, life: Life): void {
    const m = this.remotes[j];
    if (!m || m.life === life || m.life === 'gone') return;
    m.life = life;
    const k = 1 + this.rivals.length + j;
    if (life === 'gone') {
      m.remote.dispose(this.world);
      this.scene.remove(m.model.root);
      this.tags?.remove(m.remote.bus);
      this.progress[k] = -1;
      this.positions[k - 1].x = NaN;
      this.positions[k - 1].z = NaN;
      this.voices[k - 1].x = 1e6;
      this.hud.hideDot(k);
      return;
    }
    m.remote.forceGhost = life === 'ghost';
    this.tags?.setNote(m.remote.bus, life === 'ghost');
  }

  /** Online: our own link to the room. Reconnecting shows a banner; closed for good, the race goes on alone. */
  setNet(state: 'connecting' | 'open' | 'closed' | 'rejected'): void {
    this.hud.setNet(state === 'connecting' ? 'Reconectando…' : state === 'open' ? null : 'Sin conexión con la sala: sigues corriendo solo');
    if (state !== 'closed' && state !== 'rejected') return;
    if (!this.offline) this.hud.setOffline();
    this.offline = true;
    this.final = true;
    if (this.results) {
      this.results = this.resultsCard();
      if (this.finishIn <= 0) this.hud.showResults(this.results);
    }
  }

  /** Meters along the track of racer `k` (the player 0, then the AI simulated here): what its snapshots carry. */
  trackS(k: number): number {
    return this.users[k].s;
  }

  /** Online: the server's times (racers' keys) into the race and the results card. `final`: a racer still without one is out. */
  applyResults(rows: readonly ResultRow[], final: boolean): void {
    const keys = this.online?.keys;
    if (!keys) return;
    const g = this.game;
    for (const row of rows) {
      const i = keys.indexOf(racerKey(row.who));
      if (i >= 0 && row.time !== null && g.racers[i].time === null) g.setTime(i, row.time);
    }
    this.final ||= final;
    if (!this.results) return;
    this.results = this.resultsCard();
    // Shown already (past the finish camera): refresh it.
    if (this.finishIn <= 0) this.hud.showResults(this.results);
  }

  private resultsCard(): RaceResults {
    const g = this.game;
    const online = !!this.online;
    const card: RaceResults = {
      solo: this.offline,
      place: g.placeOf(0),
      rows: resultRows(g.racers, g.ranking(), [this.player.preset.name, ...this.rivals.map((r) => r.base.name), ...this.remotes.map((r) => r.vehicle)]),
      launch: this.grade ? LAUNCH_EFFECT[this.grade].label.replace(/[¡!]/g, '') : '—',
      best: online ? null : (bestRace(this.zone)?.time ?? null),
      newBest: this.results?.newBest ?? false,
      final: this.final,
    };
    if (this.offline) card.rows = card.rows.filter((r) => r.player);
    return card;
  }

  /** The rivals' positions (for the minimap). */
  get others(): readonly { x: number; z: number }[] {
    return this.positions;
  }

  /** The player's place, once it holds: who it passed, or who passed it. */
  private callPlace(dt: number): void {
    const g = this.game;
    const call = this.caller.update(dt, g.placeOf(0));
    if (!call) return;
    const order = g.ranking();
    // Passed: the one just behind now. Passed by: the one just ahead.
    const other = g.racers[order[call.gained ? call.place : call.place - 2]];
    if (!other) return;
    this.notices.push(
      call.gained
        ? { text: `¡Pasaste a ${other.name}!${call.place === 1 ? ' ¡Vas primero!' : ` ${call.place}º`}`, tone: 'money' }
        : { text: `Te pasó ${other.name} · ${call.place}º`, tone: 'bad' },
    );
  }

  private go(): void {
    this.hud.count('¡CARRERA!', true);
    this.audio.cue('go');
    this.grade = this.launch.grade();
    const e = LAUNCH_EFFECT[this.grade];
    this.effect = e.time;
    if (e.nitro) this.player.nitro.bonus(e.nitro);
    this.notices.push({ text: e.label, tone: this.grade === 'perfect' || this.grade === 'good' ? 'money' : 'bad' });
    this.caller.reset(this.game.placeOf(0));
    for (const r of this.rivals) {
      r.grade = aiGrade(this.rng.next(), this.skill);
      r.effect = LAUNCH_EFFECT[r.grade].time;
    }
  }

  private finish(): void {
    const g = this.game;
    const mine = g.racers[0].time!;
    // Online times aren't records: the field and the rules differ from a race against the AI.
    const newBest = this.online ? false : recordRace(this.zone, mine, this.player.preset.name);
    this.results = this.resultsCard();
    this.results.newBest = newBest;
    // The trackside camera first; the results card after it. A rival at the line within a second: a photo finish.
    this.finishIn = FINISH_CAM;
    const gap = Math.min(...g.racers.slice(1).map((r) => Math.abs((r.time ?? Infinity) - mine)));
    this.hud.photo(gap < PHOTO_GAP ? `¡FOTO FINISH! ${g.placeOf(0) === 1 ? '+' : '−'}${gap.toFixed(2)} s` : '');
    this.audio.cue('shutter');
  }

  /** Everyone back on the grid for another go. */
  restart(): void {
    for (const r of this.rivals) {
      r.bus.reset({ x: r.slot.pos.x, y: r.slot.y, z: r.slot.pos.z, heading: r.slot.heading, pitch: r.slot.pitch });
      r.driver.rescued();
      r.nitro.reset();
      r.fall.reset();
      r.grade = null;
      r.effect = 0;
      r.wait = 0;
      r.lastS = -1;
      r.ghost.reset();
      r.bus.setGhost(false);
      r.model.setGhost(1);
    }
    this.launch.reset();
    this.pickups.reset();
    this.grade = null;
    this.effect = 0;
    this.wait = 0;
    this.ghost.reset();
    this.player.bus.setGhost(false);
    this.playerS = -1;
    this.noseS.fill(-1);
    this.finishIn = 0;
    this.results = null;
    this.hud.photo(null);
    this.smoke?.clear();
    this.game = new RaceGame(this.game.racers.map((r) => r.name), this.track.finish - this.track.start);
    this.hud.showResults(null);
  }

  get over(): boolean {
    return this.game.phase === 'over';
  }

  dispose(): void {
    for (const r of this.rivals) this.scene.remove(r.model.root);
    for (const r of this.remotes) this.scene.remove(r.model.root);
    this.tags?.dispose();
    this.view.dispose();
  }
}

/**
 * Where the finish camera stands: beside the road a little past the line, on the side the ground
 * falls away (nothing between it and the road), a man's height up, looking back at the line.
 */
export function finishCamera(t: TrackData, ground: (p: Vec2) => number): { x: number; y: number; z: number } {
  const q = trackPoint(t, Math.min(t.finish + 40, t.cum[t.cum.length - 1]));
  let best = { x: q.x, y: q.y + 3, z: q.z, ground: Infinity };
  for (const side of [1, -1]) {
    const off = side * (t.width / 2 + 4);
    const p = { x: q.x - q.dz * off, z: q.z + q.dx * off };
    const g = ground(p);
    if (g < best.ground) best = { x: p.x, y: Math.max(q.y + 2.2, g + 1.7), z: p.z, ground: g };
  }
  return { x: best.x, y: best.y, z: best.z };
}
