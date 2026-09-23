import * as THREE from 'three';
import { initRapier, createWorld, addGround, PHYSICS_STEP } from './physics/world';
import { Input } from './core/input';
import { BusAudio } from './core/audio';
import { BusPhysics } from './vehicle/bus';
import { BusModel } from './vehicle/busModel';
import type { BusPreset } from './vehicle/busPreset';
import { CameraRig } from './camera/cameraRig';
import { setupSky, followSun } from './world/sky';
import { buildCity } from './world/cityBuilder';
import { groundHeightAt, nearestRoad } from './world/cityData';
import { buildRoadGraph } from './world/roadGraph';
import { loadCity } from './world/loadCity';
import { snapToRoad } from './world/roadSnap';
import { Hud } from './ui/hud';
import { GameSession } from './gameplay/session';
import popular from '../data/buses/popular.json';

const MAX_FRAME = 0.1;

async function main() {
  await initRapier();

  const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  // Far plane reaches the mountain ring around the largest imported city.
  const camera = new THREE.PerspectiveCamera(68, 1, 0.3, 6000);
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  const sun = setupSky(scene);
  const world = createWorld();
  const city = await loadCity(new URLSearchParams(location.search));
  if (!city.terrain) addGround(world, Math.max(city.bounds.max.x - city.bounds.min.x, city.bounds.max.z - city.bounds.min.z) + 500);
  const graph = buildRoadGraph(city);
  const { props } = buildCity(city, world, scene, graph);

  const preset = popular as BusPreset;
  const { pos, heading } = city.spawn;
  const bus = new BusPhysics(world, preset, { x: pos.x, y: groundHeightAt(city, pos), z: pos.z, heading });
  const model = new BusModel(preset);
  scene.add(model.root);

  const input = new Input();
  const audio = new BusAudio();
  const rig = new CameraRig(camera);
  const hudRoot = document.querySelector<HTMLElement>('#hud')!;
  const hud = new Hud(hudRoot, city.attribution);
  const session = new GameSession({ world, scene, city, bus, props, audio, hudRoot, graph });

  if (import.meta.env.DEV) (window as any).__qbus = { bus, rig, input, city, props, renderer, scene, session, groundAt: (p: { x: number; z: number }) => groundHeightAt(city, p) };

  let acc = 0;
  let last = performance.now();
  let flippedFor = 0;
  let fps = 60;

  renderer.setAnimationLoop((now) => {
    const raw = (now - last) / 1000;
    // rAF timestamps can precede the first performance.now(): never let dt go negative.
    const dt = Math.max(0, Math.min(MAX_FRAME, raw));
    last = now;
    if (raw > 0) fps += (1 / raw - fps) * 0.05;
    session.adaptTraffic(fps, dt);

    for (const action of input.consumeActions()) {
      if (action === 'camera') model.setCockpitView(rig.toggle() === 'cockpit');
      if (action === 'reset') {
        const t = bus.body.translation();
        const s = snapToRoad(city, { x: t.x, z: t.z }, bus.heading);
        bus.reset({ x: s.pos.x, y: groundHeightAt(city, s.pos), z: s.pos.z, heading: s.heading });
      }
      if (action === 'restart' && session.game.over) session.restart();
      if (action === 'horn') session.playerHonk();
    }

    const drive = input.drive();
    if (drive.throttle > 0) session.start();
    acc += dt;
    while (acc >= PHYSICS_STEP) {
      bus.update(drive, PHYSICS_STEP);
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
    rig.update(dt, bus);
    followSun(sun, model.root.position);
    session.frame(dt, camera, rig.mode);
    const speedFrac = Math.abs(bus.speed) / (preset.topSpeedKmh / 3.6);
    audio.update(input.hornHeld, speedFrac, drive.throttle);
    const t = bus.body.translation();
    hud.update(dt, bus.speed, rig.mode, flippedFor > 1.5, nearestRoad(city, { x: t.x, z: t.z })?.name ?? '');
    renderer.render(scene, camera);
  });
}

main();
