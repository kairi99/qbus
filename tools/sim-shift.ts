/**
 * Plays route shifts headless with an autopilot: the real physics bus on the real city, under
 * the real RouteGame, TrickScorer, Nitro and Missions rules (no traffic, so no close calls).
 * The traffic lights run on the shift's clock and the autopilot ignores them: every red it
 * happens to cross pays like a player's (`reds` counts them).
 * Three driver profiles (casual, decent, expert) give a feel for what shifts earn, to check
 * the star targets against. Usage: npx tsx tools/sim-shift.ts [profiles|casual,decent,expert] [route ids|all] [seeds] [zone]
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { BusPreset } from '../src/vehicle/busPreset';
import { buildCity } from '../src/world/cityBuilder';
import { type CityData, groundHeightAt, terrainAt, type Vec2 } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { generateCity } from '../src/world/procCity';
import { Navigator, type NavPath } from '../src/gameplay/navigation';
import { type RouteDef, routeLegs, routeStops, routesFor, startPose } from '../src/gameplay/routes';
import { RouteGame, STOP_SPEED } from '../src/gameplay/routeGame';
import { TrickScorer } from '../src/gameplay/scoring';
import { Nitro } from '../src/gameplay/nitro';
import { Missions, pickMissions, type MissionEvent } from '../src/gameplay/missions';
import { starThresholds } from '../src/gameplay/stars';
import { RedLightRunner, TrafficLights } from '../src/gameplay/trafficLights';

const popular = JSON.parse(readFileSync('data/buses/popular.json', 'utf8')) as BusPreset;
const zone = process.argv[5] ?? 'mariscal';
const city: CityData = zone === 'grid' ? generateCity({ seed: 42 }) : JSON.parse(readFileSync(`data/cities/${zone}.json`, 'utf8'));
if (city.terrain) city.terrain.scale = 1;
const graph = buildRoadGraph(city);
const nav = new Navigator(graph);
const lights = new TrafficLights(graph, city.signals ?? []);

interface Profile {
  /** Top cruising speed, m/s. */
  cruise: number;
  /** Speed through a right-angle corner, m/s. */
  corner: number;
  /** Planned braking, m/s². */
  brake: number;
  nitro: boolean;
  /** Handbrake flicks into sharp corners. */
  drift: boolean;
}
const PROFILES: Record<string, Profile> = {
  casual: { cruise: 40 / 3.6, corner: 5, brake: 3, nitro: false, drift: false },
  decent: { cruise: 60 / 3.6, corner: 7, brake: 4.5, nitro: true, drift: false },
  expert: { cruise: 95 / 3.6, corner: 9, brake: 6, nitro: true, drift: true },
};

