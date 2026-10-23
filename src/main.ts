import * as THREE from 'three';
import { AdaptiveQuality, scaleAt } from './core/adaptiveQuality';
import { initRapier, createWorld, addGround, PHYSICS_STEP } from './physics/world';
import { staticObstacles } from './physics/cameraObstacles';
import { Input } from './core/input';
import { BusAudio } from './core/audio';
import { Radio } from './core/radio';
import { engineLoad, isBraking } from './core/soundModel';
import { BusPhysics } from './vehicle/bus';
import { BusModel } from './vehicle/busModel';
import { CameraRig } from './camera/cameraRig';
import { LIGHTING, parseTimeOfDay, setupSky, followSun } from './world/sky';
import { buildBackdrop } from './world/backdrop';
import { buildCity } from './world/cityBuilder';
import { groundHeightAt, nearestRoad } from './world/cityData';
import { buildRoadGraph } from './world/roadGraph';
import { DEFAULT_ZONE } from './world/loadCity';
import type { CityData } from './world/cityData';
import { snapToRoad } from './world/roadSnap';
import { vehicleClearance } from './physics/clearance';
import { Hud } from './ui/hud';
import { TouchControls, isTouchDevice } from './ui/touchControls';
import { GameSession } from './gameplay/session';
import { BRT_BUS, VEHICLES, busById } from './vehicle/buses';
import { isTrain } from './vehicle/busPreset';
import { routesFor } from './gameplay/routes';
import { loadSettings, saveSettings } from './menu/settings';
import { RadioToast } from './ui/radioToast';
import { Tutorial } from './ui/tutorial';
import { Weather, gripFor, parseRainSetting } from './gameplay/weather';
import { FloodWater, floodBasins, floodedEdges, waterDepth } from './world/floods';
import { RainView } from './world/rain';
import { BORE_HALF, BORE_TOP, type TrackData, inTunnel, locateOnTrack, trackPose } from './world/track';
import { FALL_BACK, FallWatch } from './gameplay/fallWatch';
import { OffRoad } from './gameplay/offRoad';
import { RaceSession } from './gameplay/raceSession';
import { TireSmoke, dustOf, smokeOf } from './vehicle/tireSmoke';
import { distToPolyline } from './world/geom';
import { OnlineRace, joinOnline } from './net/onlineRace';
import { loadSession } from './net/connection';
import { MAX_RIVALS, TRACK_TRAFFIC, gridSlots, parseRivalChoice, rivalVehicles } from './gameplay/raceField';

const MAX_FRAME = 0.1;
/** Online the weather's clock starts this long before GO (s): when the countdown starts. */
const COUNTDOWN_LEAD = 4.5;
/** Haze on a mountain track (m), the same in the near scene and the far view. */
const TRACK_FOG = { near: 150, far: 16000 };
/** A river is heard from this far off (m), loudest within RIVER_NEAR. */
const RIVER_FAR = 160;
const RIVER_NEAR = 25;
/** A waterfall is heard from this far off (m), loudest within FALL_NEAR. */
const FALL_FAR = 420;
const FALL_NEAR = 60;

/**
 * Runs a shift (started by `boot.ts`, which shows the menu otherwise). `cityReady` is the city
 * from the URL, already loading while this chunk (three.js, Rapier, the game) downloads.
 */
