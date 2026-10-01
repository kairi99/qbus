import * as THREE from 'three';
import { initRapier, createWorld, addGround, PHYSICS_STEP } from './physics/world';
import { Input } from './core/input';
import { BusAudio } from './core/audio';
import { BusPhysics } from './vehicle/bus';
import { BusModel } from './vehicle/busModel';
import { CameraRig } from './camera/cameraRig';
import { SKY_HORIZON, setupSky, followSun } from './world/sky';
import { buildBackdrop } from './world/backdrop';
import { buildCity } from './world/cityBuilder';
import { groundHeightAt, nearestRoad } from './world/cityData';
import { buildRoadGraph } from './world/roadGraph';
import { loadCity } from './world/loadCity';
import { snapToRoad } from './world/roadSnap';
import { Hud } from './ui/hud';
import { TouchControls, isTouchDevice } from './ui/touchControls';
import { GameSession } from './gameplay/session';
import { busById } from './vehicle/buses';
import { routesFor } from './gameplay/routes';
import { Menu } from './menu/menu';
import { loadSettings } from './menu/settings';

const MAX_FRAME = 0.1;

async function main() {
  // Without a shift to play (?play=1 from the menu, or ?city= / ?seed= directly), show the menu.
  const params = new URLSearchParams(location.search);
  if (!params.has('play') && !params.has('city') && !params.has('seed')) {
    new Menu(document.body);
    return;
  }
  const settings = loadSettings();
  if (!params.has('hills')) params.set('hills', String(settings.hills));
  await initRapier();

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
  renderer.setClearColor(SKY_HORIZON);
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  const sun = setupSky(scene);
  const world = createWorld();
  const city = await loadCity(params);
  if (!city.terrain) addGround(world, Math.max(city.bounds.max.x - city.bounds.min.x, city.bounds.max.z - city.bounds.min.z) + 500);
  const graph = buildRoadGraph(city);
  const { props } = buildCity(city, world, scene, graph);
  const { min, max } = city.bounds;
  const backdrop = buildBackdrop(city, Math.max(...[min.x, max.x].flatMap((x) => [min.z, max.z].map((z) => Math.hypot(x, z)))));

  // Free roam (?mode=free) has no route; a route shift is always driven in a bus.
  const free = params.get('mode') === 'free';
  const picked = busById(params.get('bus') ?? settings.bus);
  const preset = free || picked.kind !== 'car' ? picked : busById('popular');
  const routes = free ? [] : routesFor(city);
  const route = free ? null : (routes.find((r) => r.id === params.get('route')) ?? routes[0]);
  const { pos, heading } = city.spawn;
  const bus = new BusPhysics(world, preset, { x: pos.x, y: groundHeightAt(city, pos), z: pos.z, heading });
  const model = new BusModel(preset);
  scene.add(model.root);

  const input = new Input();
  const audio = new BusAudio();
  const rig = new CameraRig(camera);
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;
  const hud = new Hud(hudRoot, city.attribution);
  const session = new GameSession({ world, scene, city, bus, props, audio, hudRoot, graph, route });
  if (touch) new TouchControls(document.body, input);
  audio.setVolume(settings.volume);
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

  if (import.meta.env.DEV) (window as any).__qbus = { bus, rig, input, city, props, renderer, scene, session, route, groundAt: (p: { x: number; z: number }) => groundHeightAt(city, p) };

  let acc = 0;
  let last = performance.now();
  let flippedFor = 0;
  let fps = 60;
  let wasBoosting = false;

  renderer.setAnimationLoop((now) => {
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
        // The bus's center is ~1.5 m over the road: look for a road at about that height.
        const s = snapToRoad(city, { x: t.x, z: t.z }, bus.heading, t.y - 1.5);
        bus.reset({ x: s.pos.x, y: s.y, z: s.pos.z, heading: s.heading });
      }
      if (action === 'pause') setPaused(!paused);
      if (paused) continue;
      if (action === 'restart' && session.game?.over) session.restart();
      if (action === 'horn') session.playerHonk();
    }

    const drive = paused ? { throttle: 0, steer: 0, handbrake: false } : input.drive();
    if (drive.throttle > 0 || drive.boost) session.start();
    // Paused: the world stands still (but keeps rendering behind the menu).
    acc = paused ? 0 : acc + dt;
    while (acc >= PHYSICS_STEP) {
      bus.update({ ...drive, boost: session.nitro.step(!!drive.boost, PHYSICS_STEP) }, PHYSICS_STEP);
      session.beforeStep(PHYSICS_STEP);
      world.step();
      session.physicsStep(PHYSICS_STEP);
      acc -= PHYSICS_STEP;
    }

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
    audio.update(input.hornHeld, speedFrac, drive.throttle);
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
    renderer.clear();
    renderer.render(backdrop, farCamera);
    renderer.clearDepth();
    renderer.render(scene, camera);
  });
}

main();
