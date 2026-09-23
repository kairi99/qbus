import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/world/procCity';
import { PedestrianSim, PED_RECYCLE_RADIUS, type BusState } from '../src/gameplay/pedestrians';
import { distToPolyline, pointInPolygon } from '../src/world/geom';
import { forward, type CityData, type Vec2 } from '../src/world/cityData';

const city = generateCity({ seed: 42 });
const DT = 1 / 30;
const farBus: BusState = { pos: { x: 1e4, z: 1e4 }, heading: 0, speed: 0 };

const onAsphalt = (c: CityData, p: Vec2) => c.roads.some((r) => distToPolyline(p, r.points) < r.width / 2 - 0.05);

describe('PedestrianSim', () => {
  it('spawns walkers on sidewalks and parks', () => {
    const sim = new PedestrianSim(city, { seed: 1, count: 60 });
    expect(sim.peds).toHaveLength(60);
    for (const p of sim.peds) expect(onAsphalt(city, p.pos)).toBe(false);
  });

  it('never walks into buildings', () => {
    const sim = new PedestrianSim(city, { seed: 2, count: 60 });
    for (let t = 0; t < 60; t += DT) {
      sim.step(DT, farBus);
      for (const p of sim.peds) expect(city.buildings.some((b) => pointInPolygon(p.pos, b.footprint))).toBe(false);
    }
  });

  it('crosses streets only on crosswalks, and makes it to the other side', () => {
    const sim = new PedestrianSim(city, { seed: 3, count: 80 });
    let crossed = 0;
    const wasOnRoad = new Set<number>();
    for (let t = 0; t < 90; t += DT) {
      sim.step(DT, farBus);
      for (const p of sim.peds) {
        const road = onAsphalt(city, p.pos);
        if (road) {
          wasOnRoad.add(p.id);
          expect(p.onRoad).toBe(true);
          // On a crosswalk: within a few meters of an intersection box edge.
          const nearCrossing = city.roads.some((r) =>
            city.roads.some((o) => {
              if (o === r) return false;
              const d = distToPolyline(p.pos, o.points) - o.width / 2;
              return distToPolyline(p.pos, r.points) < r.width / 2 && d > 0 && d < 4.5;
            }),
          );
          expect(nearCrossing, `ped ${p.id} at ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}`).toBe(true);
        } else if (wasOnRoad.delete(p.id)) crossed++;
      }
    }
    expect(crossed).toBeGreaterThan(5);
  });

  it('dives out of the way of a bus bearing down on them, and reports it', () => {
    const sim = new PedestrianSim(city, { seed: 4, count: 1 });
    const ped = sim.peds[0];
    // Bus 25 m away, driving straight at the pedestrian at 40 km/h.
    const heading = 0.7;
    const f = forward(heading);
    const bus: BusState = { pos: { x: ped.pos.x - f.x * 25, z: ped.pos.z - f.z * 25 }, heading, speed: 40 / 3.6 };
    let dives = 0;
    for (let t = 0; t < 1.5; t += DT) {
      dives += sim.step(DT, bus).dives;
      bus.pos = { x: bus.pos.x + f.x * bus.speed * DT, z: bus.pos.z + f.z * bus.speed * DT };
    }
    expect(dives).toBe(1);
    const lateral = Math.abs((ped.pos.x - bus.pos.x) * f.z - (ped.pos.z - bus.pos.z) * f.x);
    expect(lateral).toBeGreaterThan(2);
  });

  it('waits until the last moment: no dive while the bus is still far off', () => {
    const sim = new PedestrianSim(city, { seed: 4, count: 1 });
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

  it('keeps the crowd around the bus, respawning distant walkers nearby', () => {
    const sim = new PedestrianSim(city, { seed: 6, count: 100 });
    const focus = { pos: { x: 150, z: -120 }, heading: 1 };
    sim.recycle(focus);
    for (const p of sim.peds) expect(Math.hypot(p.pos.x - focus.pos.x, p.pos.z - focus.pos.z)).toBeLessThan(PED_RECYCLE_RADIUS);
    for (const p of sim.peds) expect(onAsphalt(city, p.pos)).toBe(false);
  });

  it('ignores a slow or stopped bus', () => {
    const sim = new PedestrianSim(city, { seed: 4, count: 1 });
    const ped = sim.peds[0];
    const bus: BusState = { pos: { x: ped.pos.x - 6, z: ped.pos.z }, heading: 0, speed: 1 };
    let dives = 0;
    for (let t = 0; t < 1; t += DT) dives += sim.step(DT, bus).dives;
    expect(dives).toBe(0);
  });

  it('hurries across when the bus honks', () => {
    const sim = new PedestrianSim(city, { seed: 3, count: 80 });
    for (let t = 0; t < 30; t += DT) sim.step(DT, farBus);
    const crossing = sim.peds.find((p) => p.mode === 'cross')!;
    expect(crossing).toBeDefined();
    const before = crossing.speed;
    sim.honk(crossing.pos);
    sim.step(DT, farBus);
    expect(crossing.speed).toBeGreaterThan(before * 1.8);
  });
});
