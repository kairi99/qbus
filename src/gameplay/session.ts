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
import { buildRoadGraph } from '../world/roadGraph';
import { TrafficSim, type Obstacle } from './traffic';
import { TrafficBodies } from './trafficBodies';
import { PedestrianSim } from './pedestrians';
import { PedestrianView, TrafficView } from './trafficView';

const ROUTE_STOPS = 8;
// Cars and people only live in a bubble around the bus (see TrafficSim.recycle), so these
// numbers buy density near the player rather than traffic nobody sees.
const MAX_CARS = 60;
const START_CARS = 45;
const MIN_CARS = 12;
const PEDESTRIANS = 150;
const RECYCLE_EVERY = 0.5;
/** Car horns and angry drivers are only heard this close. */
const HEARING = 60;

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
  readonly traffic: TrafficSim;
  readonly trafficBodies: TrafficBodies;
  readonly peds: PedestrianSim;
  private trafficView: TrafficView;
  private pedView: PedestrianView;
  private dives = 0;
  private clock = 0;
  private budget = START_CARS;
  private fpsLowFor = 0;
  private fpsHighFor = 0;
  private sinceRecycle = 0;

  constructor(private d: SessionDeps) {
    this.nearMiss = new NearMissDetector(d.world, d.bus);
    this.passengers = new PassengersView(d.scene, d.city);
    this.marker = new StopMarker(d.scene);
    this.arrow = new NavArrow(d.scene);
    this.hud = new GameHud(d.hudRoot);
    const spawn = d.city.spawn.pos;
    this.traffic = new TrafficSim(buildRoadGraph(d.city), d.city, { seed: 11, count: MAX_CARS, avoid: { pos: spawn, radius: 25 } });
    this.traffic.setBudget(this.budget, spawn);
    this.trafficBodies = new TrafficBodies(d.world, this.traffic);
    this.trafficView = new TrafficView(d.scene, this.traffic, this.trafficBodies);
    this.peds = new PedestrianSim(d.city, { seed: 5, count: PEDESTRIANS });
    const focus = { pos: spawn, heading: d.city.spawn.heading };
    this.traffic.recycle(focus, true);
    this.peds.recycle(focus, true);
    this.pedView = new PedestrianView(d.scene, this.peds);
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

  /** The player honked: traffic ahead hurries, people on the crosswalk run. */
  playerHonk(): void {
    const t = this.d.bus.body.translation();
    this.traffic.honk({ x: t.x, z: t.z }, this.d.bus.heading);
    this.peds.honk({ x: t.x, z: t.z });
  }

  /** Called every fixed physics step, before world.step(): moves traffic and pedestrians. */
  beforeStep(dt: number): void {
    const bus = this.d.bus;
    const t = bus.body.translation();
    const busPos = { x: t.x, z: t.z };
    this.sinceRecycle += dt;
    if (this.sinceRecycle > RECYCLE_EVERY) {
      this.sinceRecycle = 0;
      this.traffic.recycle({ pos: busPos, heading: bus.heading });
      this.peds.recycle({ pos: busPos, heading: bus.heading });
    }
    const obstacles: Obstacle[] = [
      { id: 'bus', pos: busPos, heading: bus.heading, length: bus.preset.body.length, width: bus.preset.body.width },
      ...this.trafficBodies.obstacles(),
      ...this.peds.peds.filter((p) => p.onRoad).map((p) => ({ id: `ped${p.id}`, pos: p.pos, heading: p.heading, length: 0.8, width: 0.8 })),
    ];
    for (const e of this.traffic.step(dt, obstacles)) {
      const d = Math.hypot(e.pos.x - t.x, e.pos.z - t.z);
      if (d > HEARING) continue;
      this.d.audio.cue('carHorn', 1 - d / HEARING);
      this.say('driverAngry', 0.6);
    }
    this.trafficBodies.steer(dt);
    const dives = this.peds.step(dt, { pos: busPos, heading: bus.heading, speed: bus.speed }).dives;
    if (dives) {
      this.dives += dives;
      this.say('pedDive', 0.7);
    }
  }

  /** Called every fixed physics step, after world.step(). */
  physicsStep(dt: number): void {
    const bus = this.d.bus;
    const t0 = bus.body.translation();
    const hits = this.trafficBodies.afterStep(dt, bus.body.collider(0), { x: t0.x, z: t0.z });
    if (hits.length) this.say('carHit', 0.7);
    if (!this.startedFlag || this.game.over) {
      this.dives = 0;
      return;
    }
    const tricks = this.scorer.update({
      dt,
      speed: bus.speed,
      slipAngle: bus.slipAngle,
      airborne: bus.wheelsOnGround === 0,
      nearMisses: this.nearMiss.update(dt) + this.dives,
      propsKnocked: this.knocked,
    });
    this.knocked = 0;
    this.dives = 0;
    for (const t of tricks) this.onTrick(t);

    const p = bus.body.translation();
    for (const e of this.game.update(dt, { pos: { x: p.x, z: p.z }, speed: bus.speed })) this.onGame(e);
  }

  /** Called every rendered frame. */
  frame(dt: number, camera: THREE.Camera, mode: CameraMode): void {
    const bus = this.d.bus;
    this.clock += dt;
    this.trafficView.sync();
    this.pedView.sync(this.clock);
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

  /** Adapts the number of cars to the frame rate (cars cost physics + AI time). */
  adaptTraffic(fps: number, dt: number): void {
    this.fpsLowFor = fps < 40 ? this.fpsLowFor + dt : 0;
    this.fpsHighFor = fps > 55 ? this.fpsHighFor + dt : 0;
    let next = this.budget;
    if (this.fpsLowFor > 3) (next = Math.max(MIN_CARS, this.budget - 4)), (this.fpsLowFor = 0);
    if (this.fpsHighFor > 5) (next = Math.min(MAX_CARS, this.budget + 2)), (this.fpsHighFor = 0);
    if (next === this.budget) return;
    this.budget = next;
    const t = this.d.bus.body.translation();
    this.traffic.setBudget(next, { x: t.x, z: t.z }, this.d.bus.heading);
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