export async function main(params: URLSearchParams, cityReady: Promise<CityData>) {
  const settings = loadSettings();
  const tod = parseTimeOfDay(params.get('tod')) ?? settings.timeOfDay;
  performance.mark('qbus:start');
  await initRapier();
  performance.mark('qbus:rapier');

  const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Phones have tiny, very dense screens and weak GPUs: one pixel per CSS pixel is plenty.
  const touch = isTouchDevice();
  const maxRatio = Math.min(devicePixelRatio, touch ? 1 : 1.5);
  renderer.setPixelRatio(maxRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  // The city camera only needs to reach past the fog; far scenery has its own pass and camera.
  const camera = new THREE.PerspectiveCamera(68, 1, 0.3, 3000);
  const farCamera = new THREE.PerspectiveCamera(68, 1, 20, 120000);
  renderer.autoClear = false;
  renderer.setClearColor(LIGHTING[tod].horizon);
  // Size to what the canvas actually covers (CSS keeps it on the whole window): on phones the
  // window's size is briefly wrong while rotating, and a stale size leaves bars at the sides.
  const resize = () => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  addEventListener('orientationchange', () => setTimeout(resize, 300));
  resize();

  const sun = setupSky(scene, tod);
  const world = createWorld();
  const city = await cityReady;
  performance.mark('qbus:city-loaded');
  // Out in the mountains the air is clear: a long, light haze (the far view's too, so the near
  // terrain and the far one meet without a seam) instead of a city's fog.
  if (city.race) {
    const fog = scene.fog as THREE.Fog;
    fog.near = TRACK_FOG.near;
    fog.far = TRACK_FOG.far;
  }
  if (!city.terrain) addGround(world, Math.max(city.bounds.max.x - city.bounds.min.x, city.bounds.max.z - city.bounds.min.z) + 500);
  const graph = buildRoadGraph(city);
  performance.mark('qbus:graph');
  const { props, signals } = buildCity(city, world, scene, graph);
  performance.mark('qbus:city-built');
  const { min, max } = city.bounds;
  const backdrop = buildBackdrop(city, Math.max(...[min.x, max.x].flatMap((x) => [min.z, max.z].map((z) => Math.hypot(x, z)))), tod);
  if (city.race) Object.assign(backdrop.fog as THREE.Fog, TRACK_FOG);

  // Free roam (?mode=free) has no route; a route shift is always driven in a bus. A race
  // (?mode=race on a track: `&rivals=1..3`, `&rivalBus=mixed|same|<vehicle id>`,
  // `&skill=easy|normal|hard`, `&traffic=1`, `&slides=0` for none on a track that has them) has none either, and any vehicle.
  // Online (?mode=online&room=K7Q2, from the menu's lobby): a race whose grid, vehicles and GO
  // come from the room; the page waits for everyone to have the track loaded.
  const online = params.get('mode') === 'online' && !!city.race;
  const raceMode = (params.get('mode') === 'race' || online) && !!city.race;
  const roomCode = params.get('room') ?? '';
  const seat = online ? loadSession() : null;
  const joined = online && seat && seat.code === roomCode ? await joinOnline(roomCode, { name: seat.name, vehicle: settings.bus, token: seat.token }, document.querySelector<HTMLElement>('#hud')!) : null;
  if (online && !joined) {
    // Not this room's (a stale or shared link): back to the menu.
    location.search = '';
    return;
  }
  const free = params.get('mode') === 'free' || raceMode;
  const routes = free ? [] : routesFor(city);
  const route = free ? null : (routes.find((r) => r.id === params.get('route')) ?? routes[0]);
  // A link without ?bus= to a Trolebús/Ecovía route takes the articulated bus, like the menu.
  const mine = joined ? joined.go.grid.find((g) => g.kind === 'human' && g.seat === joined.conn.seat) : undefined;
  const picked = busById(mine?.vehicle ?? params.get('bus') ?? (route?.system ? BRT_BUS : settings.bus));
  const preset = free || !picked.kind || picked.kind === 'bus' ? picked : busById('popular');
  const { pos, heading } = city.spawn;
  const bus = new BusPhysics(world, preset, { x: pos.x, y: groundHeightAt(city, pos), z: pos.z, heading });
  const fits = vehicleClearance(world, preset.body);
  const model = new BusModel(preset);
  model.setHeadlights(LIGHTING[tod].headlights);
  scene.add(model.root);

  const input = new Input();
  // The gusanito runs on a car's engine and has no doors to hiss.
  const audio = new BusAudio(preset.kind === 'car' || isTrain(preset) ? 'car' : 'bus');
  // The chase camera stays out of walls and roofs (tunnels, cuts, buildings).
  const obstacles = staticObstacles(world);
  const rig = new CameraRig(camera, obstacles);
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;
  const hud = new Hud(hudRoot, city.attribution, !!city.race);
  // Records are kept per zone and route (a generated city other than the default seed is its own zone).
  const zone = params.get('city') ?? (params.has('seed') ? `grid-${params.get('seed')}` : DEFAULT_ZONE);
  const rivals = Math.max(1, Math.min(MAX_RIVALS, Number(params.get('rivals') ?? 1) || 1));
  const skill = (['easy', 'normal', 'hard'] as const).find((k) => k === params.get('skill')) ?? 'normal';
  const ids = VEHICLES.map((v) => v.preset.id);
  const net = joined ? new OnlineRace(joined.conn, joined, world, city.race!, roomCode) : null;
  const field = net ? net.localAi.map((a) => a.vehicle) : raceMode ? rivalVehicles(parseRivalChoice(params.get('rivalBus'), ids), preset.id, rivals, ids) : [];
  const grid = net ? [...net.localAi.map((a) => a.slot), net.slots[net.me]] : raceMode ? gridSlots(city.race!, [...field.map((id) => busById(id).body.length), preset.body.length]) : null;
  // Traffic on a track only if asked for (free roam on one too).
  const trackTraffic = city.race && params.get('traffic') === '1' ? TRACK_TRAFFIC : 0;
  const session = new GameSession({ world, scene, city, bus, props, signals, audio, hudRoot, graph, route, zone, start: grid?.[grid.length - 1], title: net ? 'Carrera en línea' : raceMode ? 'Carrera' : undefined, trackTraffic });
  const racing = raceMode
    ? new RaceSession(world, scene, city.race!, zone, { bus, preset, nitro: session.nitro }, audio, hudRoot, { vehicles: field, slots: grid!, skill, traffic: trackTraffic ? { sim: session.traffic, trackS: session.trackS } : null, ground: (p) => groundHeightAt(city, p), seed: joined?.go.seed, slides: params.get('slides') === '0' ? false : undefined, online: net ? { keys: net.keys, goIn: () => net.goIn(), remotes: net.remotes } : null })
    : null;
  if (racing) {
    session.racers = racing.buses;
    session.hazards = racing.slideObstacles;
    session.marks = racing.slideMarks;
  }
  // Tire smoke (drifts, a spinning launch) and dust off the asphalt, everyone's in one draw.
  const smoke = new TireSmoke(scene, tod === 'night' ? 0.4 : tod === 'sunset' ? 0.75 : 1);
  if (racing) racing.smoke = smoke;
  if (touch) new TouchControls(document.body, input);
  audio.setVolume(settings.volume);
  // The radio keeps its own level (under the engine) and plays straight to the speakers.
  const radio = new Radio(settings.radio, settings.volume * settings.musicVolume);
  const radioToast = new RadioToast(hudRoot);
  radio.onTune = (st, song) => st && radioToast.show(st.id, song);
  radio.onSong = (_st, song) => radioToast.showSong(song);
  if (settings.camera === 'cockpit') rig.toggle();

  let paused = false;
  const setPaused = (on: boolean) => {
    paused = on && !session.game?.over;
    session.showPause(paused);
  };
  const toMenu = () => (location.search = '');
  const again = () => {
    setPaused(false);
    session.restart();
    racing?.restart();
    fall.reset();
    offRoad.reset();
    trackS = -1;
    smoke.clear();
  };
  session.onHudAction = (a) => {
    if (a === 'resume') setPaused(false);
    if (a === 'menu') toMenu();
    if (a === 'again') again();
  };
  if (racing) racing.hud.onAction = (a) => (a === 'menu' ? (net ? net.leave() : toMenu()) : a === 'lobby' ? net?.toLobby() : a === 'watchPrev' ? racing.spectateStep(-1) : a === 'watchNext' ? racing.spectateStep(1) : a === 'results' ? racing.openResults() : a === 'endNow' ? racing.endNow() : a === 'keep' ? racing.closeResults() : again());
  if (net && racing) net.attach(racing);
  // A page back in a race already running (reload, reopened tab): the bus goes where the room last saw it.
  if (net && racing) {
    const back = net.resumeAt();
    if (back) {
      racing.resume(back.player, back.ai);
      if (joined?.rows) racing.applyResults(joined.rows, false);
    }
  }
  if (racing) racing.camera = camera;

  // How to play, every time a shift, free roam or a race starts (unless turned off, or ?tutorial=0).
  // A race's grid waits for it to close.
  const tutorial = new Tutorial(hudRoot, free, session.stars, !!route?.system, racing ? { from: city.race!.from, to: city.race!.to, traffic: trackTraffic > 0, slides: !!racing.slides } : null);
  tutorial.onClose = (dontShow) => dontShow && saveSettings({ ...loadSettings(), tutorial: false });
  // Online the countdown runs on the room's clock: no card to hold it.
  if (settings.tutorial && params.get('tutorial') !== '0' && !net) tutorial.show();

  // Weather: showers at random moments, or always, or never (a setting; ?rain= overrides: 0 never,
  // 1 raining, 2 a downpour that floods the underpasses, or a setting's name).
  const rainParam = params.get('rain');
  // Online everyone gets the same showers (the room's seed).
  const weatherSeed = joined?.go.seed ?? Math.floor(Math.random() * 2 ** 31);
  const weather =
    rainParam === '0' ? new Weather('off', weatherSeed)
    : rainParam === '1' || rainParam === '2' ? new Weather('always', weatherSeed, rainParam === '2' ? 1 : 0.55)
    : new Weather(parseRainSetting(rainParam) ?? settings.rain, weatherSeed);
  const basins = floodBasins(city);
  const floodWater = new FloodWater(basins);
  scene.add(floodWater.mesh);
  const flooded = floodedEdges(basins, graph);
  const rain = new RainView(scene, backdrop, renderer, tod);
  rain.onThunder = (d) => audio.thunder(d);
  let covered = false;
  let weatherClock = Infinity;
  /** Weather seconds run so far (online: on the room's clock). */
  let weatherTime = 0;
  let rained = false;
  let floodedNews = false;
  // On a mountain track: going over the edge puts the bus back on the road a little behind.
  const race = city.race ?? null;
  const fall = new FallWatch();
  const offRoad = new OffRoad();
  // An R reset or the off-road countdown running out: back in lane `off` at `s`, then the wait.
  const putBackOnTrack = (race: TrackData, s: number, off: number) => {
    const at = trackPose(race, s, off);
    bus.reset({ x: at.pos.x, y: at.y, z: at.pos.z, heading: at.heading, pitch: at.pitch });
    session.trafficBodies.clearSpot({ x: at.pos.x, y: at.y, z: at.pos.z, heading: at.heading }, preset.body.length, preset.body.width);
    racing?.playerReset();
    fall.reset();
    offRoad.reset();
    trackS = -1;
  };
  let trackS = -1;
  /** How far past the asphalt's edge the bus is (m, negative on it), on a track. */
  let offEdge = -1;
  let river = 0;
  let fallSound = 0;
  /** 0..1: how far into a tunnel the camera is (eased). */
  let tunnelK = 0;
  let tunnelOpen = 0;

  performance.mark('qbus:session');
  // Weak GPUs: render fewer pixels (and smaller shadows) while the frame rate stays low. Automation
  // (Playwright's software GL is always slow) keeps full quality unless ?adaptive=1.
  const adaptive = params.get('adaptive') === '1' || (params.get('adaptive') !== '0' && !navigator.webdriver);
  const quality = new AdaptiveQuality();
  // Per-frame cost breakdown (ms, smoothed) and both passes' draw stats, for tools/tests.
  const perf = { sim: 0, frame: 0, render: 0, calls: 0, triangles: 0, backdropCalls: 0, steps: 0 };
  renderer.info.autoReset = false;
  if (import.meta.env.DEV) (window as any).__qbus = { quality, smoke, bus, audio, radio, rig, input, city, props, renderer, scene, backdrop, session, route, tutorial, perf, weather, basins, timeOfDay: tod, fall, racing, online: net, groundAt: (p: { x: number; z: number }) => groundHeightAt(city, p) };

  const scratchPos = { x: 0, y: 0, z: 0 };
  const earFwd = new THREE.Vector3();
  const earUp = new THREE.Vector3();
  const ear = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };
  let acc = 0;
  let last = performance.now();
  let flippedFor = 0;
  let street = '';
  let streetClock = Infinity;
  let fps = 60;
  let wasBoosting = false;

  const smooth = (prev: number, ms: number) => prev + (ms - prev) * 0.1;
  renderer.setAnimationLoop((now) => {
    const t0 = performance.now();
    const raw = (now - last) / 1000;
    // rAF timestamps can precede the first performance.now(): never let dt go negative.
    const dt = Math.max(0, Math.min(MAX_FRAME, raw));
    last = now;
    if (raw > 0) fps += (1 / raw - fps) * 0.05;
    session.adaptTraffic(fps, dt);
    // Skip frames after a stall (tab switch, loading): they say nothing about the GPU.
    if (adaptive && raw > 0 && raw < 1 && quality.update(fps, raw)) {
      renderer.setPixelRatio(maxRatio * scaleAt(quality.level));
      resize();
      if (quality.shadowsLow && sun.shadow.mapSize.x > 1024) {
        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    }

    for (const action of input.consumeActions()) {
      if (tutorial.open) {
        tutorial.action(action);
        continue;
      }
      if (action === 'camera') rig.toggle();
      if (action === 'reset' && racing && race) {
        // In a race: back in its lane where it was on the road, then a wait before it may go on
        // (so R is no shortcut out of a crash). Not on the grid: it would only lose the slot.
        if (!racing.canReset) continue;
        const p = bus.position(scratchPos);
        const at = trackS >= 0 ? locateOnTrack(race, p, trackS, 120) : locateOnTrack(race, p);
        putBackOnTrack(race, Math.max(race.start, trackS >= 0 ? trackS : at.s), at.off < 0 ? -2.1 : 2.1);
      } else if (action === 'reset') {
        const t = bus.position();
        // A road at the level the bus is on, on a spot where it fits (clear of walls and roofs).
        const s = snapToRoad(city, { x: t.x, z: t.z }, bus.heading, bus.roadHeight(), { clear: fits, length: preset.body.length, vehicle: route?.system ? 'brt' : 'general' });
        bus.reset({ x: s.pos.x, y: s.y, z: s.pos.z, heading: s.heading, pitch: s.pitch });
        // Cars aren't static world, so the spot can still hold one: send them elsewhere.
        session.trafficBodies.clearSpot({ x: s.pos.x, y: s.y, z: s.pos.z, heading: s.heading }, preset.body.length, preset.body.width);
      }
      // Watching the others after the finish: ←/→ (LB/RB, touch arrows) switch, Esc the full results (and back).
      if (racing && racing.spectating !== null && !paused) {
        if (action === 'watchPrev') racing.spectateStep(-1);
        if (action === 'watchNext') racing.spectateStep(1);
        if (action === 'pause') {
          if (racing.resultsOpen) racing.closeResults();
          else racing.openResults();
          continue;
        }
      }
      if (action === 'pause') setPaused(!paused);
      if (action === 'radio') {
        radioToast.show(radio.next(), radio.onAir()?.song ?? null);
        // The station you leave it on is the one the next game starts with.
        saveSettings({ ...loadSettings(), radio: radio.station });
      }
      if (paused) continue;
      if (action === 'restart' && session.game?.over) session.restart();
      if (action === 'restart' && racing?.over && (racing.resultsOpen || racing.spectating === null)) {
        if (net) net.toLobby();
        else again();
      }
      if (action === 'horn') session.playerHonk();
    }

    // Weather: wet tires, floodwater in the underpasses (the bus wades, traffic crawls through).
    // Online the showers follow the room's clock (from the countdown's start), not this page's:
    // a page that loaded later, or a tab left in the background, catches up in short steps.
    let w = weather.state;
    if (net) {
      const due = Math.max(0, COUNTDOWN_LEAD - net.goIn()) - weatherTime;
      for (let left = due; left > 0; left -= MAX_FRAME) w = weather.update(Math.min(left, MAX_FRAME));
      weatherTime += Math.max(0, due);
    } else w = weather.update(paused ? 0 : dt);
    bus.grip = gripFor(w.wet) * (racing?.playerGrip ?? 1);
    if (racing) {
      racing.weatherGrip = gripFor(w.wet);
      racing.wet = w.wet;
    }
    floodWater.setFlood(w.flood);
    bus.wade = waterDepth(basins, bus.position(scratchPos), bus.roadHeight(), w.flood);
    weatherClock += dt;
    if (weatherClock >= 0.25) {
      weatherClock = 0;
      // Under a roof (a tunnel, a deck): no rain falls around the camera, and it sounds far off.
      covered = obstacles.cast(camera.position.x, camera.position.y, camera.position.z, 0, 1, 0, 40) < 40;
      session.traffic.speedScale = 1 - 0.15 * w.wet;
      session.traffic.slowEdges.clear();
      for (const f of flooded) if (basins[f.basin].floor + w.flood > f.low + 0.15) session.traffic.slowEdges.set(f.edge, 3.5);
      if (!rained && w.rain > 0.2) session.weatherNews('rain');
      rained = w.rain > 0.2 || (rained && w.rain > 0);
      if (!floodedNews && w.flood > 0.2) session.weatherNews('flood');
      floodedNews = w.flood > 0.2 || (floodedNews && w.flood > 0);
      // Rivers down in the valley: heard from the camera when one is near.
      let d = Infinity;
      for (const rv of race?.scenery?.rivers ?? []) d = Math.min(d, distToPolyline({ x: camera.position.x, z: camera.position.z }, rv.points));
      river = Math.max(0, Math.min(1, (RIVER_FAR - d) / (RIVER_FAR - RIVER_NEAR))) ** 2;
      // Waterfalls: heard from far (they roar), loudest right at the water.
      let df = Infinity;
      for (const wf of race?.scenery?.waterfalls ?? []) df = Math.min(df, distToPolyline({ x: camera.position.x, z: camera.position.z }, wf.points));
      fallSound = tunnelK > 0.5 ? 0 : Math.max(0, Math.min(1, (FALL_FAR - df) / (FALL_FAR - FALL_NEAR))) ** 1.5;
    }

    // The tutorial holds the bus still: the clock only starts on the first throttle after it.
    const drive = paused || tutorial.open ? { throttle: 0, steer: 0, handbrake: false } : input.drive();
    if (drive.throttle > 0 || drive.boost) session.start();
    // Paused: the world stands still (but keeps rendering behind the menu).
    // Online the race doesn't wait: pausing only shows the menu.
    const frozen = paused && !net;
    acc = frozen ? 0 : acc + dt;
    let steps = 0;
    while (acc >= PHYSICS_STEP) {
      steps++;
      if (racing) {
        // Held on the brakes until GO and through an R reset's wait (the nitro too: the tank
        // neither burns nor flames), then the launch's effect on the input.
        racing.step(PHYSICS_STEP);
        bus.update(racing.playerInput(drive, session.nitro.step(!!drive.boost && !racing.playerHeld, PHYSICS_STEP)), PHYSICS_STEP);
      } else bus.update({ ...drive, boost: session.nitro.step(!!drive.boost, PHYSICS_STEP) }, PHYSICS_STEP);
      if (net) {
        net.beforeStep(acc - PHYSICS_STEP, PHYSICS_STEP);
        net.tick(PHYSICS_STEP, bus, drive.throttle, input.hornHeld);
      }
      session.beforeStep(PHYSICS_STEP);
      racing?.bumpBefore();
      world.step();
      racing?.bumpAfter(PHYSICS_STEP);
      session.physicsStep(PHYSICS_STEP);
      acc -= PHYSICS_STEP;
    }

    const t1 = performance.now();
    const q = bus.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    flippedFor = upY < 0.3 ? flippedFor + dt : 0;

    if (race && !frozen) {
      const p = bus.position(scratchPos);
      // Near the last spot (cheap), by position and height; off that stretch of road (a teleport,
      // an R reset onto another leg), the whole track.
      let here = locateOnTrack(race, p, trackS, 120);
      if (Math.hypot(here.off, here.y - p.y) > 25) here = locateOnTrack(race, p);
      // Down a ravine the nearest bit of road can be a hairpin's other leg: keep the last good spot.
      if (!fall.falling) trackS = here.s;
      offEdge = fall.falling ? -1 : Math.abs(here.off) - race.width / 2;
      const ev = fall.update(dt, { roadY: here.y, busY: p.y, off: here.off, halfWidth: race.width / 2, wheelsOnGround: bus.wheelsOnGround });
      if (ev === 'fell') session.notice('¡Al barranco!');
      if (ev === 'respawn') {
        const s = trackPose(race, Math.max(race.start - 12, trackS - FALL_BACK));
        bus.reset({ x: s.pos.x, y: s.y, z: s.pos.z, heading: s.heading, pitch: s.pitch });
        trackS = -1;
        racing?.playerFell();
        offRoad.reset();
      }
      // Wandering on the mountain: a countdown, then back on the road where it left.
      if (racing) {
        const lost = offRoad.update(dt, { edge: offEdge, s: here.s, off: here.off, wheels: bus.wheelsOnGround, active: racing.canReset && !racing.playerHeld && !fall.falling });
        racing.offRoad = offRoad.countdown;
        if (lost) {
          session.notice('¡Fuera de la vía!', 'bad');
          putBackOnTrack(race, Math.max(race.start, offRoad.departS), offRoad.side * 2.1);
        }
      }
    }
    props.sync();
    model.sync(bus);
    model.setGhost(racing?.ghostFade ?? 1);
    if (!paused) {
      const spin = racing && racing.playerGrip < 1 ? drive.throttle : 0;
      smoke.emit(bus, smokeOf(bus.slipAngle, bus.speed, spin), dustOf(offEdge, bus.speed), dt, bus.mud);
    }
    smoke.update(paused ? 0 : dt);
    const lookBack = input.lookBackHeld;
    // The finish line's trackside camera, while it rolls.
    rig.trackside = racing?.finishView ?? null;
    // After the finish the camera follows another racer (chase view, no looking back).
    const watched = racing?.spectateTarget() ?? null;
    rig.forceChase = !!watched;
    document.body.classList.toggle('watching', !!watched);
    model.root.visible = !racing?.playerHidden;
    // Looking back from the driver's seat (or from beside the road) needs the bus's outside to be there to look at.
    model.setCockpitView(rig.mode === 'cockpit' && !lookBack && !rig.trackside && !watched);
    rig.update(dt, watched ?? bus, watched ? false : lookBack);
    followSun(sun, model.root.position);
    const spray = bus.wade > 0.05 ? Math.min(1, Math.abs(bus.speed) / 10) * Math.min(1, bus.wade / 0.4) : 0;
    model.setSpray(spray);
    if (racing) {
      racing.frame(frozen ? 0 : dt, drive.throttle, !paused && !tutorial.open);
      session.others = racing.others as { x: number; z: number; color?: string }[];
      for (const n of racing.notices) session.notice(n.text, n.tone);
      racing.notices.length = 0;
      // The rivals' engines, heard from the camera.
      camera.getWorldDirection(earFwd);
      earUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      const c = camera.position;
      ear.x = c.x;
      ear.y = c.y;
      ear.z = c.z;
      ear.fx = earFwd.x;
      ear.fy = earFwd.y;
      ear.fz = earFwd.z;
      ear.ux = earUp.x;
      ear.uy = earUp.y;
      ear.uz = earUp.z;
      audio.rivals(racing.voices, ear);
    }
    session.frame(dt, camera, rig.mode);
    const speedFrac = Math.abs(bus.speed) / (preset.topSpeedKmh / 3.6);
    if (bus.boosting && !wasBoosting) audio.cue('nitro');
    wasBoosting = bus.boosting;
    audio.update(
      {
        hornHeld: input.hornHeld,
        speedFrac,
        speed: Math.abs(bus.speed),
        load: engineLoad(drive.throttle, bus.speed, bus.boosting),
        braking: isBraking(drive.throttle, bus.speed, drive.handbrake),
        // On the grid the engine revs freely with the launch's needle.
        rev: racing && !racing.game.green ? racing.launch.rpm : undefined,
      },
      paused ? 0 : dt,
    );
    radio.update(audio.context, paused);
    // Inside a tunnel's bore (the camera's, which follows the bus): dark fog and light, the engine echoing.
    if (race?.tunnels && trackS >= 0) {
      const c = locateOnTrack(race, { x: camera.position.x, z: camera.position.z, y: camera.position.y }, trackS, 80);
      const inside = inTunnel(race, c.s) && Math.abs(c.off) < BORE_HALF && camera.position.y - c.y < BORE_TOP + 0.5;
      tunnelK += ((inside ? 1 : 0) - tunnelK) * Math.min(1, dt * 6);
      // Daylight shows ahead when a portal is near: fog turns sky-colored instead of black.
      const tu = race.tunnels.find((t) => c.s >= t.s0 && c.s <= t.s1);
      const near = tu ? Math.min(c.s - tu.s0, tu.s1 - c.s) : 1e9;
      tunnelOpen += ((inside ? Math.max(0, 1 - near / 60) : 0) - tunnelOpen) * Math.min(1, dt * 4);
    } else tunnelK = tunnelOpen = 0;
    rain.tunnel = tunnelK;
    rain.tunnelOpen = tunnelOpen;
    rain.update(w, camera, paused ? 0 : dt, covered || tunnelK > 0.5);
    audio.weather(paused ? 0 : w.rain * (covered ? 0.4 : 1), paused ? 0 : spray);
    audio.river(paused ? 0 : river);
    audio.waterfall(paused ? 0 : fallSound);
    audio.tunnel(paused ? 0 : tunnelK);
    if (racing?.slides) audio.slides(paused ? 0 : racing.slideSound.rumble, paused ? 0 : racing.slideSound.fall);
    const t = bus.position(scratchPos);
    // The street name changes slowly: look it up a few times a second, not every frame.
    streetClock += dt;
    if (streetClock >= 0.25) {
      streetClock = 0;
      street = nearestRoad(city, { x: t.x, z: t.z })?.name ?? '';
    }
    hud.update(dt, bus.speed, rig.mode, flippedFor > 1.5, street);
    // Backdrop first (sky, far hills, landmarks) through a matching long-range camera, then the city.
    farCamera.position.copy(camera.position);
    farCamera.quaternion.copy(camera.quaternion);
    if (farCamera.fov !== camera.fov || farCamera.aspect !== camera.aspect) {
      farCamera.fov = camera.fov;
      farCamera.aspect = camera.aspect;
      farCamera.updateProjectionMatrix();
    }
    const t2 = performance.now();
    renderer.info.reset();
    renderer.clear();
    renderer.render(backdrop, farCamera);
    perf.backdropCalls = renderer.info.render.calls;
    renderer.clearDepth();
    renderer.render(scene, camera);
    const t3 = performance.now();
    perf.sim = smooth(perf.sim, t1 - t0);
    perf.frame = smooth(perf.frame, t2 - t1);
    perf.render = smooth(perf.render, t3 - t2);
    perf.steps = steps;
    perf.calls = renderer.info.render.calls;
    perf.triangles = renderer.info.render.triangles;
  });
}
