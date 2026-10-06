import * as THREE from 'three';
import type { RAPIER } from '../physics/world';
import type { BusPhysics } from '../vehicle/bus';
import type { CityData } from '../world/cityData';
import type { PropSystem } from '../world/props';
import type { BusAudio } from '../core/audio';
import type { CameraMode } from '../camera/cameraRig';
import { Rng } from '../core/rng';
import { RouteGame, type GameEvent } from './routeGame';
import { type RouteDef, freeStartPose, routeLegs, routeStops, startPose } from './routes';
import { type StarThresholds, starThresholds, starsFor } from './stars';
import { Missions, pickMissions, type MissionEvent } from './missions';
import { recordMissions, recordShift } from './records';
import { type NavPath, Navigator } from './navigation';
import { MiniMap } from '../ui/minimap';
import type { Vec2 } from '../world/cityData';
import { TrickScorer, type TrickEvent } from './scoring';
import { Nitro } from './nitro';
import { NearMissDetector } from './nearMiss';
import { PassengersView } from './passengersView';
import { StopMarker } from './stopMarker';
import { NavArrow } from '../ui/arrow';
import { GameHud, money, RATING_LABEL, TRICK_LABEL } from '../ui/gameHud';
import { LINES, SPEAKER, type LineKind } from './lines';
import type { RoadGraph } from '../world/roadGraph';
import { groundHeightAt, inPlayArea, nearestRoad } from '../world/cityData';
import { pointInPolygon } from '../world/geom';
import { TrafficSim, type Obstacle } from './traffic';
import { TrafficBodies, laneSurface } from './trafficBodies';
import type { RoadPose } from '../world/roadSnap';
import { PedestrianSim } from './pedestrians';
import { MetroCrowd } from './metroCrowd';
import { PedestrianView, TrafficView } from './trafficView';

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
  graph: RoadGraph;
  /** The route of the shift; null for free roam (no stops, clock or fares). */
  route: RouteDef | null;
  /** Zone id, for the route's saved records. */
  zone: string;
}

/**
 * One shift on the route: wires the engine-agnostic rules (RouteGame, TrickScorer) to the
 * physics world, 3D markers, passenger figures, HUD and audio. Without a route it's a free
 * drive: the living city (traffic, people, nitro) and nothing to score.
 */
export class GameSession {
  /** The route game; null in free roam. */
  game: RouteGame | null = null;
  scorer!: TrickScorer;
  /** This shift's optional objectives; null in free roam. */
  missions: Missions | null = null;
  /** Money for 1, 2 and 3 stars on this route (null in free roam). */
  readonly stars: StarThresholds | null = null;
  private wasBoosting = false;
  /** Starts full; drifting and close calls refill it. */
  readonly nitro = new Nitro();
  private nearMiss: NearMissDetector;
  private passengers: PassengersView;
  private marker: StopMarker;
  private arrow: NavArrow;
  private nav: Navigator;
  private minimap: MiniMap;
  /** Legal path from the bus to the active stop, refreshed a few times a second. */
  path: NavPath | null = null;
  private sinceReplan = Infinity;
  private minimapClock = 0;
  private hud: GameHud;
  private rng = new Rng(Date.now() & 0xffff);
  private knocked = 0;
  private busPos = new THREE.Vector3();
  private runs = 0;
  private startedFlag = false;
  private start0: RoadPose;
  readonly traffic: TrafficSim;
  readonly trafficBodies: TrafficBodies;
  readonly peds: PedestrianSim;
  private trafficView: TrafficView;
  private pedView: PedestrianView;
  private metro: MetroCrowd;
  private metroView: PedestrianView;
  private frustum = new THREE.Frustum();
  private viewProj = new THREE.Matrix4();
  private probe = new THREE.Vector3();
  private dives = 0;
  private clock = 0;
  private budget = START_CARS;
  private fpsLowFor = 0;
  private fpsHighFor = 0;
  private sinceRecycle = 0;