const angle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function run(route: RouteDef, prof: Profile, seed: number) {
  const world = createWorld();
  buildCity(city, world, new THREE.Scene(), graph);
  const stops = routeStops(city, route);
  const start = startPose(city, graph, route);
  const bus = new BusPhysics(world, popular, { x: start.pos.x, y: start.y, z: start.pos.z, heading: start.heading });
  const game = new RouteGame(stops, { seed, capacity: popular.capacity, start: start.pos });
  const scorer = new TrickScorer();
  const nitro = new Nitro();
  const missions = new Missions(pickMissions(seed * 31 + 7));
  const runner = new RedLightRunner(lights);
  const legs = routeLegs(city, route, graph);
  const r = { reds: 0, trick: 0, mission: 0, fare: 0, fast: 0, ok: 0, slow: 0, secs: 0, stops: 0, meters: 0, lastArrive: 0 };
  const feed = (e: MissionEvent) => {
    for (const m of missions.feed(e)) {
      game.addCents(m.def.reward);
      r.mission += m.def.reward;
    }
  };
  for (let t = 0; t < 1; t += PHYSICS_STEP) {
    bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
    world.step();
  }
  game.start();
  let path: NavPath | null = null;
  let replan = 99;
  let stuck = 0;
  let reverse = 0;
  let wasBoost = false;
  let hb = 0;
  let active = -1;
  while (!game.over && r.secs < 900) {
    r.secs += PHYSICS_STEP;
    const p = bus.body.translation();
    const here = { x: p.x, z: p.z };
    const zone = game.activeStop.zone;
    replan += PHYSICS_STEP;
    if (active !== game.activeIndex || replan > 0.5) {
      active = game.activeIndex;
      replan = 0;
      const from = nav.locate(here, bus.heading, p.y - 1.5, (q: Vec2) => groundHeightAt(city, q));
      const to = nav.locate(zone, game.activeStop.stop.heading);
      path = from && to ? nav.route(from, to) : null;
    }
    const speed = bus.speed;
    const dStop = Math.hypot(zone.x - p.x, zone.z - p.z);
    // Speed limit from the turns ahead and the stop at the end.
    let target = prof.cruise;
    let sharp = 0;
    let sharpAt = 99;
    let toStop = dStop;
    if (path) {
      const pts = [...path.points, zone];
      let bi = 0;
      let bd = Infinity;
      pts.forEach((q, i) => {
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < bd) (bd = d), (bi = i);
      });
      let along = 0;
      for (let i = bi; i < pts.length - 2 && along < 120; i++) {
        const [a, b, c] = [pts[i], pts[i + 1], pts[i + 2]];
        along += Math.hypot(b.x - a.x, b.z - a.z);
        const turn = Math.abs(angle(Math.atan2(c.z - b.z, c.x - b.x) - Math.atan2(b.z - a.z, b.x - a.x)));
        if (turn > 0.25) {
          const vc = Math.max(prof.corner, prof.cruise * (1 - turn / 1.6));
          target = Math.min(target, Math.sqrt(vc * vc + 2 * prof.brake * Math.max(0, along - 4)));
          if (turn > sharp && along < 30) (sharp = turn), (sharpAt = along);
        }
      }
      let left = 0;
      for (let i = bi; i < pts.length - 1; i++) left += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
      toStop = dStop < 30 ? dStop : left;
    }
    // Rolls through the stop just under the speed passengers can get on at.
    const vStop = STOP_SPEED * 0.8;
    target = Math.min(target, Math.sqrt(vStop * vStop + 2 * prof.brake * Math.max(0, toStop - 3)));
    // Pure pursuit along the legal path.
    const look = Math.max(7, Math.abs(speed) * 0.7);
    const aim = dStop < look || !path ? zone : nav.guidePoint(path, here, look);
    const err = angle(Math.atan2(-(aim.z - p.z), aim.x - p.x) - bus.heading);
    let throttle = speed < target - 0.5 ? 1 : speed > target + 0.5 ? -1 : 0.2;
    let steer = Math.max(-1, Math.min(1, -err * 2.5));
    // Stuck against something: back up a bit.
    stuck = Math.abs(speed) < 0.5 && dStop > 8 ? stuck + PHYSICS_STEP : 0;
    if (stuck > 2.5) (reverse = 1.5), (stuck = 0);
    if (reverse > 0) {
      reverse -= PHYSICS_STEP;
      throttle = -1;
      steer = -steer;
    }
    let handbrake = false;
    if (prof.drift && sharp > 1.0 && sharpAt < 14 && speed > 9 && hb <= 0) hb = 0.5;
    if (hb > 0) {
      hb -= PHYSICS_STEP;
      handbrake = hb > 0.1;
    }
    const boost = prof.nitro && reverse <= 0 && Math.abs(err) < 0.1 && target > speed + 3 && nitro.ready;
    bus.update({ throttle, steer, handbrake, boost: nitro.step(boost, PHYSICS_STEP) }, PHYSICS_STEP);
    world.step();
    if (nitro.active && !wasBoost) feed({ type: 'nitro' });
    wasBoost = nitro.active;
    const b = bus.body.translation();
    const half = popular.body.length / 2;
    const front = { x: b.x + Math.cos(bus.heading) * half, z: b.z - Math.sin(bus.heading) * half };
    // The lights' clock: the shift's (traffic starts with the session, a second before the bus moves).
    const reds = runner.update(front, bus.heading, bus.roadHeight() - terrainAt(city, front), r.secs + 1).length;
    r.reds += reds;
    const tricks = scorer.update({ dt: PHYSICS_STEP, speed: bus.speed, slipAngle: bus.slipAngle, airborne: bus.wheelsOnGround === 0, nearMisses: 0, propsKnocked: 0, redLights: reds });
    if (reds) nitro.redLight();
    if (scorer.sliding) nitro.drifting(PHYSICS_STEP);
    for (const t of tricks) {
      if (t.kind === 'crash') {
        feed({ type: 'crash' });
        continue;
      }
      game.addCents(t.cents);
      r.trick += t.cents;
      feed({ type: 'trick', kind: t.kind, cents: t.cents, duration: t.duration, chain: scorer.chain });
    }
    const q = bus.body.translation();
    for (const e of game.update(PHYSICS_STEP, { pos: { x: q.x, z: q.z }, speed: bus.speed })) {
      if (e.type === 'fare') {
        r.fare += e.cents;
        feed({ type: 'fare', rating: e.rating });
      }
      if (e.type === 'arrive') {
        feed({ type: 'arrive', rating: e.rating });
        r[e.rating]++;
        // Door-to-door pace: legal meters served over the time it took.
        r.meters += r.stops === 0 ? Math.hypot(stops[0].zone.x - start.pos.x, stops[0].zone.z - start.pos.z) : legs[e.stopIndex];
        r.stops++;
        r.lastArrive = r.secs;
      }
    }
  }
  world.free();
  return { ...r, cents: game.cents, delivered: game.delivered, pace: r.lastArrive ? r.meters / r.lastArrive : 0 };
}

async function main() {
  await initRapier();
  const which = (process.argv[2] ?? 'casual,decent,expert').split(',');
  const ids = process.argv[3] && process.argv[3] !== 'all' ? process.argv[3].split(',') : null;
  const seeds = Array.from({ length: Number(process.argv[4] ?? 3) }, (_, i) => i + 1);
  const $ = (c: number) => `$${(c / 100).toFixed(2)}`;
  for (const route of routesFor(city, graph).filter((r) => !ids || ids.includes(r.id))) {
    const th = starThresholds(routeStops(city, route), routeLegs(city, route, graph), startPose(city, graph, route).pos);
    console.log(`\n== ${route.id} (${route.name}) ${route.stops.length} stops ${(route.lengthM / 1000).toFixed(1)} km; stars at ${th.map($).join(' / ')}`);
    for (const w of which) {
      const res = seeds.map((s) => run(route, PROFILES[w], s));
      const avg = (k: keyof (typeof res)[number]) => res.reduce((s, x) => s + x[k], 0) / res.length;
      console.log(
        `${w.padEnd(7)} ${$(avg('cents'))} (fares ${$(avg('fare'))}, tricks ${$(avg('trick'))} with ${avg('reds').toFixed(1)} reds, missions ${$(avg('mission'))}) ` +
          `${avg('delivered').toFixed(1)} pax, ${avg('secs').toFixed(0)} s, ${avg('stops').toFixed(1)} stops (fast ${avg('fast').toFixed(1)}, ok ${avg('ok').toFixed(1)}, slow ${avg('slow').toFixed(1)}), pace ${avg('pace').toFixed(1)} m/s; ` +
          `each ${res.map((x) => $(x.cents)).join(' ')}`,
      );
    }
  }
}

main();
