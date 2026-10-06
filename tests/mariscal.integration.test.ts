import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createWorld, initRapier, PHYSICS_STEP } from '../src/physics/world';
import { BusPhysics } from '../src/vehicle/bus';
import type { BusPreset } from '../src/vehicle/busPreset';
import { buildCity } from '../src/world/cityBuilder';
import { groundHeightAt, inPlayArea, type CityData } from '../src/world/cityData';
import { DEFAULT_HILLS } from '../src/world/loadCity';
import { terrainHeight } from '../src/world/terrain';
import { buildRoadGraph } from '../src/world/roadGraph';
import { Navigator } from '../src/gameplay/navigation';
import popular from '../data/buses/popular.json';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
city.terrain!.scale = DEFAULT_HILLS;

/** Steepest long stretch of road in the city (uphill direction). */
function steepest() {
  let best = { a: city.roads[0].points[0], b: city.roads[0].points[1], grade: 0, name: '' };
  for (const r of city.roads)
    for (let i = 0; i < r.points.length - 1; i++) {
      const [a, b] = [r.points[i], r.points[i + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      // Streets the player can reach (not past the roadworks at the edge).
      if (len < 40 || !inPlayArea(city, a, 30) || !inPlayArea(city, b, 30)) continue;
      const rise = terrainHeight(city.terrain!, b.x, b.z) - terrainHeight(city.terrain!, a.x, a.z);
      const grade = Math.abs(rise) / len;
      if (grade > best.grade) best = rise > 0 ? { a, b, grade, name: r.name } : { a: b, b: a, grade, name: r.name };
    }
  return best;
}

describe('La Mariscal physics', () => {
  beforeAll(() => initRapier());

  function setup() {
    const world = createWorld();
    buildCity(city, world, new THREE.Scene());
    return world;
  }

  it('the bus settles on the real terrain at the spawn point', () => {
    const world = setup();
    const p = city.spawn.pos;
    const bus = new BusPhysics(world, popular as BusPreset, { ...p, y: groundHeightAt(city, p), heading: city.spawn.heading });
    for (let t = 0; t < 2; t += PHYSICS_STEP) {
      bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    expect(bus.wheelsOnGround).toBe(4);
    const y = bus.body.translation().y - groundHeightAt(city, p);
    expect(y).toBeGreaterThan(1);
    expect(y).toBeLessThan(3);
  });

  it('climbs the steepest street from a standstill', () => {
    const world = setup();
    const hill = steepest();
    const heading = Math.atan2(-(hill.b.z - hill.a.z), hill.b.x - hill.a.x);
    // A little way up the street, clear of the junction at its foot.
    const start = { x: hill.a.x + (hill.b.x - hill.a.x) * 0.2, z: hill.a.z + (hill.b.z - hill.a.z) * 0.2 };
    const bus = new BusPhysics(world, popular as BusPreset, { ...start, y: groundHeightAt(city, start), heading });
    for (let t = 0; t < 1; t += PHYSICS_STEP) {
      bus.update({ throttle: 0, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    const y0 = bus.body.translation().y;
    for (let t = 0; t < 6; t += PHYSICS_STEP) {
      bus.update({ throttle: 1, steer: 0, handbrake: false }, PHYSICS_STEP);
      world.step();
    }
    console.log(`steepest: ${hill.name} ${(hill.grade * 100).toFixed(0)}%, climbed ${(bus.body.translation().y - y0).toFixed(1)} m, ${(bus.speed * 3.6).toFixed(0)} km/h`);
    // A loaded Quito bus slogs uphill, but it must never stall.
    expect(bus.speed * 3.6).toBeGreaterThan(18);
    expect(bus.body.translation().y - y0).toBeGreaterThan(3);
  });
});

describe('La Mariscal bridges and underpasses', () => {
  beforeAll(() => initRapier());

  /**
   * Drives the bus along the legal path through a lifted road (by name and sign of its lift),
   * steering toward a point a few meters ahead on the path. Returns how far above/below the
   * ground the bus got, and whether it stayed on its wheels the whole way.
   */
  /** `near`: pick the lifted edge of that name passing closest to this point. */
  function driveThrough(name: string, sign: 1 | -1, near?: { x: number; z: number }) {
    const world = createWorld();
    const graph = buildRoadGraph(city);
    buildCity(city, world, new THREE.Scene(), graph);
    const nav = new Navigator(graph);
    const candidates = graph.edges.filter((x) => x.drivable && x.road === name && x.lift && x.lift.some((l) => l * sign > 5));
    const dist = (x: (typeof candidates)[number]) => (near ? Math.min(...x.center.pts.map((p) => Math.hypot(p.x - near.x, p.z - near.z))) : 0);
    const e = candidates.sort((a, b) => dist(a) - dist(b))[0];
    expect(e, `${name} edge`).toBeDefined();
    // The deepest/highest point of the edge.
    const k = e.lift!.reduce((best, l, i) => (l * sign > e.lift![best] * sign ? i : best), 0);
    const mid = { edge: e.id, s: e.center.cum[k] };
    const from = nav.behind(mid, 90);
    // Continue 80 m past it, along the straightest way on.
    let to = { edge: e.id, s: e.len };
    let left = 80 - (e.len - mid.s);
    let cur = e;
    while (left > 0) {
      const outs = graph.nodes[cur.to].out.map((id) => graph.edges[id]).filter((o) => o.drivable);
      if (!outs.length) break;
      const next = outs.reduce((a, b) => (a.dir.x * cur.endDir.x + a.dir.z * cur.endDir.z > b.dir.x * cur.endDir.x + b.dir.z * cur.endDir.z ? a : b));
      to = { edge: next.id, s: Math.min(next.len - 1, left) };
      left -= next.len;
      cur = next;
    }
    const path = nav.route(from, to)!;
    expect(path, 'route').not.toBeNull();
    const start = nav.pose(from);
    const bus = new BusPhysics(world, popular as BusPreset, { x: start.pos.x, y: start.y ?? groundHeightAt(city, start.pos), z: start.pos.z, heading: start.heading });
    let extreme = 0;
    let offWheels = 0;
    let reached = false;
    const goal = path.points[path.points.length - 1];
    for (let t = 0; t < 40 && !reached; t += PHYSICS_STEP) {
      const p = bus.body.translation();
      const aim = nav.guidePoint(path, { x: p.x, z: p.z }, 9);
      const want = Math.atan2(-(aim.z - p.z), aim.x - p.x);
      const err = Math.atan2(Math.sin(want - bus.heading), Math.cos(want - bus.heading));
      const kmh = bus.speed * 3.6;
      bus.update({ throttle: kmh < 35 ? 1 : 0, steer: Math.max(-1, Math.min(1, -err * 2.5)), handbrake: false }, PHYSICS_STEP);
      world.step();
      const rel = p.y - 1.5 - groundHeightAt(city, { x: p.x, z: p.z });
      if (rel * sign > extreme * sign) extreme = rel;
      if (bus.wheelsOnGround < 2) offWheels += PHYSICS_STEP;
      reached = Math.hypot(goal.x - p.x, goal.z - p.z) < 8;
    }
    return { extreme, offWheels, reached };
  }

  it('drives under Patria through the 12 de Octubre underpass', () => {
    const r = driveThrough('Av. 12 de Octubre', -1);
    console.log('12 de Octubre underpass:', r);
    expect(r.reached).toBe(true);
    expect(r.extreme).toBeLessThan(-4);
    expect(r.offWheels).toBeLessThan(0.3);
  });

  it('turns off 12 de Octubre (north to south) through its tunnel onto Queseras del Medio', () => {
    // The unnamed link dives off 12 de Octubre, passes under the Patria side of the roundabout
    // (at about -26, 711) and comes back up at Queseras del Medio.
    const r = driveThrough('sin nombre', -1, { x: -26, z: 711 });
    console.log('Queseras link:', r);
    expect(r.reached).toBe(true);
    expect(r.extreme).toBeLessThan(-4);
    expect(r.offWheels).toBeLessThan(0.3);
  });

  it('takes the link from 12 de Octubre (south to north) through its tunnel up to Av. Patria', () => {
    // OSM ways 24650066, 425195365, 420861081 (the tunnel) and 24650067: it leaves 12 de Octubre
    // northbound, dives under Queseras del Medio (at about -59, 757) and comes up at Patria.
    const r = driveThrough('sin nombre', -1, { x: -60, z: 757 });
    console.log('Patria link:', r);
    expect(r.reached).toBe(true);
    expect(r.extreme).toBeLessThan(-4);
    expect(r.offWheels).toBeLessThan(0.3);
  });

  it('routes from 12 de Octubre northbound onto Av. Patria (westbound) through the restored link', () => {
    const graph = buildRoadGraph(city);
    const nav = new Navigator(graph);
    const from = nav.locate({ x: -213, z: 847 }, Math.atan2(14, 16))!;
    const to = nav.locate({ x: -47, z: 694 }, Math.atan2(-(679 - 708), -65 + 30))!;
    expect(from && to).toBeTruthy();
    const path = nav.route(from, to)!;
    expect(path).not.toBeNull();
    // Through the tunnel (not around by the surface streets): past its deepest point, and short.
    expect(path.points.some((p) => Math.hypot(p.x + 60, p.z - 757) < 4)).toBe(true);
    expect(path.length).toBeLessThan(320);
  });

  it('drives over 10 de Agosto on the Puente del Guambra', () => {
    const r = driveThrough('Av. Patria', 1);
    console.log('Puente del Guambra:', r);
    expect(r.reached).toBe(true);
    expect(r.extreme).toBeGreaterThan(4);
    expect(r.offWheels).toBeLessThan(0.3);
  });
});
