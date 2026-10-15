import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CityData, Road } from '../src/world/cityData';
import { inPlayArea, stopZone } from '../src/world/cityData';
import { distToPolyline } from '../src/world/geom';
import { buildRoadGraph, edgeAllows, makePath, pointAt } from '../src/world/roadGraph';
import { Navigator } from '../src/gameplay/navigation';
import { TrafficSim } from '../src/gameplay/traffic';
import { TrafficLights } from '../src/gameplay/trafficLights';
import { sidewalkSections } from '../src/world/sidewalks';
import { isBusway, buswayWidth, clearBusways, BUSWAY_NAME } from '../src/world/osm/busways';
import { snapToRoad } from '../src/world/roadSnap';

const mariscal: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const graph = buildRoadGraph(mariscal);
const inPlay = (p: { x: number; z: number }) => inPlayArea(mariscal, p);

/** A little town: a two-way street with a busway bypass over it, and a dead-end busway stub. */
function tiny(): CityData {
  const road = (name: string, pts: [number, number][], extra: Partial<Road> = {}): Road => ({
    name,
    kind: 'street',
    points: pts.map(([x, z]) => ({ x, z })),
    width: 7.6,
    lanes: 2,
    ...extra,
  });
  const bus = (name: string, pts: [number, number][], oneway = true): Road => road(name, pts, { access: 'brt', width: 3.4, lanes: 1, oneway });
  return {
    roads: [
      road('West', [[0, 0], [100, 0]]),
      road('East', [[100, 0], [200, 0]]),
      bus('Bypass', [[0, 0], [100, -60], [200, 0]]),
      bus('Stub', [[100, 0], [100, 80]]),
    ],
  } as unknown as CityData;
}

describe('busway import (La Mariscal)', () => {
  const buses = mariscal.roads.filter((r) => r.access === 'brt');

  it('imports the segregated busways as roads of their own class', () => {
    expect(buses.length).toBeGreaterThanOrEqual(30);
    for (const r of buses) {
      expect(r.name).toBe(BUSWAY_NAME);
      expect(r.width).toBeLessThanOrEqual(buswayWidth(2, false) + 0.01);
      expect(r.points.length).toBeGreaterThanOrEqual(2);
    }
    // Both mapped corridors are there: the Ecovía on 6 de Diciembre and the Trolebús on 10 de Agosto.
    const near = (x: number, z: number) => buses.some((r) => distToPolyline({ x, z }, r.points) < 8);
    expect(near(-9, 349)).toBe(true);
    expect(near(-575, 48)).toBe(true);
  });

  it('keeps painted bus lanes (Av. América, 12 de Octubre, Universitaria) as ordinary road lanes', () => {
    expect(isBusway({ highway: 'primary', name: 'Avenida América', 'bus:lanes': 'designated||' })).toBe(false);
    expect(isBusway({ highway: 'secondary', 'psv:lanes': '||designated' })).toBe(false);
    expect(isBusway({ highway: 'service', access: 'no', bus: 'designated', oneway: 'yes' })).toBe(true);
    expect(isBusway({ highway: 'service', access: 'no', psv: 'yes' })).toBe(true);
    expect(isBusway({ highway: 'service', bus: 'designated' })).toBe(false);
    for (const name of ['Av. América', 'Av. 12 de Octubre', 'Av. Universitaria']) expect(mariscal.roads.some((r) => r.name === name && !r.access)).toBe(true);
  });

  it('keeps busways off the asphalt of ordinary roads (a curb away) except where they join', () => {
    let overlap = 0;
    let total = 0;
    for (const r of buses) {
      const path = makePath(r.points);
      for (let d = 20; d < path.len - 20; d += 5) {
        const p = pointAt(path, d);
        if (!inPlay(p)) continue;
        total++;
        if (mariscal.roads.some((o) => !o.access && distToPolyline(p, o.points) < o.width / 2 + r.width / 2 - 1.2)) overlap++;
      }
    }
    expect(total).toBeGreaterThan(100);
    // OSM draws the busways right against the avenues and the avenues are drawn with generic lane
    // widths (3.3 m + 1 m): where the median is too narrow even after the push the busway still
    // overlaps the carriageway by a meter or two. Known limitation (a third of the samples today);
    // this keeps it from getting worse.
    expect(overlap / total).toBeLessThan(0.4);
  });
});

