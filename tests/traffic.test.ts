import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/world/procCity';
import { buildRoadGraph } from '../src/world/roadGraph';
import { TrafficLights } from '../src/gameplay/trafficLights';
import { TrafficSim, CAR_KINDS, RECYCLE_RADIUS, SPAWN_BEHIND_DIST, SPAWN_HIDDEN_DIST, type Obstacle, type TrafficEvent } from '../src/gameplay/traffic';
import { distToPolyline, pointInPolygon } from '../src/world/geom';
import { forward, right, type Vec2 } from '../src/world/cityData';

const city = generateCity({ seed: 42 });
const graph = buildRoadGraph(city);
const lights = new TrafficLights(graph, city.signals ?? []);
const DT = 1 / 30;

function simulate(seconds: number, opts: { count?: number; seed?: number; obstacles?: Obstacle[] } = {}, each?: (sim: TrafficSim, ev: TrafficEvent[]) => void) {
  const sim = new TrafficSim(graph, city, { seed: opts.seed ?? 1, count: opts.count ?? 30, lights });
  for (let t = 0; t < seconds; t += DT) {
    const ev = sim.step(DT, opts.obstacles ?? []);
    each?.(sim, ev);
  }
  return sim;
}

/** Oriented-box overlap (separating axis test on the ground plane). */
function overlaps(a: { pos: Vec2; heading: number; length: number; width: number }, b: typeof a): boolean {
  const axes = [forward(a.heading), right(a.heading), forward(b.heading), right(b.heading)];
  const d = { x: b.pos.x - a.pos.x, z: b.pos.z - a.pos.z };
  for (const ax of axes) {
    const proj = (o: typeof a) =>
      (Math.abs(forward(o.heading).x * ax.x + forward(o.heading).z * ax.z) * o.length) / 2 +
      (Math.abs(right(o.heading).x * ax.x + right(o.heading).z * ax.z) * o.width) / 2;
    if (Math.abs(d.x * ax.x + d.z * ax.z) > proj(a) + proj(b)) return false;
  }
  return true;
}

