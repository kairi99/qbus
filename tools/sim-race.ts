/**
 * Drives AI buses down a race track headless (the real physics), to tune the drivers and check
 * the track: finish time, average speed, falls (off the road below it) and stuck time.
 * With `traffic` (cars per racer, the race's own number by default when given as "traffic"), the
 * track's traffic drives too (around the AI bus) and the driver picks its lane with `chooseLane`:
 * prints how many cars it hit and how long it followed.
 * Usage: npx tsx tools/sim-race.ts [zone=papallacta] [bus=popular] [skill=normal] [traffic] [slides]
 * With `slides` the track's landslides fall (SEED= picks them, default 1): the AI takes the open lane,
 * slows through the mud (which grips and drags like in a race); prints the rescues.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import { busById } from '../src/vehicle/buses';
import { buildCity } from '../src/world/cityBuilder';
import type { CityData } from '../src/world/cityData';
import { buildRoadGraph } from '../src/world/roadGraph';
import { locateOnTrack, trackPose, trackStartPose } from '../src/world/track';
import { KEEP_RIGHT, RaceDriver, SKILLS, type TrafficCar, chooseLane, vehicleLimits } from '../src/gameplay/raceDriver';
import { Nitro } from '../src/gameplay/nitro';
import { gripFor } from '../src/gameplay/weather';
import { TrafficSim } from '../src/gameplay/traffic';
import { TrafficBodies, laneSurface } from '../src/gameplay/trafficBodies';
import { TRACK_TRAFFIC } from '../src/gameplay/raceField';
import { SLIDE_BRAKE, type SlideAdvice, mudAt, mudGrip, slideAdvice, slideField } from '../src/gameplay/landslides';
import { LandslideView } from '../src/world/landslideView';
import { groundHeightAt } from '../src/world/cityData';

const [zone = 'papallacta', busId = 'popular', skillId = 'normal', ...flags] = process.argv.slice(2);
const slidesOn = flags.includes('slides');
const trafficArg = flags.find((f) => f !== 'slides');
const city: CityData = JSON.parse(readFileSync(`data/cities/${zone}.json`, 'utf8'));
const race = city.race!;
await initRapier();
const world = createWorld();
const graph = buildRoadGraph(city);
buildCity(city, world, new THREE.Scene(), graph);
const preset = busById(busId);
const start = trackStartPose(race, 12);
const field = slidesOn ? slideField(race, Number(process.env.SEED ?? 1), (p) => groundHeightAt(city, p)) : null;
const view = field ? new LandslideView(new THREE.Scene(), world, race, field, null, (p) => groundHeightAt(city, p)) : null;
const advice: SlideAdvice = { lane: NaN, s0: Infinity, limit: Infinity, landed: false, ramp: 0 };
const bus = new BusPhysics(world, preset, { x: start.pos.x, y: start.y, z: start.pos.z, heading: start.heading, pitch: start.pitch });
const carCount = trafficArg === undefined ? 0 : Number(trafficArg) || TRACK_TRAFFIC;
// As the session sets it up (gameplay/session.ts): one edge each way, kept off the grid.
const ahead = graph.edges.map((e) => Math.hypot(e.center.pts[0].x - race.points[0].x, e.center.pts[0].z - race.points[0].z) < 1);
const trackS = (edge: number, s: number) => (ahead[edge] ? s : graph.edges[edge].len - s);
const sim = carCount ? new TrafficSim(graph, city, { seed: 11, count: carCount, avoid: { pos: start.pos, radius: 25 }, keep: (e, s) => trackS(e, s) > race.start + 250, uturns: false }) : null;
const bodies = sim ? new TrafficBodies(world, sim, laneSurface(city, graph, sim, world)) : null;
sim?.recycle({ pos: start.pos, heading: start.heading }, true);
// CORNER= / BRAKE= try other limits than the preset's (to measure them: the largest that still finish clean).
const limits = vehicleLimits(preset);
if (process.env.CORNER) limits.corner = Number(process.env.CORNER);
if (process.env.BRAKE) limits.brake = Number(process.env.BRAKE);
// On a wet road (WET=) they try the wet limits.
if (process.env.CORNER) limits.wetCorner = Number(process.env.CORNER);
if (process.env.BRAKE) limits.wetBrake = Number(process.env.BRAKE);
const skill = SKILLS[skillId as keyof typeof SKILLS];
const driver = new RaceDriver(race, skill, limits, carCount ? KEEP_RIGHT : 0);
const nitro = new Nitro();
// WET=0..1: the road that wet (rain's grip on every tire, as in a race).
const wet = Number(process.env.WET ?? 0);
// PACE=: the rubber band's push (a rival far behind the player drives at 1.07).
const pace = Number(process.env.PACE ?? 1);
bus.grip = gripFor(wet);
driver.wet = wet;
let t = 0;
let off = 0;
let worstDrop = 0;
let lastLog = 0;
let hits = 0;
let following = 0;
let recycle = 0;
let rescues = 0;
let mudTime = 0;
const p = { x: 0, y: 0, z: 0 };
const cars: TrafficCar[] = [];
const home = driver.lane;
while (t < 900) {
  let limit = Infinity;
  if (field) {
    const here = locateOnTrack(race, bus.nose(p), driver.s, 60);
    const mud = mudAt(field, t, here.s - preset.body.length * 0.4, here.off, wet, race.width / 2);
    bus.mud = mud;
    bus.grip = gripFor(wet) * mudGrip(mud, wet);
    driver.wet = Math.max(wet, mud);
    mudTime += mud > 0.3 ? PHYSICS_STEP : 0;
    view!.step(t);
    const l = vehicleLimits(preset);
    slideAdvice(field.sites, t, here.s, preset.body.length, l.brake * skill.brake * SLIDE_BRAKE, advice);
    if (!sim) {
      const way = chooseLane({ s: here.s, off: here.off, v: bus.speed, len: preset.body.length }, [], [], home, skill.passClear, advice);
      driver.lane = way.lane;
      limit = way.limit;
    }
  }
  if (sim) {
    cars.length = 0;
    for (const c of sim.cars) {
      if (c.state !== 'driving') continue;
      const s = trackS(c.edge, c.s);
      const dir = trackS(c.edge, c.s + 1) > s ? 1 : -1;
      cars.push({ s, off: dir * Math.abs(c.offset), v: c.speed, dir, len: c.kind.length });
    }
    const here = locateOnTrack(race, bus.nose(p), driver.s, 60);
    const way = chooseLane({ s: here.s, off: here.off, v: bus.speed, len: preset.body.length }, [], cars, home, skill.passClear, field ? advice : null);
    driver.lane = way.lane;
    limit = way.limit;
    if (limit < Infinity) following += PHYSICS_STEP;
    if ((recycle += PHYSICS_STEP) > 0.5) {
      recycle = 0;
      const q = bus.position(p);
      sim.recycle({ pos: { x: q.x, z: q.z }, heading: bus.heading });
    }
    const obstacles = bus.sections().map((s, i) => ({ id: i ? `bus${i}` : 'bus', pos: s.pos, heading: s.heading, length: s.length, width: preset.body.width, lift: 0 }));
    sim.step(PHYSICS_STEP, [...obstacles, ...bodies!.obstacles()]);
    bodies!.steer(PHYSICS_STEP);
  }
  const input = driver.drive(bus, PHYSICS_STEP, pace, nitro.ready || nitro.active, limit);
  bus.update({ ...input, boost: nitro.step(!!input.boost, PHYSICS_STEP) }, PHYSICS_STEP);
  world.step();
  if (bodies) {
    const q = bus.position(p);
    const hit = bodies.afterStep(PHYSICS_STEP, bus.colliders, { x: q.x, z: q.z });
    hits += hit.length;
    if (process.env.DEBUG)
      for (const i of hit) {
        const c = sim!.cars[i];
        const cs = trackS(c.edge, c.s);
        const me = locateOnTrack(race, bus.nose(p), driver.s, 60);
        console.log(`hit ${c.kind.name} ${trackS(c.edge, c.s + 1) > cs ? 'same way' : 'oncoming'} ${(cs - me.s).toFixed(1)} m ahead at ${(c.speed * 3.6).toFixed(0)} km/h; us off ${me.off.toFixed(1)} lane ${driver.lane} limit ${limit.toFixed(1)} at ${(bus.speed * 3.6).toFixed(0)} km/h`);
      }
  }
  t += PHYSICS_STEP;
  if (process.env.TRACE && t > Number(process.env.TRACE) && t < Number(process.env.TRACE) + 12 && Math.floor(t * 60) % 30 === 0) console.log(`t ${t.toFixed(1)} s ${driver.s.toFixed(0)} v ${bus.speed.toFixed(1)} lane ${driver.lane} limit ${limit.toFixed(1)} advice s0 ${advice.s0.toFixed(0)} lim ${advice.limit.toFixed(1)} off ${locateOnTrack(race, bus.position(p), driver.s, 60).off.toFixed(2)} mud ${bus.mud}`);
  // As the race does: wedged for good, back on the road where it was.
  if (driver.needsRescue) {
    console.log(`rescue at ${driver.s.toFixed(0)} m, ${t.toFixed(1)} s`);
    const pose = trackPose(race, driver.s, driver.lane);
    bus.reset({ x: pose.pos.x, y: pose.y, z: pose.pos.z, heading: pose.heading, pitch: pose.pitch });
    driver.rescued();
    rescues++;
  }
  bus.position(p);
  const here = locateOnTrack(race, p, driver.s, 60);
  const drop = here.y - bus.roadHeight();
  worstDrop = Math.max(worstDrop, drop);
  if (Math.abs(here.off) > race.width / 2 + 1) off += PHYSICS_STEP;
  if (t - lastLog > 20) {
    lastLog = t;
    console.log(`${t.toFixed(0)} s: ${here.s.toFixed(0)} m, ${(bus.speed * 3.6).toFixed(0)} km/h, off ${here.off.toFixed(1)} m, below road ${drop.toFixed(1)} m${sim ? `, ${cars.length} cars, ${hits} hit` : ''}`);
  }
  if (here.s >= race.finish) break;
  if (drop > 6) {
    console.log(`FELL at ${here.s.toFixed(0)} m (off ${here.off.toFixed(1)} m) after ${t.toFixed(0)} s`);
    break;
  }
}
const raced = race.finish - race.start;
console.log(
  `${busId}/${skillId}${field ? ' with slides' : ''}${sim ? ` with ${carCount} cars` : ''}: ${driver.s >= race.finish ? 'finished' : 'did not finish'} in ${t.toFixed(1)} s (${((raced / t) * 3.6).toFixed(0)} km/h avg), off the asphalt ${off.toFixed(1)} s, ${rescues} rescues${field ? `, ${mudTime.toFixed(1)} s in deep mud` : ''}, worst ${worstDrop.toFixed(1)} m below the road` +
    (sim ? `, hit ${hits} cars, followed one for ${following.toFixed(0)} s` : ''),
);
