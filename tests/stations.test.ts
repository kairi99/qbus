import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CityData, Vec2 } from '../src/world/cityData';
import { forward, right } from '../src/world/cityData';
import { distToPolyline, pointInPolygon } from '../src/world/geom';
import { buildRoadGraph } from '../src/world/roadGraph';
import { Navigator } from '../src/gameplay/navigation';
import { routesFor, routeStops } from '../src/gameplay/routes';
import { lineDisplayName } from '../src/world/osm/lines';
import { transitSystem } from '../src/world/osm/stations';

const city: CityData = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const stations = city.stations ?? [];
const onAsphalt = (p: Vec2) => city.roads.some((r) => distToPolyline(p, r.points) < r.width / 2);

describe('rapid-transit stations (La Mariscal)', () => {
  it('has the real Trolebús and Ecovía stations and Metro entrances', () => {
    const names = (sys: string) => stations.filter((s) => s.system === sys).map((s) => s.name);
    expect(names('trolebus')).toEqual(expect.arrayContaining(['El Ejido', 'Mariscal', 'Santa Clara', 'La Colón']));
    expect(names('ecovia')).toEqual(expect.arrayContaining(['Casa de la Cultura', 'Galo Plaza', 'Manuela Cañizares', 'Baca Ortiz']));
    const metro = (city.metro ?? []).map((m) => m.name);
    expect(metro).toEqual(expect.arrayContaining(['El Ejido', 'Universidad Central']));
  });

  it('puts the Ecovía station at 12 de Octubre y Veintimilla in the middle of the avenue', () => {
    const st = stations.find((s) => s.name === 'De las Universidades')!;
    expect(st, 'station').toBeDefined();
    expect(st.length).toBeGreaterThanOrEqual(20);
    // Boarded from both carriageways: asphalt on both sides of the platform.
    const r = right(st.heading);
    for (const side of [-1, 1]) {
      const p = { x: st.pos.x + r.x * side * (st.width / 2 + 2), z: st.pos.z + r.z * side * (st.width / 2 + 2) };
      expect(onAsphalt(p), `side ${side}`).toBe(true);
    }
    const stops = city.stops.filter((s) => s.system === 'ecovia' && s.name === 'De las Universidades');
    expect(stops.length).toBe(2);
    expect(stops.every((s) => s.side === 'left')).toBe(true);
  });

  it('keeps every platform off the asphalt, junctions and buildings', () => {
    for (const s of stations) {
      const f = forward(s.heading);
      const r = right(s.heading);
      for (let u = -s.length / 2; u <= s.length / 2; u += 2)
        for (const v of [-s.width / 2, 0, s.width / 2]) {
          const p = { x: s.pos.x + f.x * u + r.x * v, z: s.pos.z + f.z * u + r.z * v };
          expect(onAsphalt(p), `${s.name} at ${u},${v}`).toBe(false);
          expect(city.buildings.some((b) => pointInPolygon(p, b.footprint)), s.name).toBe(false);
        }
    }
  });

  it('keeps Metro entrances on clear ground', () => {
    for (const m of city.metro ?? []) {
      expect(onAsphalt(m.pos), m.name).toBe(false);
      expect(city.buildings.some((b) => pointInPolygon(m.pos, b.footprint)), m.name).toBe(false);
    }
  });

  it('serves median stations from the left, from a lane going the right way', () => {
    const nav = new Navigator(buildRoadGraph(city));
    const brt = city.stops.filter((s) => s.system);
    expect(brt.filter((s) => s.side === 'left').length).toBeGreaterThanOrEqual(12);
    const route = { id: 't', name: 't', blurb: '', stops: brt.map((s) => s.id), lengthM: 0 };
    for (const rs of routeStops(city, route)) {
      // The bus stops on the asphalt next to the platform, on the platform's side of the bus.
      expect(onAsphalt(rs.zone), rs.stop.name).toBe(true);
      const r = right(rs.stop.heading);
      const side = (rs.stop.pos.x - rs.zone.x) * r.x + (rs.stop.pos.z - rs.zone.z) * r.z;
      expect(side < 0, rs.stop.name).toBe(rs.stop.side === 'left');
      expect(nav.locate(rs.zone, rs.stop.heading), rs.stop.name).not.toBeNull();
    }
  });

  it('offers Trolebús and Ecovía routes that only stop at their stations', () => {
    const routes = routesFor(city);
    const byId = new Map(city.stops.map((s) => [s.id, s]));
    for (const sys of ['trolebus', 'ecovia'] as const) {
      const r = routes.find((x) => x.system === sys);
      expect(r, sys).toBeDefined();
      expect(r!.stops.length).toBeGreaterThanOrEqual(6);
      for (const id of r!.stops) expect(byId.get(id)!.system).toBe(sys);
      // Out and back: both directions of the avenue.
      const headings = r!.stops.map((id) => byId.get(id)!.heading);
      expect(headings.some((h) => Math.cos(h - headings[0]) < -0.5)).toBe(true);
    }
    for (const r of routes.filter((x) => !x.system)) for (const id of r.stops) expect(byId.get(id)!.system, r.name).toBeUndefined();
  });
});

describe('transit systems', () => {
  it('tells Trolebús, Ecovía and Metrobus from ordinary lines', () => {
    expect(transitSystem({ name: 'Trolebus C1 El Recreo => El Labrador', ref: 'C1', route: 'trolleybus' })).toBe('trolebus');
    expect(transitSystem({ name: 'Ecovía E3 Río Coca - Playón de la Marín', ref: 'E3', route: 'bus' })).toBe('ecovia');
    expect(transitSystem({ name: 'MetroBus Ofelia - Marín', ref: 'Metrobus-Q', route: 'bus' })).toBe('metrobus');
    expect(transitSystem({ name: 'Catar 061', ref: 'CATAR-061', route: 'bus' })).toBeNull();
  });

  it('names lines by system', () => {
    expect(lineDisplayName({ ref: 'E3', system: 'ecovia' })).toBe('Ecovía E3');
    expect(lineDisplayName({ ref: 'Metrobus-Q', system: 'metrobus', name: 'MetroBus Ofelia - Marín' })).toBe('Metrobus Ofelia – Marín');
  });
});