  constructor(private d: SessionDeps) {
    this.passengers = new PassengersView(d.scene, d.city);
    this.marker = new StopMarker(d.scene, d.city);
    this.arrow = new NavArrow(d.scene);
    this.hud = new GameHud(d.hudRoot, d.route?.name ?? 'Paseo libre', !d.route);
    this.nav = new Navigator(d.graph);
    this.minimap = new MiniMap(d.hudRoot, d.city);
    this.start0 = d.route ? startPose(d.city, d.graph, d.route) : freeStartPose(d.city, d.graph);
    if (d.route) this.stars = starThresholds(routeStops(d.city, d.route), routeLegs(d.city, d.route, d.graph), this.start0.pos);
    const spawn = this.start0.pos;
    const graph = d.graph;
    this.traffic = new TrafficSim(graph, d.city, { seed: 11, count: MAX_CARS, avoid: { pos: spawn, radius: 25 } });
    this.traffic.setBudget(this.budget, spawn);
    this.trafficBodies = new TrafficBodies(d.world, this.traffic, laneSurface(d.city, graph, this.traffic, d.world));
    // Near misses are about traffic: scenery (walls, trees, props) doesn't score.
    this.nearMiss = new NearMissDetector(d.world, d.bus, (c) => this.trafficBodies.isCar(c));
    this.trafficView = new TrafficView(d.scene, this.traffic, this.trafficBodies);
    this.peds = new PedestrianSim(d.city, graph, { seed: 5, count: PEDESTRIANS });
    const focus = { pos: spawn, heading: this.start0.heading };
    this.traffic.recycle(focus, true);
    this.peds.recycle(focus, true);
    this.pedView = new PedestrianView(d.scene, this.peds, d.city);
    // Metro riders mill about in front of the entrances, off the asphalt and out of buildings.
    this.metro = new MetroCrowd(d.city.metro ?? [], {
      walkable: (p) => !nearestRoad(d.city, p) && !d.city.buildings.some((b) => pointInPolygon(p, b.footprint)),
    });
    this.metroView = new PedestrianView(d.scene, this.metro, d.city);
    this.restart();
  }

  set onHudAction(fn: ((a: import('../ui/gameHud').HudAction) => void) | null) {
    this.hud.onAction = fn;
  }

  showPause(on: boolean): void {
    this.hud.showPause(on);
  }

  /** Starts the clock (first throttle press). */
  start(): void {
    if (this.startedFlag || this.game?.over) return;
    this.startedFlag = true;
    if (!this.game) return;
    this.game.start();
    this.say('board');
  }

