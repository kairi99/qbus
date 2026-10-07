import * as THREE from 'three';
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
import { busById } from './vehicle/buses';
import { routesFor } from './gameplay/routes';
import { loadSettings, saveSettings } from './menu/settings';
import { RadioToast } from './ui/radioToast';

const MAX_FRAME = 0.1;

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
  renderer.setPixelRatio(Math.min(devicePixelRatio, touch ? 1 : 1.5));
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
  if (!city.terrain) addGround(world, Math.max(city.bounds.max.x - city.bounds.min.x, city.bounds.max.z - city.bounds.min.z) + 500);
  const graph = buildRoadGraph(city);
  performance.mark('qbus:graph');
  const { props } = buildCity(city, world, scene, graph);
  performance.mark('qbus:city-built');
  const { min, max } = city.bounds;
  const backdrop = buildBackdrop(city, Math.max(...[min.x, max.x].flatMap((x) => [min.z, max.z].map((z) => Math.hypot(x, z)))), tod);

  // Free roam (?mode=free) has no route; a route shift is always driven in a bus.
  const free = params.get('mode') === 'free';
  const picked = busById(params.get('bus') ?? settings.bus);
  const preset = free || picked.kind !== 'car' ? picked : busById('popular');
  const routes = free ? [] : routesFor(city);
  const route = free ? null : (routes.find((r) => r.id === params.get('route')) ?? routes[0]);
  const { pos, heading } = city.spawn;
  const bus = new BusPhysics(world, preset, { x: pos.x, y: groundHeightAt(city, pos), z: pos.z, heading });
  const fits = vehicleClearance(world, preset.body);
  const model = new BusModel(preset);
  model.setHeadlights(LIGHTING[tod].headlights);
  scene.add(model.root);

  const input = new Input();
  const audio = new BusAudio(preset.kind === 'car' ? 'car' : 'bus');
  // The chase camera stays out of walls and roofs (tunnels, cuts, buildings).
  const rig = new CameraRig(camera, staticObstacles(world));
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;
  const hud = new Hud(hudRoot, city.attribution);
  // Records are kept per zone and route (a generated city other than the default seed is its own zone).
  const zone = params.get('city') ?? (params.has('seed') ? `grid-${params.get('seed')}` : DEFAULT_ZONE);
  const session = new GameSession({ world, scene, city, bus, props, audio, hudRoot, graph, route, zone });
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
  session.onHudAction = (a) => {
    if (a === 'resume') setPaused(false);
    if (a === 'menu') toMenu();
    if (a === 'again') {
      setPaused(false);
      session.restart();
    }
  };

  performance.mark('qbus:session');
  // Per-frame cost breakdown (ms, smoothed) and both passes' draw stats, for tools/tests.
  const perf = { sim: 0, frame: 0, render: 0, calls: 0, triangles: 0, backdropCalls: 0, steps: 0 };
  renderer.info.autoReset = false;
  if (import.meta.env.DEV) (window as any).__qbus = { bus, audio, radio, rig, input, city, props, renderer, scene, backdrop, session, route, perf, timeOfDay: tod, groundAt: (p: { x: number; z: number }) => groundHeightAt(city, p) };

  let acc = 0;
  let last = performance.now();
  let flippedFor = 0;
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

    for (const action of input.consumeActions()) {
      if (action === 'camera') rig.toggle();
      if (action === 'reset') {
        const t = bus.body.translation();
        // A road at the level the bus is on, on a spot where it fits (clear of walls and roofs).
        const s = snapToRoad(city, { x: t.x, z: t.z }, bus.heading, bus.roadHeight(), { clear: fits, length: preset.body.length });
        bus.reset({ x: s.pos.x, y: s.y, z: s.pos.z, heading: s.heading, pitch: s.pitch });
      }
      if (action === 'pause') setPaused(!paused);
      if (action === 'radio') {
        radioToast.show(radio.next(), radio.onAir()?.song ?? null);
        // The station you leave it on is the one the next game starts with.
        saveSettings({ ...loadSettings(), radio: radio.station });
      }
      if (paused) continue;
      if (action === 'restart' && session.game?.over) session.restart();
      if (action === 'horn') session.playerHonk();
    }

    const drive = paused ? { throttle: 0, steer: 0, handbrake: false } : input.drive();
    if (drive.throttle > 0 || drive.boost) session.start();
    // Paused: the world stands still (but keeps rendering behind the menu).
    acc = paused ? 0 : acc + dt;
    let steps = 0;
    while (acc >= PHYSICS_STEP) {
      steps++;
      bus.update({ ...drive, boost: session.nitro.step(!!drive.boost, PHYSICS_STEP) }, PHYSICS_STEP);
      session.beforeStep(PHYSICS_STEP);
      world.step();
      session.physicsStep(PHYSICS_STEP);
      acc -= PHYSICS_STEP;
    }

    const t1 = performance.now();
    const q = bus.body.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    flippedFor = upY < 0.3 ? flippedFor + dt : 0;

    props.sync();
    model.sync(bus);
    const lookBack = input.lookBackHeld;
    // Looking back from the driver's seat needs the bus's outside to be there to look at.
    model.setCockpitView(rig.mode === 'cockpit' && !lookBack);
    rig.update(dt, bus, lookBack);
    followSun(sun, model.root.position);
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
      },
      paused ? 0 : dt,
    );
    radio.update(audio.context, paused);
    const t = bus.body.translation();
    hud.update(dt, bus.speed, rig.mode, flippedFor > 1.5, nearestRoad(city, { x: t.x, z: t.z })?.name ?? '');
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