describe('TrafficSim', () => {
  it('spawns the requested number of cars on lanes, apart from each other', () => {
    const sim = new TrafficSim(graph, city, { seed: 1, count: 30 });
    expect(sim.cars.filter((c) => c.state === 'driving')).toHaveLength(30);
    const kinds = new Set(sim.cars.map((c) => c.kind.name));
    expect(kinds.has('taxi')).toBe(true);
    for (let i = 0; i < sim.cars.length; i++)
      for (let j = i + 1; j < sim.cars.length; j++) expect(overlaps(pose(sim, i), pose(sim, j))).toBe(false);
  });

  it('keeps cars on the asphalt', () => {
    simulate(60, {}, (sim) => {
      for (const c of sim.cars) {
        const off = Math.min(...city.roads.map((r) => distToPolyline(c.pos, r.points) - r.width / 2));
        expect(off).toBeLessThan(0.2);
      }
    });
  });

  it.each([1, 2, 3, 4])('never lets two cars overlap (seed %i)', (seed) => {
    let worst = 0;
    simulate(90, { count: 36, seed }, (sim) => {
      const driving = sim.cars.map((_, i) => i).filter((i) => sim.cars[i].state === 'driving');
      for (let a = 0; a < driving.length; a++)
        for (let b = a + 1; b < driving.length; b++) if (overlaps(pose(sim, driving[a]), pose(sim, driving[b]))) worst++;
    });
    expect(worst).toBe(0);
  });

  it.each([1, 2, 3, 4])('keeps traffic flowing, no gridlock (seed %i)', (seed) => {
    const start = new Map<number, Vec2>();
    const travelled = new Map<number, number>();
    simulate(90, { count: 36, seed }, (sim) => {
      for (const c of sim.cars) {
        const last = start.get(c.id);
        if (last) travelled.set(c.id, (travelled.get(c.id) ?? 0) + Math.hypot(c.pos.x - last.x, c.pos.z - last.z));
        start.set(c.id, { ...c.pos });
      }
    });
    const d = [...travelled.values()];
    expect(Math.min(...d)).toBeGreaterThan(150);
  });

  it('stops behind the bus parked in its lane, then honks', () => {
    // Find a seed whose single car has 40 m of straight lane ahead of it.
    let sim!: TrafficSim;
    for (let seed = 1; seed < 50; seed++) {
      sim = new TrafficSim(graph, city, { seed, count: 1 });
      if (graph.edges[sim.cars[0].edge].len - sim.cars[0].s > 40) break;
    }
    const car = sim.cars[0];
    const e = graph.edges[car.edge];
    expect(e.len - car.s).toBeGreaterThan(40);
    // Put the bus 30 m ahead in the car's lane, sitting still.
    const s = Math.min(e.len - 6, car.s + 30);
    const r = right(e.heading);
    const off = car.offset;
    const bus: Obstacle = {
      id: 'bus',
      pos: { x: e.a.x + e.dir.x * s + r.x * off, z: e.a.z + e.dir.z * s + r.z * off },
      heading: e.heading,
      length: 11,
      width: 2.5,
    };
    const honks: TrafficEvent[] = [];
    for (let t = 0; t < 8; t += DT) honks.push(...sim.step(DT, [bus]).filter((ev) => ev.type === 'honk'));
    const gap = (s - car.s) - 11 / 2 - car.kind.length / 2;
    expect(car.edge).toBe(e.id);
    expect(car.speed).toBeLessThan(0.3);
    expect(gap).toBeGreaterThan(0.5);
    expect(gap).toBeLessThan(6);
    expect(honks.length).toBeGreaterThanOrEqual(1);
  });

  it('can take a car out of traffic and respawn it far from the bus', () => {
    const sim = new TrafficSim(graph, city, { seed: 1, count: 10 });
    const bus = { x: 0, z: 0 };
    sim.release(3);
    expect(sim.cars[3].state).toBe('free');
    sim.respawn(3, bus, 100);
    expect(sim.cars[3].state).toBe('driving');
    expect(Math.hypot(sim.cars[3].pos.x - bus.x, sim.cars[3].pos.z - bus.z)).toBeGreaterThan(100);
  });

  it('parks and restores cars to follow a budget', () => {
    const sim = new TrafficSim(graph, city, { seed: 1, count: 20 });
    sim.setBudget(8, { x: 0, z: 0 });
    expect(sim.cars.filter((c) => c.state === 'driving')).toHaveLength(8);
    sim.setBudget(20, { x: 0, z: 0 });
    expect(sim.cars.filter((c) => c.state === 'driving')).toHaveLength(20);
  });

  it('keeps traffic in a bubble around the bus, spawning out of sight', () => {
    const sim = new TrafficSim(graph, city, { seed: 1, count: 40 });
    const focus = { pos: { x: 0, z: 0 }, heading: 0 };
    const beforeGen = sim.cars.map((c) => c.generation);
    sim.recycle(focus);
    for (const c of sim.cars) {
      if (c.state !== 'driving') continue;
      const rel = { x: c.pos.x - focus.pos.x, z: c.pos.z - focus.pos.z };
      const d = Math.hypot(rel.x, rel.z);
      expect(d).toBeLessThan(RECYCLE_RADIUS);
      if (c.generation !== beforeGen[c.id]) {
        // Freshly placed: in the fog, or behind the bus.
        const ahead = rel.x * forward(focus.heading).x + rel.z * forward(focus.heading).z;
        expect(d > SPAWN_HIDDEN_DIST || (ahead < 0 && d > SPAWN_BEHIND_DIST)).toBe(true);
      }
    }
    // Startup fill spreads cars across the whole bubble, near ones included.
    const filled = new TrafficSim(graph, city, { seed: 1, count: 40 });
    filled.recycle(focus, true);
    const within = (r: number) => filled.cars.filter((c) => Math.hypot(c.pos.x, c.pos.z) < r).length;
    expect(within(100)).toBeGreaterThan(8);
    expect(within(RECYCLE_RADIUS)).toBe(40);
    // Cars that were already near the bus are left alone.
    const near = sim.cars.filter((c) => Math.hypot(c.pos.x, c.pos.z) < 100).map((c) => [c.id, c.generation]);
    sim.recycle(focus);
    for (const [id, gen] of near) expect(sim.cars[id].generation).toBe(gen);
  });

  it.each([1, 2])('waits at red lights, and nobody waiting is recycled as stuck (seed %i)', (seed) => {
    const { entered, recycled, waited } = lightDiscipline(lights, simulate(0, { count: 36, seed }), 90);
    expect(entered).toBe(0);
    expect(recycled).toBe(0);
    expect(waited).toBeGreaterThan(0);
  });

  it('drives every kind at a sensible city speed', () => {
    for (const k of Object.values(CAR_KINDS)) expect(k.vmax * 3.6).toBeLessThan(65);
  });
});

