import * as THREE from 'three';
import type { RAPIER } from '../physics/world';
import type { BusPhysics } from '../vehicle/bus';
import type { CityData } from '../world/cityData';
import type { PropSystem } from '../world/props';
import type { BusAudio } from '../core/audio';
import type { CameraMode } from '../camera/cameraRig';
import { Rng } from '../core/rng';
import { buildRoute, RouteGame, type GameEvent } from './routeGame';
import { TrickScorer, type TrickEvent } from './scoring';
import { NearMissDetector } from './nearMiss';
import { PassengersView } from './passengersView';
import { StopMarker } from './stopMarker';
import { NavArrow } from '../ui/arrow';
import { GameHud, money, RATING_LABEL, TRICK_LABEL } from '../ui/gameHud';
import { LINES, SPEAKER, type LineKind } from './lines';

const ROUTE_STOPS = 8;

export interface SessionDeps {
  world: RAPIER.World;
  scene: THREE.Scene;
  city: CityData;
  bus: BusPhysics;
  props: PropSystem;
  audio: BusAudio;
  hudRoot: HTMLElement;
}

/**
 * One shift on the route: wires the engine-agnostic rules (RouteGame, TrickScorer) to the
 * physics world, 3D markers, passenger figures, HUD and audio.
 */
export class GameSession {
  game!: RouteGame;
  scorer!: TrickScorer;
  private nearMiss: NearMissDetector;
  private passengers: PassengersView;
  private marker: StopMarker;
  private arrow: NavArrow;
  private hud: GameHud;
  private rng = new Rng(Date.now() & 0xffff);
  private knocked = 0;
  private busPos = new THREE.Vector3();
  private runs = 0;
  private startedFlag = false;

  constructor(private d: SessionDeps) {
    this.nearMiss = new NearMissDetector(d.world, d.bus);
    this.passengers = new PassengersView(d.scene, d.city);
    this.marker = new StopMarker(d.scene);
    this.arrow = new NavArrow(d.scene);
    this.hud = new GameHud(d.hudRoot);
    this.restart();
  }

  /** Starts the clock (first throttle press). */
  start(): void {
    if (this.startedFlag || this.game.over) return;
    this.startedFlag = true;
    this.game.start();
    this.say('board');
  }

  restart(): void {
    const { city, bus } = this.d;
    this.runs++;
    this.passengers.clear();
    this.game = new RouteGame(buildRoute(city, { count: ROUTE_STOPS }), {
      seed: this.runs * 7919 + (Date.now() & 0xff),
      capacity: bus.preset.capacity,
      start: city.spawn.pos,
    });
    this.scorer = new TrickScorer();
    this.startedFlag = false;
    this.game.route.forEach((r, i) => this.passengers.showWaiting(r, this.game.waitingAt(i)));
    this.retarget();
    this.hud.showResults(null);
    bus.reset({ x: city.spawn.pos.x, y: 0, z: city.spawn.pos.z, heading: city.spawn.heading });
  }

  /** Called every fixed physics step. */
  physicsStep(dt: number): void {
    if (!this.startedFlag || this.game.over) return;
    const bus = this.d.bus;
    const tricks = this.scorer.update({
      dt,
      speed: bus.speed,
      slipAngle: bus.slipAngle,
      airborne: bus.wheelsOnGround === 0,
      nearMisses: this.nearMiss.update(dt),
      propsKnocked: this.knocked,
    });
    this.knocked = 0;
    for (const t of tricks) this.onTrick(t);

    const p = bus.body.translation();
    for (const e of this.game.update(dt, { pos: { x: p.x, z: p.z }, speed: bus.speed })) this.onGame(e);
  }

  /** Called every rendered frame. */
  frame(dt: number, camera: THREE.Camera, mode: CameraMode): void {
    const bus = this.d.bus;
    this.knocked += this.d.props.consumeKnocked();
    const t = bus.body.translation();
    this.busPos.set(t.x, t.y, t.z);
    this.passengers.update(dt, bus);
    this.marker.update(dt);
    this.arrow.update(camera, mode, this.busPos);
    const zone = this.game.activeStop.zone;
    this.hud.board(this.game.activeStop.stop.name, Math.hypot(zone.x - t.x, zone.z - t.z), this.gettingOff());
    this.hud.update(dt, {
      timeLeft: this.game.timeLeft,
      cents: this.game.cents,
      onBoard: this.game.onBoard.length,
      capacity: bus.preset.capacity,
      chain: this.scorer.chain,
      started: this.startedFlag,
    });
  }

  private onTrick(t: TrickEvent): void {
    if (t.kind === 'crash') {
      this.d.audio.cue('crash');
      if (this.game.onBoard.length) this.say('crash');
      return;
    }
    this.game.addTrickCents(t.cents);
    const mult = t.multiplier > 1 ? ` ×${t.multiplier}` : '';
    this.hud.popup(`+${money(t.cents)} ${TRICK_LABEL[t.kind]}${mult}`);
    if (!this.game.onBoard.length) return;
    if (t.kind === 'air') this.say('air');
    else if (t.kind === 'drift' || t.kind === 'nearMiss') this.say('scared', 0.5);
  }

  private onGame(e: GameEvent): void {
    switch (e.type) {
      case 'fare':
        this.d.audio.cue('coin');
        this.hud.popup(`+${money(e.cents)} ${RATING_LABEL[e.rating]}`, e.rating === 'slow' ? 'bad' : 'money');
        if (e.rating === 'fast') this.say('happy', 0.6);
        if (e.rating === 'slow') this.say('grumpy', 0.8);
        break;
      case 'arrive': {
        this.passengers.alight(e.alighted, this.d.bus);
        this.passengers.board(e.boarded);
        this.passengers.showWaiting(this.game.route[e.stopIndex], this.game.waitingAt(e.stopIndex));
        this.d.audio.cue('time');
        this.hud.popup(`+${e.timeBonus} s ${RATING_LABEL[e.rating]}`, 'time');
        if (e.boarded.length) this.say('board', 0.7);
        this.retarget();
        break;
      }
      case 'approach':
        this.say('approach');
        break;
      case 'impatient':
        this.say('impatient', 0.7);
        break;
      case 'gameOver':
        this.marker.visible = false;
        this.arrow.point(null);
        this.hud.showResults({
          cents: this.game.cents,
          delivered: this.game.delivered,
          bestCombo: this.scorer.bestCombo,
          longestAir: this.scorer.longestAir,
        });
        break;
    }
  }

  private gettingOff(): number {
    return this.game.onBoard.filter((p) => p.to === this.game.activeIndex).length;
  }

  private retarget(): void {
    const zone = this.game.activeStop.zone;
    const off = this.gettingOff() > 0;
    this.marker.visible = true;
    this.marker.place(zone, off);
    this.arrow.point(zone, off ? '#ffd23f' : '#3dff8a');
  }

  private say(kind: LineKind, chance = 1): void {
    if (this.rng.next() > chance) return;
    this.hud.say(SPEAKER[kind], this.rng.pick(LINES[kind]));
  }
}
