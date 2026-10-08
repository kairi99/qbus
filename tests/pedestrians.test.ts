import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { generateCity } from '../src/world/procCity';
import { buildRoadGraph } from '../src/world/roadGraph';
import { PedestrianSim, PED_RECYCLE_RADIUS, type BusState } from '../src/gameplay/pedestrians';
import { TrafficLights } from '../src/gameplay/trafficLights';
import { distToSegment, pointInPolygon } from '../src/world/geom';
import { RoadIndex } from '../src/world/roadIndex';
import { forward, type CityData, type Vec2 } from '../src/world/cityData';

const DT = 1 / 30;
const farBus: BusState = { pos: { x: 1e4, z: 1e4 }, heading: 0, speed: 0 };
const indexes = new Map<CityData, RoadIndex>();
const onAsphalt = (c: CityData, p: Vec2) => {
  if (!indexes.has(c)) indexes.set(c, new RoadIndex(c.roads));
  return indexes.get(c)!.onAsphalt(p, -0.05);
};

const grid = generateCity({ seed: 42 });
const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));

describe.each([
  ['grid', grid],
  ['La Mariscal', mariscal],
])('PedestrianSim (%s)', (_, city) => {
  const graph = buildRoadGraph(city);
  const junctions = graph.nodes.filter((n) => n.junction);
  const lights = new TrafficLights(graph, city.signals ?? []);
  const sim = (seed: number, count: number) => new PedestrianSim(city, graph, { seed, count, lights });

  it('cross at traffic lights only while the cars crossing their way have a red', { timeout: 60_000 }, () => {
    const s = sim(6, 150);
    let waits = 0;
    let crossings = 0;
    const was = s.peds.map((p) => p.mode);
    for (let t = 0; t < 60; t += DT) {
      s.step(DT, farBus);
      for (const p of s.peds) {
        if (p.mode === 'wait' && was[p.id] !== 'wait') waits++;
        if (p.mode === 'cross' && was[p.id] === 'wait') {
          crossings++;
          expect(lights.state(p.gate, s.time)).toBe('red');
        }
        was[p.id] = p.mode;
      }
    }
    expect(waits).toBeGreaterThan(0);
    expect(crossings).toBeGreaterThan(0);
  });

  it('spawns walkers on sidewalks', () => {
    for (const p of sim(1, 60).peds) expect(onAsphalt(city, p.pos)).toBe(false);
  });

  it('never walks into buildings', { timeout: 60_000 }, () => {
    const s = sim(2, 80);
    for (let t = 0; t < 40; t += DT) {
      s.step(DT, farBus);
      for (const p of s.peds) expect(city.buildings.some((b) => pointInPolygon(p.pos, b.footprint)), `ped ${p.id} ${p.mode}`).toBe(false);
    }
  });

  it('only steps onto the road when crossing at a junction, and makes it across', { timeout: 60_000 }, () => {
    const s = sim(3, 120);
    let crossed = 0;
    const onRoad = new Set<number>();
    for (let t = 0; t < 60; t += DT) {
      s.step(DT, farBus);
      for (const p of s.peds) {
        if (onAsphalt(city, p.pos)) {
          onRoad.add(p.id);
          expect(p.onRoad, `ped ${p.id} ${p.mode}`).toBe(true);
          const nearJunction = junctions.some((n) => Math.hypot(n.pos.x - p.pos.x, n.pos.z - p.pos.z) < 30);
          expect(nearJunction, `ped ${p.id} at ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}`).toBe(true);
        } else if (onRoad.delete(p.id)) crossed++;
      }
    }
    expect(crossed).toBeGreaterThan(5);
  });

  it('keeps walking (nobody gets stuck)', () => {
    const s = sim(4, 60);
    const start = s.peds.map((p) => ({ ...p.pos }));
    const moved = s.peds.map(() => 0);
    let last = start.map((p) => ({ ...p }));
    for (let t = 0; t < 30; t += DT) {
      s.step(DT, farBus);
      s.peds.forEach((p, i) => {
        moved[i] += Math.hypot(p.pos.x - last[i].x, p.pos.z - last[i].z);
      });
      last = s.peds.map((p) => ({ ...p.pos }));
    }
    for (const m of moved) expect(m).toBeGreaterThan(20);
  });

  it('keeps the crowd around the bus', () => {
    const s = sim(6, 100);
    const focus = { pos: city.spawn.pos, heading: city.spawn.heading };
    s.recycle(focus, true);
    for (const p of s.peds) {
      expect(Math.hypot(p.pos.x - focus.pos.x, p.pos.z - focus.pos.z)).toBeLessThan(PED_RECYCLE_RADIUS);
      expect(onAsphalt(city, p.pos)).toBe(false);
    }
  });
});