  restart(): void {
    const { city, bus } = this.d;
    this.runs++;
    this.passengers.clear();
    const { pos, heading, y, pitch } = this.start0;
    this.scorer = new TrickScorer();
    this.nitro.reset();
    this.startedFlag = false;
    if (this.d.route) {
      const game = new RouteGame(routeStops(city, this.d.route), {
        seed: this.runs * 7919 + (Date.now() & 0xff),
        capacity: bus.preset.capacity,
        start: pos,
      });
      this.game = game;
      this.missions = new Missions(pickMissions(this.rng.int(0, 0xffff)));
      this.hud.showMissions(this.missions.list);
      this.hud.showTargets(this.stars);
      game.route.forEach((r, i) => this.passengers.showWaiting(r, game.waitingAt(i)));
      this.retarget();
    } else {
      this.marker.visible = false;
      this.arrow.point(null);
    }
    this.hud.showResults(null);
    bus.reset({ x: pos.x, y, z: pos.z, heading, pitch });
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
    if (!this.startedFlag || this.game?.over) {
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
    if (this.scorer.sliding) this.nitro.drifting(dt);
    for (const t of tricks) this.onTrick(t);
    if (this.nitro.active && !this.wasBoosting) this.mission({ type: 'nitro' });
    this.wasBoosting = this.nitro.active;

    if (!this.game) return;
    const p = bus.body.translation();
    for (const e of this.game.update(dt, { pos: { x: p.x, z: p.z }, speed: bus.speed })) this.onGame(e);
  }

  /** Called every rendered frame. */
  frame(dt: number, camera: THREE.Camera, mode: CameraMode): void {
    const bus = this.d.bus;
    this.clock += dt;
    this.trafficView.sync();
    this.pedView.sync(this.clock);
    // People may only appear or vanish off-screen (or far away).
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    const eye = camera.position;
    const hidden = (p: Vec2) => Math.hypot(p.x - eye.x, p.z - eye.z) > 120 || !this.frustum.containsPoint(this.probe.set(p.x, groundHeightAt(this.d.city, p) + 1, p.z));
    this.metro.update(dt, { x: bus.body.translation().x, z: bus.body.translation().z }, hidden);
    this.metroView.sync(this.clock);
    this.knocked += this.d.props.consumeKnocked();
    const t = bus.body.translation();
    this.busPos.set(t.x, t.y, t.z);
    const game = this.game;
    this.passengers.update(dt, bus, game?.activeStop.stop.side === 'left');
    this.marker.update(dt);
    this.guide(dt);
    this.arrow.update(camera, mode, this.busPos);
    if (game) {
      const zone = game.activeStop.zone;
      this.hud.board(game.activeStop.stop.name, Math.hypot(zone.x - t.x, zone.z - t.z), this.gettingOff());
    }
    this.hud.update(dt, {
      timeLeft: game?.timeLeft ?? 0,
      cents: game?.cents ?? 0,
      onBoard: game?.onBoard.length ?? 0,
      capacity: bus.preset.capacity,
      chain: this.scorer.chain,
      started: this.startedFlag,
      nitro: this.nitro.level,
      nitroReady: this.nitro.ready,
      boosting: this.nitro.active,
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
    if (t.kind === 'nearMiss') this.nitro.nearMiss();
    if (t.kind === 'crash') {
      this.d.audio.cue('crash');
      // Rammed the roadworks at the edge of the map.
      const p = this.d.bus.body.translation();
      if (this.d.city.playArea && !inPlayArea(this.d.city, { x: p.x, z: p.z }, 12)) return this.say('works');
      this.mission({ type: 'crash' });
      if (this.game?.onBoard.length) this.say('crash');
      return;
    }
    // Free roam: nothing to score.
    if (!this.game) return;
    this.game.addCents(t.cents);
    this.mission({ type: 'trick', kind: t.kind, cents: t.cents, duration: t.duration, chain: this.scorer.chain });
    const mult = t.multiplier > 1 ? ` ×${t.multiplier}` : '';
    this.hud.popup(`+${money(t.cents)} ${TRICK_LABEL[t.kind]}${mult}`);
    if (!this.game.onBoard.length) return;
    if (t.kind === 'air') this.say('air');
    else if (t.kind === 'drift' || t.kind === 'nearMiss') this.say('scared', 0.5);
  }

  private onGame(e: GameEvent): void {
    const game = this.game;
    if (!game) return;
    switch (e.type) {
      case 'fare':
        this.d.audio.cue('coin');
        this.hud.popup(`+${money(e.cents)} ${RATING_LABEL[e.rating]}`, e.rating === 'slow' ? 'bad' : 'money');
        if (e.rating === 'fast') this.say('happy', 0.6);
        if (e.rating === 'slow') this.say('grumpy', 0.8);
        this.mission({ type: 'fare', rating: e.rating });
        break;
      case 'arrive': {
        this.passengers.alight(e.alighted, this.d.bus, game.route[e.stopIndex].stop);
        this.passengers.board(e.boarded);
        this.d.audio.doors();
        this.passengers.showWaiting(game.route[e.stopIndex], game.waitingAt(e.stopIndex));
        this.d.audio.cue('time');
        this.hud.popup(`+${e.timeBonus} s ${RATING_LABEL[e.rating]}`, 'time');
        if (e.boarded.length) this.say('board', 0.7);
        this.retarget();
        this.mission({ type: 'arrive', rating: e.rating });
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
        this.finish(game);
        break;
    }
  }

  /** Feeds a shift event to the missions; a finished one pays its bonus. */
  private mission(e: MissionEvent): void {
    const game = this.game;
    if (!game || !this.missions || game.over) return;
    for (const m of this.missions.feed(e)) {
      game.addCents(m.def.reward);
      this.d.audio.cue('coin');
      this.hud.missionDone(m);
    }
    this.hud.updateMissions(this.missions.list);
  }

  /** End of the shift: stars, the route's records, missions, and the results screen. */
  private finish(game: RouteGame): void {
    const stars = this.stars ? starsFor(game.cents, this.stars) : 0;
    const done = this.missions?.completed ?? [];
    const route = this.d.route!;
    const placing = recordShift(this.d.zone, route.id, {
      cents: game.cents,
      delivered: game.delivered,
      bestCombo: this.scorer.bestCombo,
      stars,
      bus: this.d.bus.preset.id,
      date: Date.now(),
    });
    recordMissions(done.map((m) => m.def.id));
    this.hud.showResults({
      cents: game.cents,
      delivered: game.delivered,
      bestCombo: this.scorer.bestCombo,
      longestAir: this.scorer.longestAir,
      stars,
      thresholds: this.stars,
      placing,
      missions: this.missions?.list ?? [],
    });
  }

  private gettingOff(): number {
    const game = this.game;
    return game ? game.onBoard.filter((p) => p.to === game.activeIndex).length : 0;
  }

  private retarget(): void {
    if (!this.game) return;
    const zone = this.game.activeStop.zone;
    const off = this.gettingOff() > 0;
    this.marker.visible = true;
    this.marker.place(zone, off);
    this.arrow.point(zone, this.targetColor());
    this.sinceReplan = Infinity; // new stop: plan a fresh path now
  }

  private targetColor(): string {
    return this.gettingOff() > 0 ? '#ffd23f' : '#3dff8a';
  }

  /**
   * GPS: keep a legal path (one-way streets respected) from the bus to the active stop, aim
   * the arrow along it, and draw it on the minimap.
   */
  private guide(dt: number): void {
    const bus = this.d.bus;
    const here = { x: this.busPos.x, z: this.busPos.z };
    this.minimapClock += dt;
    // Free roam: just the streets around you.
    if (!this.game) {
      if (this.minimapClock >= 1 / 30) {
        this.minimapClock = 0;
        this.minimap.update(here, bus.heading, null, null, this.targetColor(), []);
      }
      return;
    }
    const { zone, stop } = this.game.activeStop;
    this.sinceReplan += dt;
    const offPath = this.path && !this.path.points.some((p) => Math.hypot(p.x - here.x, p.z - here.z) < 20);
    if (!this.game.over && (this.sinceReplan > 0.5 || offPath)) {
      this.sinceReplan = 0;
      const ground = (p: Vec2) => groundHeightAt(this.d.city, p);
      const from = this.nav.locate(here, bus.heading, bus.roadHeight(), ground);
      // Stops are never on ramps or decks: at street level.
      const to = this.nav.locate(zone, stop.heading, ground(zone), ground);
      this.path = from && to ? this.nav.route(from, to) : null;
    }
    const close = Math.hypot(zone.x - here.x, zone.z - here.z) < 45;
    if (!this.game.over) this.arrow.point(close || !this.path ? zone : this.nav.guidePoint(this.path, here, 35));
    if (this.minimapClock >= 1 / 30) {
      this.minimapClock = 0;
      const stops = this.game.route.map((r) => r.zone);
      this.minimap.update(here, bus.heading, this.game.over ? null : (this.path?.points ?? null), this.game.over ? null : zone, this.targetColor(), stops);
    }
  }

  private say(kind: LineKind, chance = 1): void {
    if (this.rng.next() > chance) return;
    this.hud.say(SPEAKER[kind], this.rng.pick(LINES[kind]));
  }
}
