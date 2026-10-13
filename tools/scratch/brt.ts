import { readFileSync } from 'node:fs';
import { buildRoadGraph } from '../../src/world/roadGraph';
import { routeLegs, routeStops, routesFor, startPose } from '../../src/gameplay/routes';
const city = JSON.parse(readFileSync('data/cities/mariscal.json', 'utf8'));
const g = buildRoadGraph(city);
console.log('lines', (city.lines ?? []).map((l: any) => `${l.ref}|${l.name}|${l.system}|${l.stops.length}`));
console.log('stops by system', ['trolebus', 'ecovia', 'metrobus'].map((s) => s + ':' + city.stops.filter((x: any) => x.system === s).length));
for (const r of routesFor(city, g)) {
  const legs = routeLegs(city, r, g);
  console.log(r.id, r.name, r.system, r.stops.length, r.lengthM, 'legs', legs.map((l) => Math.round(l)).join(','));
  if (r.system) {
    const sp = startPose(city, g, r);
    console.log('  start', sp.pos, sp.heading);
    console.log('  ', routeStops(city, r).map((s) => s.stop.id + ':' + s.stop.name).join(' | '));
  }
}
console.log('brt edges', g.edges.filter((e) => e.access === 'brt').length, 'brtDrivable', g.edges.filter((e) => e.brtDrivable).length, 'general', g.edges.filter((e) => e.drivable).length);