describe('clearBusways', () => {
  // A divided avenue whose median holds a pair of one-way busways, drawn a lane apart as OSM does
  // on 6 de Diciembre, with the carriageways' generic widths reaching over them.
  const road = (z: number, extra: Partial<Road>, reverse = false): Road => {
    const pts = [0, 50, 100, 150, 200].map((x) => ({ x, z }));
    return { name: 'Avenida', kind: 'street', points: reverse ? pts.reverse() : pts, width: 7.6, lanes: 2, oneway: true, ...extra };
  };
  const bus = { name: BUSWAY_NAME, access: 'brt' as const, width: 3.4, lanes: 1 };
  const roads = [road(-6, {}), road(-1.75, bus), road(1.75, bus, true), road(6, {}, true)];

  it('pushes busways off the carriageways but never into each other', () => {
    const [, a, b] = clearBusways(roads);
    for (const p of a.points.slice(1, -1)) {
      const gap = distToPolyline(p, b.points);
      expect(gap).toBeGreaterThanOrEqual(3.4);
    }
  });

  it('pulls a pair fanning out of a shared node a lane apart past the taper', () => {
    // A two-way busway splits into a one-way pair that OSM draws barely 1.5 m apart for 30 m.
    const trunk: Road = { name: BUSWAY_NAME, kind: 'street', points: [{ x: -100, z: 0 }, { x: 0, z: 0 }], width: 6.8, lanes: 2, access: 'brt' };
    const out: Road = { ...bus, kind: 'street', oneway: true, points: [{ x: 0, z: 0 }, { x: 30, z: 1.1 }, { x: 200, z: 1.75 }] };
    const back: Road = { ...bus, kind: 'street', oneway: true, points: [{ x: 200, z: -1.75 }, { x: 30, z: -1.1 }, { x: 0, z: 0 }] };
    const [t, a, b] = clearBusways([trunk, out, back]);
    for (const p of t.points) expect(p.z).toBe(0);
    expect(a.points[0]).toEqual({ x: 0, z: 0 });
    expect(b.points.at(-1)).toEqual({ x: 0, z: 0 });
    for (const p of a.points.filter((q) => q.x >= 16 && q.x < 190)) expect(distToPolyline(p, b.points)).toBeGreaterThanOrEqual(3.3);
  });
});

describe('road graph per access class', () => {
  it('marks busway edges and nodes, and they are never in the general drivable set', () => {
    const bus = graph.edges.filter((e) => e.access === 'brt');
    expect(bus.length).toBeGreaterThan(40);
    for (const e of bus) expect(e.drivable).toBe(false);
    expect(graph.nodes.some((n) => n.access === 'brt')).toBe(true);
    expect(graph.nodes.filter((n) => n.access === 'brt').every((n) => [...n.in, ...n.out].every((id) => graph.edges[id].access === 'brt'))).toBe(true);
  });

  it('computes the general drivable set as if the busways did not exist', () => {
    const bare = buildRoadGraph({ ...mariscal, roads: mariscal.roads.filter((r) => !r.access) });
    const count = (g: typeof graph) => g.edges.filter((e) => e.drivable).length;
    // Junctions a busway meets are trimmed a bit differently, but nothing drivable is lost or swallowed.
    expect(count(graph)).toBeGreaterThanOrEqual(count(bare) - 4);
    expect(count(graph)).toBeLessThanOrEqual(count(bare) + 4);
  });

  it('lets BRT vehicles drive busways, and everything ordinary traffic drives', () => {
    const bus = graph.edges.filter((e) => e.access === 'brt' && e.center.pts.every(inPlay));
    const reach = bus.filter((e) => e.brtDrivable).length / bus.length;
    expect(reach).toBeGreaterThan(0.6);
    for (const e of graph.edges) if (e.drivable) expect(e.brtDrivable, `e${e.id} ${e.road}`).toBe(true);
    expect(edgeAllows(bus.find((e) => e.brtDrivable)!, 'brt')).toBe(true);
    expect(edgeAllows(bus[0], 'general')).toBe(false);
  });

  it('handles a bypass and a dead-end stub on a small network', () => {
    const g = buildRoadGraph(tiny());
    const by = (name: string) => g.edges.filter((e) => e.road === name);
    expect(by('West').concat(by('East')).every((e) => e.drivable && e.brtDrivable)).toBe(true);
    // The bypass joins the streets at both ends: a BRT vehicle can use it, ordinary traffic can't.
    expect(by('Bypass').length).toBeGreaterThan(0);
    expect(by('Bypass').every((e) => !e.drivable && e.brtDrivable)).toBe(true);
    // The stub goes nowhere: not part of any loop for anybody.
    expect(by('Stub').every((e) => !e.drivable && !e.brtDrivable)).toBe(true);
    // And without the busways the streets are the same.
    const bare = buildRoadGraph({ roads: tiny().roads.filter((r) => !r.access) } as CityData);
    expect(bare.edges.filter((e) => e.drivable).length).toBe(g.edges.filter((e) => e.drivable).length);
  });
});

