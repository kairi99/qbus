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

export type RaceSkill = keyof typeof SKILLS;

/** The rubber band: a rival this far ahead of the player (m) eases off by RUBBER, behind it pushes. */
const RUBBER_GAP = 350;
const RUBBER = 0.07;
/** After the player crosses the line: the trackside camera at the finish (s) before the results. */
export const FINISH_CAM = 4;
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

  constructor(
    world: RAPIER.World,
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
      this.rivals.push({ preset, base, bus, model, driver: new RaceDriver(track, SKILLS[this.skill], vehicleLimits(preset), home), nitro: new Nitro(), fall: new FallWatch(), slot, home, grade: null, effect: 0, wait: 0, lastS: -1, throttle: 0 });
    }
    this.game = new RaceGame(['Tú', ...this.rivals.map((r) => r.preset.name)], track.finish - track.start);
    this.progress = new Array(n + 1).fill(0);
    this.users = Array.from({ length: n + 1 }, (_, k) => ({ s: 0, off: 0, v: 0, len: k ? this.rivals[k - 1].preset.body.length : player.preset.body.length }));
    this.noseS = new Array(n + 1).fill(-1);
    this.positions = this.rivals.map(() => ({ x: 0, z: 0 }));
    this.voices = this.rivals.map((r) => ({ x: 0, y: 0, z: 0, speedFrac: 0, load: 0, car: r.preset.kind === 'car' || isTrain(r.preset) }));
    this.pickups = new Pickups(track.pickups);
    this.view = new PickupView(scene, track, this.pickups);
    this.hud = new RaceHud(hudRoot, track.from, track.to, n + 1);
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
      }
      // Wedged for good (on a rail, against the player): back on the road where it was, and a wait like the player's R.
      if (r.driver.needsRescue && !r.fall.falling) {
        const at = trackPose(t, r.lastS, r.driver.lane);
        r.bus.reset({ x: at.pos.x, y: at.y, z: at.pos.z, heading: at.heading, pitch: at.pitch });
        r.driver.rescued();
        r.wait = RESET_WAIT;
        this.noseS[i + 1] = -1;
      }
      r.model.sync(r.bus);
      if (this.smoke && !r.fall.falling) {
        const spin = r.grade === 'spin' && r.effect > 0 ? r.throttle : 0;
        this.smoke.emit(r.bus, smokeOf(r.bus.slipAngle, r.bus.speed, spin), dustOf(Math.abs(s.off) - t.width / 2, r.bus.speed), dt);
      }
    });
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
    for (const e of g.update(dt, this.progress, begun)) {
      if (e.type === 'count') {
        this.hud.count(String(e.n));
        this.audio.cue('beep');
      }
      if (e.type === 'go') this.go();
      if (e.type === 'over') this.finish();
    }
    this.hud.update(dt, {
      rpm: g.green ? null : this.launch.shown,
      place: g.placeOf(0) || this.rivals.length + 1,
      racers: this.rivals.length + 1,
      time: g.time,
      progress: this.progress,
      length: g.length,
      wait: g.phase === 'racing' ? this.wait : 0,
    });
  }

  /** Pickups: whoever ran over one since the last frame gets half a tank. */
  private collect(dt: number): void {
    this.pickups.step(dt);
    for (let k = 0; k < this.progress.length; k++) {
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
    const newBest = recordRace(this.zone, mine, this.player.preset.name);
    const order = g.ranking();
    this.results = {
      place: g.placeOf(0),
      rows: resultRows(g.racers, order, [this.player.preset.name, ...this.rivals.map((r) => r.base.name)]),
      launch: this.grade ? LAUNCH_EFFECT[this.grade].label.replace(/[¡!]/g, '') : '—',
      best: bestRace(this.zone)?.time ?? null,
      newBest,
    };
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
    }
    this.launch.reset();
    this.pickups.reset();
    this.grade = null;
    this.effect = 0;
    this.wait = 0;
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