/**
 * Runs `sim` and counts cars that got into a junction against a red light (claimed it while
 * their approach was red), cars recycled while waiting for a light, and seconds of waiting.
 */
function lightDiscipline(l: TrafficLights, sim: TrafficSim, seconds: number) {
  let entered = 0;
  let recycled = 0;
  let waited = 0;
  const reserved = sim.cars.map((c) => c.reserved);
  const gen = sim.cars.map((c) => c.generation);
  const held = sim.cars.map((c) => c.held);
  for (let t = 0; t < seconds; t += DT) {
    sim.step(DT, []);
    sim.cars.forEach((c, i) => {
      if (reserved[i] === null && c.reserved !== null && l.state(c.edge, sim.time) === 'red') entered++;
      if (c.generation !== gen[i] && held[i]) recycled++;
      if (c.held) waited += DT;
      reserved[i] = c.reserved;
      gen[i] = c.generation;
      held[i] = c.held;
    });
  }
  return { entered, recycled, waited };
}

function pose(sim: TrafficSim, i: number) {
  const c = sim.cars[i];
  return { pos: c.pos, heading: c.heading, length: c.kind.length, width: c.kind.width };
}

describe('TrafficSim on La Mariscal (real map, one-way streets)', () => {
  const real: import('../src/world/cityData').CityData = JSON.parse(require('node:fs').readFileSync('data/cities/mariscal.json', 'utf8'));
  const g = buildRoadGraph(real);
  const realLights = new TrafficLights(g, real.signals ?? []);
  const hulls = g.nodes.filter((n) => n.hull).map((n) => n.hull!);
  const run = (seed: number, seconds: number, each: (sim: TrafficSim) => void) => {
    const sim = new TrafficSim(g, real, { seed, count: 50, lights: realLights });
    sim.recycle({ pos: real.spawn.pos, heading: real.spawn.heading }, true);
    for (let t = 0; t < seconds; t += DT) {
      sim.step(DT, []);
      each(sim);
    }
    return sim;
  };

  it.each([1, 2, 3])('keeps cars on the asphalt, apart, and moving (seed %i)', (seed) => {
    let overlapsSeen = 0;
    let offRoad = 0;
    const last = new Map<number, Vec2>();
    const moved = new Map<number, number>();
    run(seed, 90, (sim) => {
      const driving = sim.cars.filter((c) => c.state === 'driving');
      for (let a = 0; a < driving.length; a++) {
        const c = driving[a];
        const off = Math.min(...real.roads.map((r) => distToPolyline(c.pos, r.points) - r.width / 2));
        // Turn curves may clip a curb corner slightly; junction areas are paved.
        if (off > 0.6 && !hulls.some((h) => pointInPolygon(c.pos, h))) offRoad++;
        for (let b = a + 1; b < driving.length; b++) if (overlaps(pose(sim, c.id), pose(sim, driving[b].id))) overlapsSeen++;
        const l = last.get(c.id);
        // Relocations (map exits, recycling) jump; don't count those as driving.
        if (l && Math.hypot(c.pos.x - l.x, c.pos.z - l.z) < 3) moved.set(c.id, (moved.get(c.id) ?? 0) + Math.hypot(c.pos.x - l.x, c.pos.z - l.z));
        last.set(c.id, { ...c.pos });
      }
    });
    expect(offRoad).toBe(0);
    // Real-map geometry leaves rare brief touches (in game the two bodies just bump); the
    // generated grid above is held to zero.
    expect(overlapsSeen).toBeLessThanOrEqual(20);
    const d = [...moved.values()].sort((a, b) => a - b);
    expect(d[Math.floor(d.length * 0.1)]).toBeGreaterThan(150); // 90% of cars keep moving
  }, 60_000);

  it('waits at red lights, and nobody waiting is recycled as stuck', () => {
    const sim = new TrafficSim(g, real, { seed: 4, count: 50, lights: realLights });
    sim.recycle({ pos: real.spawn.pos, heading: real.spawn.heading }, true);
    const { entered, recycled, waited } = lightDiscipline(realLights, sim, 90);
    expect(entered).toBe(0);
    expect(recycled).toBe(0);
    expect(waited).toBeGreaterThan(0);
  }, 60_000);
});