describe('navigation by vehicle class', () => {
  it('routes ordinary vehicles around busways and BRT ones along them', () => {
    const g = buildRoadGraph(tiny());
    const edge = (road: string, west: boolean) => g.edges.find((e) => e.road === road && (Math.cos(e.heading) < 0) === west)!;
    const bypass = g.edges.find((e) => e.road === 'Bypass')!;
    const east = edge('East', true);
    const from = { edge: bypass.id, s: 10 };
    const to = { edge: east.id, s: 20 };
    // A BRT vehicle drives the bypass and comes off it onto the street.
    const brt = new Navigator(g, 'brt');
    const path = brt.route(from, to)!;
    expect(path).not.toBeNull();
    expect(path.edges.some((id) => g.edges[id].access === 'brt')).toBe(true);
    // Ordinary traffic can't be placed on a busway: `locate` only finds streets...
    const general = new Navigator(g);
    const spot = general.locate(bypass.center.pts[0], bypass.heading)!;
    expect(g.edges[spot.edge].access).toBe('general');
    // ...and a route between two streets never uses it, however much shorter it would be.
    const west = edge('West', false);
    const direct = general.route({ edge: west.id, s: 5 }, { edge: edge('East', false).id, s: 20 })!;
    expect(direct.edges.every((id) => g.edges[id].access === 'general')).toBe(true);
    // The default class is today's behavior; `generalCost` makes BRT routes shy away from streets.
    const a = { edge: west.id, s: 5 };
    const b = { edge: edge('East', false).id, s: 20 };
    expect(new Navigator(g, 'general').distanceTo(a, b)).toBe(general.distanceTo(a, b));
    expect(new Navigator(g, 'brt', 3).distanceTo(a, b)).toBeGreaterThan(new Navigator(g, 'brt').distanceTo(a, b));
  });

  it('never guides a general vehicle onto a busway on La Mariscal, and locate ignores busway lanes', () => {
    const nav = new Navigator(graph);
    const stops = mariscal.stops.filter((s) => !s.system).slice(0, 25);
    for (const a of stops.slice(0, 8))
      for (const b of stops.slice(8, 16)) {
        const from = nav.locate(stopZone(a), a.heading);
        const to = nav.locate(stopZone(b), b.heading);
        if (!from || !to) continue;
        expect(graph.edges[from.edge].access).toBe('general');
        const p = nav.route(from, to);
        if (p) for (const id of p.edges) expect(graph.edges[id].access, `${a.name} -> ${b.name}`).toBe('general');
      }
  });

  it('serves every Trolebús/Ecovía/Metrobus stop from a lane a BRT vehicle drives, in its direction', () => {
    const nav = new Navigator(graph, 'brt');
    for (const s of mariscal.stops.filter((q) => q.system)) {
      const spot = nav.locate(stopZone(s), s.heading);
      expect(spot, s.name).not.toBeNull();
      expect(graph.edges[spot!.edge].brtDrivable, s.name).toBe(true);
    }
  });
});