describe('PedestrianSim dives', () => {
  const graph = buildRoadGraph(grid);

  it('dives out of the way of a bus bearing down on them, and reports it', () => {
    const sim = new PedestrianSim(grid, graph, { seed: 4, count: 1 });
    const ped = sim.peds[0];
    const heading = 0.7;
    const f = forward(heading);
    const bus: BusState = { pos: { x: ped.pos.x - f.x * 25, z: ped.pos.z - f.z * 25 }, heading, speed: 40 / 3.6 };
    let dives = 0;
    let clearest = 0;
    for (let t = 0; t < 2.5; t += DT) {
      dives += sim.step(DT, bus).dives;
      bus.pos = { x: bus.pos.x + f.x * bus.speed * DT, z: bus.pos.z + f.z * bus.speed * DT };
      // How far off the bus's line the pedestrian got while it went by.
      clearest = Math.max(clearest, Math.abs((ped.pos.x - bus.pos.x) * f.z - (ped.pos.z - bus.pos.z) * f.x));
    }
    expect(dives).toBe(1);
    expect(clearest).toBeGreaterThan(2);
  });

  it('waits until the last moment: no dive while the bus is still far off', () => {
    const sim = new PedestrianSim(grid, graph, { seed: 4, count: 1 });
    const ped = sim.peds[0];
    const heading = 0.7;
    const f = forward(heading);
    const speed = 40 / 3.6;
    const place = (d: number): BusState => ({ pos: { x: ped.pos.x - f.x * d, z: ped.pos.z - f.z * d }, heading, speed });
    // Nose (5.5 m ahead of center) would arrive in ~0.65 s: still too early to react.
    expect(sim.step(DT, place(5.5 + speed * 0.65)).dives).toBe(0);
    // ~0.4 s away: jump now.
    expect(sim.step(DT, place(5.5 + speed * 0.4)).dives).toBe(1);
  });

  it('ignores a slow or stopped bus', () => {
    const sim = new PedestrianSim(grid, graph, { seed: 4, count: 1 });
    const ped = sim.peds[0];
    const bus: BusState = { pos: { x: ped.pos.x - 6, z: ped.pos.z }, heading: 0, speed: 1 };
    let dives = 0;
    for (let t = 0; t < 1; t += DT) dives += sim.step(DT, bus).dives;
    expect(dives).toBe(0);
  });

  it('hurries across when the bus honks', () => {
    const sim = new PedestrianSim(grid, graph, { seed: 3, count: 120 });
    for (let t = 0; t < 30; t += DT) sim.step(DT, farBus);
    const crossing = sim.peds.find((p) => p.mode === 'cross')!;
    expect(crossing).toBeDefined();
    const before = crossing.speed;
    sim.honk(crossing.pos);
    sim.step(DT, farBus);
    expect(crossing.speed).toBeGreaterThan(before * 1.8);
  });
});

describe('PedestrianSim near underpasses (La Mariscal)', () => {
  it('keeps people off the edges of open cuts (shoulder and retaining wall)', { timeout: 60_000 }, () => {
    const graph = buildRoadGraph(mariscal);
    const s = new PedestrianSim(mariscal, graph, { seed: 5, count: 300 });
    // Stretches of road down in a cut, and roads at street level (one may run over a tunnel).
    const cut: { a: Vec2; b: Vec2; reach: number }[] = [];
    for (const r of mariscal.roads)
      if (r.lift)
        for (let i = 0; i < r.points.length - 1; i++)
          if ((r.lift[i] + r.lift[i + 1]) / 2 < -0.3) cut.push({ a: r.points[i], b: r.points[i + 1], reach: r.width / 2 + 1.1 });
    const level = new RoadIndex(mariscal.roads.filter((r) => !r.lift || r.lift.every((l) => Math.abs(l) <= 0.3)));
    const nearCut = (p: Vec2) => cut.some((c) => distToSegment(p, c.a, c.b) < c.reach);
    const bad: string[] = [];
    for (let t = 0; t < 20; t += DT) {
      s.step(DT, farBus);
      for (const p of s.peds) if (nearCut(p.pos) && !level.onAsphalt(p.pos)) bad.push(`ped ${p.id} ${p.mode} at (${p.pos.x.toFixed(1)}, ${p.pos.z.toFixed(1)})`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