describe('stations beside busways', () => {
  const busStops = mariscal.stops.filter((s) => {
    if (!s.system) return false;
    const z = stopZone(s);
    return mariscal.roads.some((r) => r.access && distToPolyline(z, r.points) < r.width / 2 + 0.8);
  });

  it('puts most rapid-transit stops right beside a busway lane (a bus on it boards from the left)', () => {
    expect(busStops.length).toBeGreaterThanOrEqual(10);
    expect(busStops.filter((s) => s.side === 'left').length).toBeGreaterThanOrEqual(8);
  });

  it('serves them from a busway edge going their way', () => {
    for (const s of busStops) {
      const z = stopZone(s);
      const hit = graph.edges.some((e) => {
        if (e.access !== 'brt') return false;
        let best = { d: Infinity, i: 0 };
        e.center.pts.forEach((p, i) => {
          const d = Math.hypot(p.x - z.x, p.z - z.z);
          if (d < best.d) best = { d, i };
        });
        const dir = e.center.pts[Math.min(best.i + 1, e.center.pts.length - 1)];
        const from = e.center.pts[Math.max(best.i - 1, 0)];
        const dx = dir.x - from.x;
        const dz = dir.z - from.z;
        return best.d < 12 && dx * Math.cos(s.heading) - dz * Math.sin(s.heading) > 0;
      });
      expect(hit, s.name).toBe(true);
    }
  });

  it('leaves the platforms off every busway', () => {
    for (const st of mariscal.stations ?? []) {
      const f = { x: Math.cos(st.heading), z: -Math.sin(st.heading) };
      const r = { x: Math.sin(st.heading), z: Math.cos(st.heading) };
      for (let u = -st.length / 2; u <= st.length / 2; u += 2)
        for (const v of [-st.width / 2, 0, st.width / 2]) {
          const p = { x: st.pos.x + f.x * u + r.x * v, z: st.pos.z + f.z * u + r.z * v };
          for (const b of mariscal.roads) if (b.access) expect(distToPolyline(p, b.points), `${st.name} ${u},${v}`).toBeGreaterThan(b.width / 2);
        }
    }
  });
});

describe('traffic, lights and walkers around busways', () => {
  it('never puts an ordinary car on a busway', () => {
    const lights = new TrafficLights(graph, mariscal.signals ?? []);
    const sim = new TrafficSim(graph, mariscal, { seed: 3, count: 60, lights });
    const DT = 1 / 20;
    for (let t = 0; t < 120; t += DT) {
      sim.step(DT, []);
      for (const c of sim.cars) {
        if (c.state !== 'driving') continue;
        expect(graph.edges[c.edge].access, `car ${c.id}`).toBe('general');
        if (c.next >= 0) expect(graph.edges[c.next].access, `car ${c.id} next`).toBe('general');
      }
    }
  }, 120_000);

  it('gives a busway approach at a lit junction the phase of the avenue it runs along', () => {
    const lights = new TrafficLights(graph, mariscal.signals ?? []);
    let seen = 0;
    for (const j of lights.junctions) {
      for (const a of j.approaches) {
        if (graph.edges[a.edge].access !== 'brt') continue;
        seen++;
        // Whatever ordinary approach runs along it shares its phase.
        for (const b of j.approaches)
          if (graph.edges[b.edge].access !== 'brt' && Math.abs(a.dir.x * b.dir.x + a.dir.z * b.dir.z) > 0.9) expect(b.phase).toBe(a.phase);
        // A busway never adds a phase: the junction has as many as its ordinary approaches make.
        expect(a.phase).toBeLessThan(j.phases);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('draws no sidewalk strip along a busway', () => {
    const onlyBuses = { ...mariscal, roads: mariscal.roads.filter((r) => r.access) };
    expect(sidewalkSections(onlyBuses, buildRoadGraph(onlyBuses))).toEqual([]);
  });

  it('resets an ordinary vehicle onto a street, never a busway', () => {
    // Busways well away from any street (where a street's asphalt overlaps one, the street is a fine answer).
    const alone = mariscal.roads.filter((r) => r.access && r.points.every((q) => mariscal.roads.every((o) => o.access || distToPolyline(q, o.points) > o.width / 2 + r.width / 2 + 1)));
    expect(alone.length).toBeGreaterThan(0);
    for (const b of alone.slice(0, 12)) {
      const p = b.points[Math.floor(b.points.length / 2)];
      const pose = snapToRoad(mariscal, p, 0);
      expect(distToPolyline(pose.pos, b.points), 'reset landed on a busway').toBeGreaterThan(b.width / 2 - 0.5);
    }
  });
});
